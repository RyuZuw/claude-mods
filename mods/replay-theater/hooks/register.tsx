import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Line } from '../types'

const PANE = 'replay-theater'
const CATS = ['Studio', 'Blender', 'Vault', 'Scripts', 'Other']
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const MAX_CHANGES = 300
const MAX_LINES = 120
const MAX_LCS = 400
const WIDE = 72 // body columns from which the step list sits beside the diff
const GAP = ' ' // one space between the pieces of a row
// MCP tools that only look; everything else on an MCP server counts as a change.
const READ_ONLY =
  /__(get_|list_|search_|inspect_|script_(read|grep|search)|screen_capture|http_get|wait_job_finished|jump_to_|render_)/
const HIDE_KEYS = new Set(['studio_id', 'datamodel_type', 'tool', 'tool_use_id', 'agentId', 'requestMeta'])

// Change the tag when a Change's fields change: it declines what an earlier
// version stored, which outlives a reload.
const changes = atom({ plugin: 'replay-theater', key: 'changes' } as const, [], { shape: 'changes-1' })
const off = atom({ plugin: 'replay-theater', key: 'off' } as const, [])
// The step on show, by id; '' follows the newest.
const sel = atom({ plugin: 'replay-theater', key: 'sel' } as const, '')
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
function diff(oldText: unknown, newText: unknown): Line[] {
  const a = split(oldText)
  const b = split(newText)
  if (a.length > MAX_LCS || b.length > MAX_LCS) {
    return [...a.map(t => ({ op: '-', t })), ...b.map(t => ({ op: '+', t }))]
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
      all.push({ op: ' ', t: a[i]! })
      i++
      j++
    } else if (at2(i + 1, j) >= at2(i, j + 1)) all.push({ op: '-', t: a[i++]! })
    else all.push({ op: '+', t: b[j++]! })
  }
  while (i < n) all.push({ op: '-', t: a[i++]! })
  while (j < m) all.push({ op: '+', t: b[j++]! })
  // Keep one line of context around each change, so a Write over a long file
  // shows the changed lines, not the whole file.
  const changed = (k: number) => !!all[k] && all[k].op !== ' '
  const out: Line[] = []
  let gap = false
  all.forEach((l, k) => {
    if (changed(k) || changed(k - 1) || changed(k + 1)) {
      if (gap && out.length) out.push({ op: '~', t: '⋯' })
      out.push(l)
      gap = false
    } else gap = true
  })
  return out
}

function joinEdits(edits: unknown): Line[] {
  const out: Line[] = []
  for (const ed of Array.isArray(edits) ? edits : []) {
    if (out.length) out.push({ op: '~', t: '⋯' })
    out.push(...diff(ed?.old_string, ed?.new_string))
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
  const kept = lines.slice(0, MAX_LINES).map(l => ({ op: l.op, t: l.t.slice(0, 300) }))
  if (lines.length > MAX_LINES) kept.push({ op: '~', t: `… ${lines.length - MAX_LINES} more lines` })
  return kept
}

// Turns one finished tool call into a Change, or null when it is not one.
async function toChange($: any, e: any, before: string, ran: any): Promise<Change | null> {
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
      lines = diff(e.old_string, e.new_string)
      if (e.replace_all) note.push('replace all')
    } else if (e.tool === 'MultiEdit') lines = joinEdits(e.edits)
    else {
      lines = diff(before, e.content)
      note.push(before ? 'rewrite' : 'new file')
    }
    return { id: e.tool_use_id, cat: category(e.tool, file), tool: e.tool, file, note: note.join(' · '), lines: cap(lines) }
  }

  if (!String(e.tool).startsWith('mcp__') || ran.isReadOnly || READ_ONLY.test(e.tool)) return null
  const short = String(e.tool).split('__').pop() ?? e.tool
  const cat = category(e.tool, '')

  // A Studio script edit has real old/new text: show it as a diff.
  if (e.tool.endsWith('__multi_edit') && Array.isArray(e.edits)) {
    if (ran.isError) return null
    if (e.className) note.push('new script')
    return { id: e.tool_use_id, cat, tool: short, file: String(e.file_path ?? ''), note: note.join(' · '), lines: cap(joinEdits(e.edits)) }
  }

  if (ran.isError) note.push('failed')
  return { id: e.tool_use_id, cat, tool: short, file: short, note: note.join(' · '), lines: cap(preview(e, ran.text)) }
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
  const shown = all.filter(c => !hidden.includes(c.cat))
  const total = shown.length
  const order = [...shown].reverse() // newest first
  const found = order.findIndex(c => c.id === want)
  const k = found < 0 ? 0 : found // not found (or '') follows the newest
  const live = found < 0
  const n = counts(all)
  const isWide = (e.props.bodyColumns ?? 60) >= WIDE
  const toggleCat = (c: string) => update($, off, l => (l.includes(c) ? l.filter(x => x !== c) : [...l, c]))
  const sums = shown.reduce((a, c) => ({ add: a.add + tally(c).add, del: a.del + tally(c).del }), { add: 0, del: 0 })

  const header = (
    <Box flexDirection="row" flexWrap="wrap" gap={2}>
      <Text bold>{plural(all.length)}</Text>
      <Text color="success">{`+${sums.add}`}</Text>
      <Text color="error">{`-${sums.del}`}</Text>
      {total > 0 && <Text dimColor>{`step ${total - k} of ${total}${live ? ' · live' : ''}`}</Text>}
      {isPaused && <Text color="warning">⏸ paused</Text>}
    </Box>
  )

  const chips = (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {CATS.filter(c => n[c]).map(c => (
        <Button key={c} label={`${hidden.includes(c) ? '○' : '●'} ${c} ${n[c]}`} onPress={() => toggleCat(c)} />
      ))}
      <Button key="pause" label={isPaused ? '▶ Resume' : '⏸ Pause'} onPress={() => update($, paused, v => !v)} />
    </Box>
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
  const dir = slash > 0 ? step.file.slice(0, slash) : ''
  const name = slash >= 0 ? step.file.slice(slash + 1) : step.file

  // A window of the list around the current step: tall beside the diff, short above it.
  const size = isWide ? 12 : 6
  const from = Math.max(0, Math.min(k - Math.floor(size / 2), total - size))
  const to = Math.min(total, from + size)
  const list = (
    <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} {...(isWide ? { width: 34 } : {})}>
      {order.slice(from, to).map((c, j) => {
        const idx = from + j
        const t = tally(c)
        const on = idx === k

        return (
          <Button key={c.id} plain onPress={() => update($, sel, () => (idx === 0 ? '' : c.id))}>
            <Text color={TINT[c.cat]}>{on ? '▸' : '●'}</Text>
            {GAP}
            <Text dimColor>{String(total - idx).padStart(2)}</Text>
            {GAP}
            <Text bold={on} inverse={on} wrap="truncate-end">
              {c.file.split('/').pop() ?? c.file}
            </Text>
            {GAP}
            <Text color="success">{`+${t.add}`}</Text>
            {GAP}
            <Text color="error">{`-${t.del}`}</Text>
          </Button>
        )
      })}
      {total > size && <Text dimColor>{`${from > 0 ? '▲ newer' : ''}${from > 0 && to < total ? ' · ' : ''}${to < total ? '▼ older' : ''}`}</Text>}
    </Box>
  )

  const detail = (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="inactive" paddingX={1}>
      {dir && (
        <Text dimColor wrap="truncate-start">
          {dir}
        </Text>
      )}
      <Text bold wrap="truncate-start">
        {name}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        <Text color={TINT[step.cat]}>{step.cat}</Text>
        <Text dimColor>{`${step.tool}${step.note ? ` · ${step.note}` : ''}`}</Text>
        <Text color="success">{`+${add}`}</Text>
        <Text color="error">{`-${del}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {step.lines.map(l => (
          <Box backgroundColor={l.op === '+' ? 'diffAdded' : l.op === '-' ? 'diffRemoved' : undefined}>
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
    <Box flexDirection="column" gap={1}>
      {header}
      {chips}
      {isWide ? (
        <Box flexDirection="row" gap={1}>
          {list}
          {detail}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {list}
          {detail}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        <Button key="newer" label="▲ Newer" hotkey="n" onPress={() => update($, sel, () => (k <= 1 ? '' : order[k - 1]!.id))} />
        <Button key="older" label="▼ Older" hotkey="o" autoFocus onPress={() => update($, sel, () => order[Math.min(total - 1, k + 1)]!.id)} />
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
    if (e.tool === 'Write') {
      try {
        const path = String(e.file_path)
        if (await $.fs.exists(path)) before = await $.fs.read(path)
      } catch {
        /* unreadable: shown as a new file */
      }
    }
    const ran = await next(e)
    try {
      const change = await toChange($, e, before, ran)
      if (change) {
        await update($, changes, list => [...list, change].slice(-MAX_CHANGES))
        await openOnce($)
      }
    } catch {
      /* recording must never stop the call */
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, panel)
  on('ui.render', { component: 'ToolUse' }, jump)
}
