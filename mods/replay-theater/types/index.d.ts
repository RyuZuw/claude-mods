export type Line = { op: string; t: string }
export type Change = {
  id: string
  cat: string
  tool: string
  file: string
  note: string
  lines: Line[]
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      changes: Shaped<Change[]>
      off: string[]
      sel: string
      paused: boolean
      autoOpened: boolean
    }
  }
}
