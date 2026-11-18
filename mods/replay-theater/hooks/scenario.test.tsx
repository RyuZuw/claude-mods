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
