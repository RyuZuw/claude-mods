export type Line = { op: string; t: string; n?: number }
export type Change = {
  id: string
  cat: string
  tool: string
  file: string
  note: string
  turn: number
  lines: Line[]
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      changes: Shaped<Change[]>
      off: string[]
      sel: string
      prompts: string[]
      paused: boolean
      autoOpened: boolean
    }
  }
}
