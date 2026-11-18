export type Line = { op: string; t: string; n?: number }
export type Change = {
  id: string
  cat: string
  tool: string
  file: string
  note: string
  turn: number
  at: number
  lines: Line[]
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      changes: Shaped<Change[]>
      off: string[]
      sel: string
      prompts: string[]
      folded: number[]
      context: boolean
      confirmClear: boolean
      paused: boolean
      autoOpened: boolean
    }
  }
}
