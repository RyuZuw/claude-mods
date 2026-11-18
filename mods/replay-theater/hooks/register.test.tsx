import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  props: {
    title: 'Replay Theater',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

async function start($: any, on: any) {
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  // The mod's hook is on `tool.run`; this one stands for the engine beneath it.
  on('tool.run', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
}

test('records a Windows-path edit and a Studio call, skips a Studio read', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'a', file_path: 'C:\\proj\\notes\\Now.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'mcp__Roblox_Studio__execute_luau', tool_use_id: 'b', code: 'print(1)', datamodel_type: 'Edit', studio_id: 'x' })
  await $.tool.call({ tool: 'mcp__Roblox_Studio__script_read', tool_use_id: 'c', target_file: 'game.Workspace.X', studio_id: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Newest first: step 2 (the Studio call) is on show and the panel follows it.
  // "of 2": the Edit and the Studio call counted, the Studio read did not.
  expect((await ui.find({ type: 'Text', text: /step 2 of/ }))?.text).toMatch(/^step\ 2\ of\ 2\ ·\ live( · \d\d:\d\d)?$/)
  // One press on Older shows step 1, the Edit, its Windows path cut to a relative one.
  await ui.press({ plugin: 'replay-theater', key: 'older' })
  expect((await ui.find({ type: 'Text', text: /^notes$/ }))?.text).toBe('notes')
  expect((await ui.find({ type: 'Text', text: /^Now\.md$/ }))?.text).toBe('Now.md')
  expect((await ui.find({ type: 'Text', text: /step 1 of/ }))?.text).toMatch(/^step\ 1\ of\ 2( · \d\d:\d\d)?$/)
  await ui.unmount()
})

test('the Pause button stops recording', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'a', file_path: 'C:\\proj\\a.py', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ plugin: 'replay-theater', key: 'pause' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'a', file_path: 'C:\\proj\\b.py', old_string: 'a', new_string: 'b' })

  expect((await ui.find({ type: 'Text', text: /paused/ }))?.text).toBe('⏸ paused')
  await ui.unmount()
})

test('the panel draws wide and narrow', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'a', file_path: 'C:\\proj\\a.py', old_string: 'a', new_string: 'b' })

  for (const bodyColumns of [40, 100]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /step 1 of/ }))?.text).toMatch(/^step\ 1\ of\ 1\ ·\ live( · \d\d:\d\d)?$/)
    await ui.unmount()
  }
})
