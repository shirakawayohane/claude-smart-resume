/** One suggested session, as the list draws it. */
export type Proposal = {
  sessionId: string
  /** The session's title, as /resume would list it. */
  title: string
  /** What the dialog's option reads; no two of one search are alike. */
  label: string
  /** Last activity, milliseconds since the epoch. */
  mtimeMs: number
  /** Where the session ran, home shortened to `~`. */
  where: string
  /** Where the session ran, as recorded; absent when no row says. */
  cwd?: string
  /** True when the session belongs to the project this session runs in. */
  isHere: boolean
  /** What was done in it, one short line each. */
  bullets: string[]
}

export type Lang = 'ja' | 'en'

/** The suggestions on screen while the person chooses; `null` when none are. */
export type Listing = {
  /** The transcript row that draws this list. */
  rowId: string
  lang: Lang
  query: string
  /** How many sessions the search looked through. */
  scanned: number
  proposals: Proposal[]
} | null

declare module 'claude-code' {
  interface PluginState {
    'smart-resume': { listing: Shaped<Listing> }
  }
}
