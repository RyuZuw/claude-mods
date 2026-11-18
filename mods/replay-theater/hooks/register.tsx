import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Line } from '../types'

const PANE = 'replay-theater'
const CATS = ['Studio', 'Blender', 'Vault', 'Scripts', 'Other']
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const MAX_CHANGES = 300
const MAX_LINES = 120
const MAX_LCS = 400
const CTX = 3 // unchanged lines shown each side of a change
const MAX_FILE = 1_000_000 // bigger files are shown without context
const WIDE = 72 // body columns from which the step list sits beside the diff
const GAP = ' ' // one space between the pieces of a row
// MCP tools that only look; everything else on an MCP server counts as a change.
const READ_ONLY =
  /__(get_|list_|search_|inspect_|script_(read|grep|search)|screen_capture|http_get|wait_job_finished|jump_to_|render_)/
const HIDE_KEYS = new Set(['studio_id', 'datamodel_type', 'tool', 'tool_use_id', 'agentId', 'requestMeta'])

// Change the tag when a Change's fields change: it declines what an earlier
// version stored, which outlives a reload.
const changes = atom({ plugin: 'replay-theater', key: 'changes' } as const, [], { shape: 'changes-3' })
// What you typed at each turn, oldest first; a change keeps the index of its turn.
const prompts = atom({ plugin: 'replay-theater', key: 'prompts' } as const, [])
const off = atom({ plugin: 'replay-theater', key: 'off' } as const, [])
// The step on show, by id; '' follows the newest.
const sel = atom({ plugin: 'replay-theater', key: 'sel' } as const, '')
// Prompt groups folded shut in the list, by turn; whether the 3 context lines show; a Clear waiting for a yes.
const folded = atom({ plugin: 'replay-theater', key: 'folded' } as const, [])
const context = atom({ plugin: 'replay-theater', key: 'context' } as const, true)
const confirmClear = atom({ plugin: 'replay-theater', key: 'confirmClear' } as const, false)
const paused = atom({ plugin: 'replay-theater', key: 'paused' } as const, false)
// The panel opens by itself once, at the first change; after that only /replay or Close decide.
const autoOpened = atom({ plugin: 'replay-theater', key: 'autoOpened' } as const, false)

const norm = (p: string) => p.replace(/\\/g, '/')

// Windows-safe: backslashes and drive-letter case do not break the cut.
function rel(cwd: string, path: string) {
  const f = norm(path)
  const c = norm(cwd).replace(/\/$/, '') + '/'
  return cwd && f.toLowerCase().startsWith(c.toLowerCase()) ? f.slice(c.length) : f
}

function category(tool: string, file: string) {
  if (tool.startsWith('mcp__Roblox_Studio__')) return 'Studio'
  if (tool.startsWith('mcp__Blender__')) return 'Blender'
  if (/\.md$/i.test(file)) return 'Vault'
  if (/\.(py|luau?|tsx?)$/i.test(file)) return 'Scripts'
  return 'Other'
}

function split(text: unknown): string[] {
  const s = typeof text === 'string' ? text : ''
  if (!s) return []
  const lines = s.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Small inputs get an LCS diff; large ones fall back to all-removed then all-added.
// With `start` (the number of the first line), every line carries its line number:
// the old file's for removed lines, the new file's for the rest.
function diff(oldText: unknown, newText: unknown, start = 0): Line[] {
  const a = split(oldText)
  const b = split(newText)
  const num = (n: number) => (start > 0 ? { n: start + n } : {})
  if (a.length > MAX_LCS || b.length > MAX_LCS) {
    return [...a.map((t, k) => ({ op: '-', t, ...num(k) })), ...b.map((t, k) => ({ op: '+', t, ...num(k) }))]
  }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const at2 = (x: number, y: number) => dp[x]?.[y] ?? 0
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? at2(i + 1, j + 1) + 1 : Math.max(at2(i + 1, j), at2(i, j + 1))
  const all: Line[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ op: ' ', t: a[i]!, ...num(j) })
      i++
      j++
    } else if (at2(i + 1, j) >= at2(i, j + 1)) all.push({ op: '-', t: a[i]!, ...num(i++) })
    else all.push({ op: '+', t: b[j]!, ...num(j++) })
  }
  while (i < n) all.push({ op: '-', t: a[i]!, ...num(i++) })
  while (j < m) all.push({ op: '+', t: b[j]!, ...num(j++) })
  // Keep CTX lines of context around each change, so a Write over a long file
  // shows the changed lines, not the whole file.
  const near = (k: number) => {
    for (let d = -CTX; d <= CTX; d++) if (all[k + d] && all[k + d]!.op !== ' ') return true
    return false
  }
  const out: Line[] = []
  let gap = false
  all.forEach((l, k) => {
    if (near(k)) {
      if (gap && out.length) out.push({ op: '~', t: '⋯' })
      out.push(l)
      gap = false
    } else gap = true
  })
  return out
}

// One edit in a file we read first: the changed lines with CTX lines of the file around
// them and real line numbers. null (the caller shows the plain old/new text) when the
// text is not found exactly once, the file has CRLF line ends, or it is replace-all.
function editHunk(before: string, oldS: string, newS: string, replaceAll: boolean): Line[] | null {
  if (!before || replaceAll || typeof oldS !== 'string' || !oldS || before.includes('\r')) return null
  const at = before.indexOf(oldS)
  if (at < 0 || before.indexOf(oldS, at + 1) >= 0) return null
  const lines = before.split('\n')
  const count = (x: string) => x.split('\n').length - 1
  const first = count(before.slice(0, at))
  const last = first + count(oldS)
  const lo = Math.max(0, first - CTX)
  const hi = Math.min(lines.length - 1, last + CTX)
  const added = String(newS ?? '')
  const after = (before.slice(0, at) + added + before.slice(at + oldS.length)).split('\n')
  const delta = count(added) - count(oldS)

  return diff(lines.slice(lo, hi + 1).join('\n'), after.slice(lo, hi + 1 + delta).join('\n'), lo + 1)
}

function joinEdits(edits: unknown): Line[] {
  const out: Line[] = []
  for (const ed of Array.isArray(edits) ? edits : []) {
    if (out.length) out.push({ op: '~', t: '⋯' })
    out.push(...diff(ed?.old_string, ed?.new_string))
  }
  return out
}

// A MultiEdit on a file we read: each edit against the text the one before it left.
function multiHunks(before: string, edits: unknown): Line[] {
  const out: Line[] = []
  let text = before
  for (const ed of Array.isArray(edits) ? edits : []) {
    const hunk = editHunk(text, ed?.old_string, ed?.new_string, !!ed?.replace_all)
    if (out.length) out.push({ op: '~', t: '⋯' })
    out.push(...(hunk ?? diff(ed?.old_string, ed?.new_string)))
    if (typeof ed?.old_string === 'string' && text.includes(ed.old_string)) text = text.replace(ed.old_string, () => String(ed.new_string ?? ''))
  }
  return out
}

// What a call looked like: its code (Luau, Python) or its arguments, then what came back.
function preview(args: Record<string, unknown>, text: unknown): Line[] {
  const out: Line[] =
    typeof args.code === 'string'
      ? split(args.code).map(t => ({ op: ' ', t }))
      : Object.entries(args)
          .filter(([k]) => !HIDE_KEYS.has(k))
          .map(([k, v]) => ({ op: ' ', t: `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}` }))
  for (const t of split(text).slice(0, 5)) out.push({ op: '>', t })
  return out
}

function cap(lines: Line[]): Line[] {
  const kept = lines.slice(0, MAX_LINES).map(l => ({ ...l, t: l.t.slice(0, 300) }))
  if (lines.length > MAX_LINES) kept.push({ op: '~', t: `… ${lines.length - MAX_LINES} more lines` })
  return kept
}

// Turns one finished tool call into a Change, or null when it is not one.
async function toChange($: any, e: any, before: string, ran: any, turn: number): Promise<Change | null> {
  if (ran.deny !== undefined) return null
  const note = [e.agentId ? 'subagent' : ''].filter(Boolean)
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    /* keep the full path */
  }

  if (FILE_TOOLS.has(e.tool)) {
    if (ran.isError) return null
    const file = rel(cwd, String(e.file_path ?? ''))
    let lines: Line[]
    if (e.tool === 'Edit') {
      lines = editHunk(before, e.old_string, e.new_string, !!e.replace_all) ?? diff(e.old_string, e.new_string)
      if (e.replace_all) note.push('replace all')
    } else if (e.tool === 'MultiEdit') lines = before ? multiHunks(before, e.edits) : joinEdits(e.edits)
    else {
      lines = diff(before, e.content, 1)
      note.push(before ? 'rewrite' : 'new file')
    }
    return { id: e.tool_use_id, cat: category(e.tool, file), tool: e.tool, file, note: note.join(' · '), turn, at: Date.now(), lines: cap(lines) }
  }

  if (!String(e.tool).startsWith('mcp__') || ran.isReadOnly || READ_ONLY.test(e.tool)) return null
  const short = String(e.tool).split('__').pop() ?? e.tool
  const cat = category(e.tool, '')

  // A Studio script edit has real old/new text: show it as a diff.
  if (e.tool.endsWith('__multi_edit') && Array.isArray(e.edits)) {
    if (ran.isError) return null
    if (e.className) note.push('new script')
    return { id: e.tool_use_id, cat, tool: short, file: String(e.file_path ?? ''), note: note.join(' · '), turn, at: Date.now(), lines: cap(joinEdits(e.edits)) }
  }

  if (ran.isError) note.push('failed')
  return { id: e.tool_use_id, cat, tool: short, file: short, note: note.join(' · '), turn, at: Date.now(), lines: cap(preview(e, ran.text)) }
}

function counts(list: Change[]) {
  const n: Record<string, number> = {}
  for (const c of list) n[c.cat] = (n[c.cat] ?? 0) + 1
  return n
}

const plural = (n: number) => `${n} change${n === 1 ? '' : 's'}`

// Opens the panel, or closes it if it is already open. Answers in words, including
// why a surface that places no panes (a phone, maybe) draws nothing.
async function toggle($: any): Promise<string> {
  if ((await $.ui.panes()).some((p: { id: string }) => p.id === PANE)) {
    await $.ui.close({ id: PANE })

    return 'closed'
  }
  await update($, sel, () => '')
  const r = await $.ui.open({ id: PANE, title: 'Replay Theater', focus: true as const, closeOnEscape: true as const })
  if (!r.isPlaced) return `opened, but this screen did not draw it (${r.reason}). Run /replay again to close it`

  return 'opened'
}

// Opens the docked panel once per session (unfocused), at start or at the first change.
async function openOnce($: any) {
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  if (!(await $.ui.panes()).some((p: { id: string }) => p.id === PANE)) await $.ui.open({ id: PANE, title: 'Replay Theater' })
}

// Category colours, from the theme so light and dark both work; the label is always
// written too, so colour never carries it alone.
const TINT: Record<string, string> = { Studio: 'suggestion', Blender: 'warning', Vault: 'remember', Scripts: 'permission', Other: 'inactive' }

const tally = (c: Change) => ({ add: c.lines.filter(l => l.op === '+').length, del: c.lines.filter(l => l.op === '-').length })

// Opens the panel on one step (from the button under a tool call in the chat).
async function reveal($: any, id: string) {
  await update($, sel, () => id)
  await $.ui.open({ id: PANE, title: 'Replay Theater', focus: true as const, closeOnEscape: true as const })
}

// "14:05" from a millisecond time, in the machine's own zone.
const clock = (ms: number) => {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A folder path as short as is still useful: random ids (a temp folder's) are dropped
// and only the last two folders stay.
const looksLikeId = (seg: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^[0-9a-f]{12,}$/i.test(seg)
function tidyDir(dir: string): string {
  const parts = dir ? dir.split('/') : []
  const kept = parts.filter(p => !looksLikeId(p))

  return kept.length > 2 || kept.length < parts.length ? `…/${kept.slice(-2).join('/')}` : kept.join('/')
}

// The first line of a step that really changed, when the file's line numbers are known.
function firstChanged(c: Change): number {
  if (/new file|rewrite/.test(c.note)) return 0

  return c.lines.find(l => l.n && l.op !== ' ' && l.op !== '~')?.n ?? 0
}

// The first real words of a prompt: paste wrappers and other tags are dropped.
function askLine(text: string): string {
  const line = text
    .replace(/<[^>\n]*>/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)
  if (line) return line.slice(0, 80)

  return /<pasted_content/.test(text) ? '(pasted text)' : '(attachment)'
}

// A tool call that was recorded gets a small button under its row that opens its step.
async function jump($: any, e: any, next: any) {
  const row = await next(e)
  if (e.props.isRunning) return row
  const id = e.props.tool_use_id
  if (!(await read($, changes)).some(c => c.id === id)) return row
  const { Box, Button } = $.ui.resolve(e)

  return (
    <Box flexDirection="column">
      {row}
      <Button key="replay" label="↗ Replay" onPress={() => reveal($, id)} />
    </Box>
  )
}

// The panel, newest step on top. Wide, the step list sits beside the diff; narrow, it
// stacks above it. The body scrolls by itself (arrow keys when focused).
async function panel($: any, e: any) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const all = await read($, changes)
  const hidden = await read($, off)
  const isPaused = await read($, paused)
  const want = await read($, sel)
  const shut = await read($, folded)
  const withContext = await read($, context)
  const asking = await read($, confirmClear)
  const shown = all.filter(c => !hidden.includes(c.cat))
  const total = shown.length
  const order = [...shown].reverse() // newest first
  const found = order.findIndex(c => c.id === want)
  const k = found < 0 ? 0 : found // not found (or '') follows the newest
  const live = found < 0
  const n = counts(all)
  const isWide = (e.props.bodyColumns ?? 60) >= WIDE
  const toggleCat = (c: string) => update($, off, l => (l.includes(c) ? l.filter(x => x !== c) : [...l, c]))
  const clearAll = async () => {
    await update($, changes, () => [])
    await update($, sel, () => '')
    await update($, folded, () => [])
    await update($, confirmClear, () => false)
  }
  const sums = shown.reduce((a, c) => ({ add: a.add + tally(c).add, del: a.del + tally(c).del }), { add: 0, del: 0 })

  const header = (
    <Box flexDirection="row" flexWrap="wrap" gap={2}>
      <Text bold>{plural(all.length)}</Text>
      {total !== all.length && <Text dimColor>{`${total} shown`}</Text>}
      <Text color="success">{`+${sums.add}`}</Text>
      <Text color="error">{`-${sums.del}`}</Text>
      {isPaused && <Text color="warning">⏸ paused</Text>}
    </Box>
  )

  const chips = (
    <Box flexDirection="row" flexWrap="wrap" gap={2}>
      {CATS.filter(c => n[c]).map(c => (
        <Button key={c} plain onPress={() => toggleCat(c)}>
          <Text color={hidden.includes(c) ? undefined : TINT[c]} dimColor={hidden.includes(c)}>{`${hidden.includes(c) ? '○' : '●'} ${c} ${n[c]}`}</Text>
        </Button>
      ))}
      <Button key="pause" plain onPress={() => update($, paused, v => !v)}>
        <Text dimColor>{isPaused ? '▶ Resume' : '⏸ Pause'}</Text>
      </Button>
    </Box>
  )

  // Longer than any panel, clipped to its width: a rule sized to bodyColumns wrapped.
  const rule = (
    <Text dimColor wrap="clip">
      {'─'.repeat(200)}
    </Text>
  )

  if (!total) {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {chips}
        <Text dimColor>{all.length ? 'Everything is hidden. Pick a category above.' : 'No changes yet this session. Edits Claude makes appear here.'}</Text>
      </Box>
    )
  }

  const step = order[k]!
  const { add, del } = tally(step)
  const slash = step.file.lastIndexOf('/')
  const dir = slash > 0 ? tidyDir(step.file.slice(0, slash)) : ''
  const name = slash >= 0 ? step.file.slice(slash + 1) : step.file
  // Width of the line-number gutter; 0 when this step has no numbers (a Studio call, say).
  // Context off: only the changed lines of a file step (a Studio call's lines have no numbers and stay).
  const lines = withContext || !step.lines.some(l => l.n) ? step.lines : step.lines.filter(l => l.op !== ' ' && l.op !== '~')
  const digits = Math.max(0, ...lines.map(l => (l.n ? String(l.n).length : 0)))

  // The list groups the steps under what you asked, newest first. A window of its rows
  // around the current step: tall beside the diff, short above it.
  const asks = await read($, prompts)
  const perTurn = new Map<number, number>()
  for (const c of order) perTurn.set(c.turn, (perTurn.get(c.turn) ?? 0) + 1)
  const rows: ({ head: string; size: number; turn: number } | { idx: number })[] = []
  order.forEach((c, idx) => {
    if (idx === 0 || c.turn !== order[idx - 1]!.turn)
      rows.push({ head: c.turn >= 0 ? (asks[c.turn] ?? '') : 'before Replay Theater started', size: perTurn.get(c.turn) ?? 0, turn: c.turn })
    if (!shut.includes(c.turn) || idx === k) rows.push({ idx }) // a folded group still shows the step on show
  })
  const here = rows.findIndex(r => 'idx' in r && r.idx === k)
  const size = isWide ? 14 : 8
  let from = Math.max(0, Math.min(here - Math.floor(size / 2), rows.length - size))
  if (from > 0 && 'idx' in rows[from]! && 'head' in rows[from - 1]!) from -= 1 // keep a group's heading with its first row
  const to = Math.min(rows.length, from + size)
  const list = (
    <Box flexDirection="column" {...(isWide ? { width: 36 } : {})}>
      {rows.slice(from, to).map(r => {
        if ('head' in r) {
          const isShut = shut.includes(r.turn)

          return (
            <Button key={`h${r.turn}`} plain onPress={() => update($, folded, l => (l.includes(r.turn) ? l.filter(x => x !== r.turn) : [...l, r.turn]))}>
              <Text bold dimColor wrap="truncate-end">
                {`${isShut ? '▸' : '▾'} ${r.head ? `“${r.head}”` : '(no prompt)'}${r.size > 1 ? ` · ${r.size} changes` : ''}`}
              </Text>
            </Button>
          )
        }
        const c = order[r.idx]!
        const t = tally(c)
        const on = r.idx === k

        return (
          <Button key={c.id} plain onPress={() => update($, sel, () => (r.idx === 0 ? '' : c.id))}>
            <Text color={TINT[c.cat]}>{on ? '▸' : '●'}</Text>
            {GAP}
            <Text dimColor>{String(total - r.idx).padStart(2)}</Text>
            {GAP}
            <Text bold={on} dimColor={!on} wrap="truncate-end">
              {`${c.file.split('/').pop() ?? c.file}${firstChanged(c) ? `:${firstChanged(c)}` : ''}`}
            </Text>
            {c.note.includes('failed') && <Text color="warning"> ✗</Text>}
            {GAP}
            <Text color="success">{`+${t.add}`}</Text>
            {GAP}
            <Text color="error">{`-${t.del}`}</Text>
          </Button>
        )
      })}
      {rows.length > size && <Text dimColor>{`${from > 0 ? '▲ newer' : ''}${from > 0 && to < rows.length ? ' · ' : ''}${to < rows.length ? '▼ older' : ''}`}</Text>}
    </Box>
  )

  const detail = (
    <Box flexDirection="column" flexGrow={1}>
      {dir && (
        <Text dimColor wrap="truncate-start">
          {dir}
        </Text>
      )}
      <Text bold wrap="truncate-start">
        {name}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text color={TINT[step.cat]}>{step.cat}</Text>
        <Text dimColor>{`· ${step.tool}${step.note ? ` · ${step.note}` : ''}`}</Text>
        <Text color="success">{`+${add}`}</Text>
        <Text color="error">{`-${del}`}</Text>
      </Box>
      <Text dimColor>{`step ${total - k} of ${total}${live ? ' · live' : ''}${step.at ? ` · ${clock(step.at)}` : ''}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map(l => (
          <Box backgroundColor={l.op === '+' ? 'diffAddedDimmed' : l.op === '-' ? 'diffRemovedDimmed' : undefined}>
            {digits > 0 && (
              <Box width={digits + 1}>
                <Text dimColor>{l.n ? String(l.n).padStart(digits) : ''}</Text>
              </Box>
            )}
            <Text dimColor={l.op === ' ' || l.op === '~' || l.op === '>'} wrap="wrap">
              {`${l.op === '~' ? ' ' : l.op} ${l.t}`}
            </Text>
          </Box>
        ))}
        {!step.lines.length && <Text dimColor>(no line changes)</Text>}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column">
      {header}
      {chips}
      {rule}
      {isWide ? (
        <Box flexDirection="row" gap={2}>
          {list}
          {detail}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {list}
          {rule}
          {detail}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" gap={3} marginTop={1}>
        <Button key="newer" plain hotkey="n" label="▲ Newer" onPress={() => update($, sel, () => (k <= 1 ? '' : order[k - 1]!.id))} />
        <Button key="older" plain hotkey="o" label="▼ Older" autoFocus onPress={() => update($, sel, () => order[Math.min(total - 1, k + 1)]!.id)} />
        {!live && <Button key="live" plain hotkey="l" label="⏭ Latest" onPress={() => update($, sel, () => '')} />}
        <Button key="ctx" plain hotkey="c" label={withContext ? 'Context: on' : 'Context: off'} onPress={() => update($, context, v => !v)} />
        {!asking && <Button key="clear" plain hotkey="x" label="✕ Clear" onPress={() => update($, confirmClear, () => true)} />}
        {asking && <Text color="warning">{`Clear all ${all.length}?`}</Text>}
        {asking && <Button key="yes" plain label="Yes, clear" onPress={clearAll} />}
        {asking && <Button key="no" plain label="No" onPress={() => update($, confirmClear, () => false)} />}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'replay',
      description: 'Replay Theater: open or close the panel of changes Claude made',
    })
    await openOnce($)

    return next(e)
  })

  // /replay opens or closes the panel.
  on('command.run', { command: 'replay' }, async $ => ({ text: `Replay Theater: ${await toggle($)}.` }))

  // `tool.run` fires only for calls that were allowed, so a denied edit never
  // lands here. Recording never blocks or changes the call.
  on('tool.run', async ($, e, next) => {
    if (await read($, paused)) return next(e)
    let before = ''
    if (FILE_TOOLS.has(e.tool)) {
      try {
        const path = String((e as { file_path?: unknown }).file_path)
        if (await $.fs.exists(path)) before = await $.fs.read(path)
        if (before.length > MAX_FILE) before = '' // too big: the change is shown without context
      } catch {
        /* unreadable: a Write shows as a new file, an edit without context */
      }
    }
    const ran = await next(e)
    try {
      const change = await toChange($, e, before, ran, (await read($, prompts)).length - 1)
      if (change) {
        await update($, changes, list => [...list, change].slice(-MAX_CHANGES))
        await openOnce($)
      }
    } catch {
      /* recording must never stop the call */
    }

    return ran
  })

  // What you asked, so the list can group the changes under it. Slash commands and
  // prompts the engine sends itself are not asks.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta && e.text.trim()) {
      await update($, prompts, l => [...l, askLine(e.text)].slice(-200))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, panel)
  on('ui.render', { component: 'ToolUse' }, jump)
}
