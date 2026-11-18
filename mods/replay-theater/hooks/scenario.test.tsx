import { expect, test } from 'claude-code/testing'

// A mock session: Claude edits notes and scripts, changes Roblox Studio and Blender,
// and also only looks at things. The panel must show the changes, newest first.

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  props: { title: 'Replay Theater', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const TOOL_ROW = {
  plugin: 'replay-theater',
  component: 'ToolUse',
  requestId: 'u2',
  props: { tool_use_id: 'u2', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
} as const

async function mockSession($: any, on: any) {
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\game' }))
  on('tool.run', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Stands for the engine's own row under the mod's button.
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>tool row</Text>
  })
  await $.session.start({ cwd: 'C:\\game', surface: 'desktop', isInteractive: true })

  const call = (tool: string, id: string, args: object) => $.tool.call({ tool, tool_use_id: id, ...args })
  await call('Edit', 'u1', { file_path: 'C:\\game\\Notes\\Now.md', old_string: 'old line', new_string: 'new line' })
  await call('Edit', 'u2', { file_path: 'C:\\game\\tools\\build.py', old_string: 'x = 1\ny = 2', new_string: 'x = 1\ny = 3\nz = 4' })
  await call('mcp__Roblox_Studio__multi_edit', 'u3', {
    file_path: 'game.ServerScriptService.Shop',
    edits: [{ old_string: 'price = 10', new_string: 'price = 25' }],
    studio_id: 's',
    datamodel_type: 'Edit',
  })
  await call('mcp__Roblox_Studio__execute_luau', 'u4', { code: 'workspace.Baseplate.Color = Color3.new(1,0,0)', studio_id: 's', datamodel_type: 'Edit' })
  await call('mcp__Blender__execute_blender_code', 'u5', { code: 'bpy.ops.mesh.primitive_cube_add()' })
  // Only looking: none of these may appear.
  await call('mcp__Roblox_Studio__script_read', 'r1', { target_file: 'game.ServerScriptService.Shop', studio_id: 's' })
  await call('mcp__Blender__get_objects_summary', 'r2', {})
  await call('mcp__Roblox_Studio__screen_capture', 'r3', { studio_id: 's' })
}

const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('mock session: five changes, the reads are left out, newest on show', async ($, on) => {
  await mockSession($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /changes?$/)).toBe('5 changes')
  expect(await text(ui, /step \d+ of/)).toBe('step 5 of 5 · live')
  // The newest step is the Blender call.
  expect(await text(ui, /^execute_blender_code$/)).toBe('execute_blender_code')
  await ui.unmount()
})

test('mock session: older, newer and a click on a step', async ($, on) => {
  await mockSession($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ plugin: 'replay-theater', key: 'older' })
  expect(await text(ui, /step \d+ of/)).toBe('step 4 of 5')
  await ui.press({ plugin: 'replay-theater', key: 'u2' }) // click step 2 in the list
  expect(await text(ui, /step \d+ of/)).toBe('step 2 of 5')
  expect(await text(ui, /^build\.py$/)).toBe('build.py')
  expect(await text(ui, /^tools$/)).toBe('tools')
  // Newer from step 2 goes to step 3; the newest step follows live again.
  await ui.press({ plugin: 'replay-theater', key: 'newer' })
  expect(await text(ui, /step \d+ of/)).toBe('step 3 of 5')
  await ui.unmount()
})

test('mock session: a category toggle hides its steps and counts', async ($, on) => {
  await mockSession($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ plugin: 'replay-theater', key: 'Studio' }) // hide the two Studio steps
  expect(await text(ui, /step \d+ of/)).toBe('step 3 of 3 · live')
  expect((await ui.find({ type: 'Button', text: /○ Studio 2/ }))).toBeDefined()
  await ui.press({ plugin: 'replay-theater', key: 'Studio' }) // and show them again
  expect(await text(ui, /step \d+ of/)).toBe('step 5 of 5 · live')
  await ui.unmount()
})

test('mock session: the button under a tool call opens the panel on that step', async ($, on) => {
  await mockSession($, on)
  const row = await $.ui.mount({ ...TOOL_ROW, surface: 'desktop' } as never)
  await row.press({ plugin: 'replay-theater', key: 'replay' })
  await row.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /step \d+ of/)).toBe('step 2 of 5') // not live: it stays on u2
  await ui.unmount()
})

test('mock session: a tool call that was not recorded gets no button', async ($, on) => {
  await mockSession($, on)
  const row = await $.ui.mount({ ...TOOL_ROW, requestId: 'r1', props: { ...TOOL_ROW.props, tool_use_id: 'r1' }, surface: 'desktop' } as never)
  expect(await row.find({ type: 'Button', text: /Replay/ })).toBeUndefined()
  await row.unmount()
})

const FILE = ['# Notes', 'intro line', 'second line', 'third line', 'TARGET line', 'fifth line', 'sixth line', 'seventh line', 'eighth line'].join('\n')

async function withFile($: any, on: any, prompt?: string) {
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\game' }))
  on('tool.run', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: FILE }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  await $.session.start({ cwd: 'C:\game', surface: 'desktop', isInteractive: true })
  if (prompt) await $.prompt.submit({ text: prompt })
}

test('context: an edit shows three lines each side with real line numbers', async ($, on) => {
  await withFile($, on)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: 'C:\game\notes.md', old_string: 'TARGET line', new_string: 'CHANGED line\nextra' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Lines 2 to 4 above and 6 to 8 below the changed line 5, none from further away.
  expect(await text(ui, /^\+ extra$/)).toBe('+ extra')
  expect(await text(ui, /^ {2}intro line$/)).toBe('  intro line')
  expect(await text(ui, /^ {2}seventh line$/)).toBe('  seventh line')
  expect(await text(ui, /eighth line/)).toBeUndefined()
  expect(await text(ui, /^# Notes/)).toBeUndefined()
  expect(await text(ui, /^5$/)).toBe('5')
  await ui.unmount()
})

test('grouping: changes sit under the prompt that caused them', async ($, on) => {
  await withFile($, on, 'make the notes better')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'g1', file_path: 'C:\game\notes.md', old_string: 'TARGET line', new_string: 'X' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /make the notes better/)).toBe('“make the notes better”')
  await ui.unmount()
})

test('grouping: paste wrappers are stripped from the heading', async ($, on) => {
  await withFile($, on, '<pasted_content id="c001">\nfix the lobby sign\n</pasted_content>')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'p1', file_path: 'C:\\game\\notes.md', old_string: 'TARGET line', new_string: 'X' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /lobby sign/)).toBe('“fix the lobby sign”')
  await ui.unmount()
})

test('grouping: a prompt that is only a paste reads as pasted text', async ($, on) => {
  await withFile($, on, '<pasted_content id="c001">')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'p2', file_path: 'C:\\game\\notes.md', old_string: 'TARGET line', new_string: 'X' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /pasted text/)).toBe('“(pasted text)”')
  await ui.unmount()
})
