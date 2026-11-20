// The index of past sessions, built from Claude Code's own files with ranged
// reads only: the prompt history (every prompt the person typed, by session)
// and the tail of each session's transcript (its title and folder). Nothing
// here runs a program, so the mod needs no runtime beside Claude Code.

import type { EngineInterface } from 'claude-code'

export type Engine = EngineInterface

export type SessionEntry = {
  id: string
  /** The transcript file, absolute. */
  file: string
  /** The project folder's name under `projects/`. */
  slug: string
  size: number
  mtimeMs: number
  title?: string
  cwd?: string
  branch?: string
  /** What the person typed in it, oldest first. */
  prompts: string[]
}

export type SessionIndex = {
  entries: SessionEntry[]
  /** The project folder of the session that asks. */
  here: string
  home: string
}

type CachedEntry = {
  size: number
  mtimeMs: number
  title?: string
  cwd?: string
  branch?: string
  /** Prompts read from the transcript, kept only when the history has none. */
  prompts?: string[]
}

type Row = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { content?: unknown }
  aiTitle?: string
  customTitle?: string
}

const UUID_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const KIB = 1024
const TAIL_BYTES = 96 * KIB
const HEAD_BYTES = 256 * KIB
const HISTORY_CHUNK = 2 * KIB * KIB
const HISTORY_MAX = 48 * KIB * KIB
const READ_MAX = 4 * KIB * KIB
const INDEX_KEY = 'index:v1'
const CACHE_MAX = 3000
const PROMPT_CHARS = 400
const PROMPTS_PER_SESSION = 200

// Rows that are never a message, and are often very large.
const SKIPPED_ROWS = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"queue-operation"',
  '{"type":"tools-used"',
]

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )

  return out
}

/**
 * The whole lines of one byte range of a file: a line the range cuts at
 * either edge is left out.
 */
export async function readLines(
  $: Engine,
  file: string,
  offset: number,
  length: number,
  size: number,
): Promise<string[]> {
  const start = Math.max(0, Math.min(offset, size))
  const take = Math.min(length, READ_MAX, size - start)
  if (take <= 0) return []
  const text = await $.fs.read(file, { offset: start, length: take })
  const lines = text.split('\n')
  if (start > 0) lines.shift()
  if (start + take < size) lines.pop()

  return lines
}

export const parseRow = (line: string): Row | undefined => {
  if (line.length < 2 || line.charCodeAt(0) !== 123) return undefined
  if (SKIPPED_ROWS.some(prefix => line.startsWith(prefix))) return undefined
  try {
    const value: unknown = JSON.parse(line)

    return typeof value === 'object' && value !== null
      ? (value as Row)
      : undefined
  } catch {
    return undefined
  }
}

/** The text of a message's content: the string, or its text blocks joined. */
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return ''
      const { type, text } = block as { type?: unknown; text?: unknown }

      return type === 'text' && typeof text === 'string' ? text : ''
    })
    .filter(text => text !== '')
    .join('\n')
}

const NOISE_BLOCKS =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|task-notification|agent-message|pasted_content)\b[^>]*>[\s\S]*?<\/\1>/g

const SETTING_COMMANDS =
  /^\/(smart-resume|resume|continue|model|effort|fast|config|theme|color|permissions|mcp|plugin|login|logout|add-dir|compact|export|output-style|statusline|vim)\s/

/**
 * A prompt as the person typed it: the engine's own framing taken out, a
 * slash command read back as `/name args`, and `""` for what is no prompt.
 */
export const cleanPrompt = (raw: string): string => {
  let text = raw
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
    text = `${(command[1] ?? '').trim()} ${args?.[1] ?? ''}`
  }
  text = text.replace(NOISE_BLOCKS, ' ').replace(/\s+/g, ' ').trim()
  if (text.startsWith('[Request interrupted')) return ''
  if (text.startsWith('Caveat:')) return ''
  // A bare slash command (/clear), a setting (/model sonnet) and a search for
  // a session say nothing of what the session was about.
  if (/^\/[\w:.-]+$/.test(text)) return ''
  if (SETTING_COMMANDS.test(text)) return ''

  return text
}

/** The prompt a transcript row holds, when a person typed it. */
export const promptOf = (row: Row): string => {
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true) {
    return ''
  }

  return cleanPrompt(textOf(row.message?.content))
}

/** The text a transcript row's assistant message shows, tool calls left out. */
export const replyOf = (row: Row): string => {
  if (row.type !== 'assistant' || row.isSidechain === true) return ''

  return textOf(row.message?.content).replace(/\s+/g, ' ').trim()
}

const lastString = (text: string, key: string): string | undefined => {
  const pattern = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g')
  let found: string | undefined
  for (const match of text.matchAll(pattern)) found = match[1]
  if (found === undefined) return undefined
  try {
    const value: unknown = JSON.parse(`"${found}"`)

    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

type History = Map<string, { prompts: string[]; project?: string }>

async function readHistory($: Engine, configDir: string): Promise<History> {
  const history: History = new Map()
  const file = `${configDir}/history.jsonl`
  let size = 0
  try {
    size = (await $.fs.stat(file)).size
  } catch {
    return history
  }
  const start = Math.max(0, size - HISTORY_MAX)
  const offsets: number[] = []
  for (let offset = start; offset < size; offset += HISTORY_CHUNK) {
    offsets.push(offset)
  }
  // A chunk edge may cut a character in two: each half reads as U+FFFD, the
  // line around it stays JSON.
  const parts = await mapLimit(offsets, 4, offset =>
    $.fs.read(file, {
      offset,
      length: Math.min(HISTORY_CHUNK, size - offset),
    }),
  )
  const lines = parts.join('').split('\n')
  if (start > 0) lines.shift()
  for (const line of lines) {
    if (line === '') continue
    let row: { display?: unknown; project?: unknown; sessionId?: unknown }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    if (typeof row.sessionId !== 'string' || typeof row.display !== 'string') {
      continue
    }
    const prompt = cleanPrompt(row.display)
    let seen = history.get(row.sessionId)
    if (seen === undefined) {
      seen = { prompts: [] }
      history.set(row.sessionId, seen)
    }
    if (typeof row.project === 'string') seen.project = row.project
    if (prompt === '' || seen.prompts.at(-1) === prompt) continue
    if (seen.prompts.length < PROMPTS_PER_SESSION) {
      seen.prompts.push(clip(prompt, PROMPT_CHARS))
    }
  }

  return history
}

async function scanTranscript(
  $: Engine,
  file: string,
  size: number,
  wantsPrompts: boolean,
): Promise<Omit<CachedEntry, 'size' | 'mtimeMs'>> {
  const tail = await readLines(
    $,
    file,
    Math.max(0, size - TAIL_BYTES),
    TAIL_BYTES,
    size,
  )
  let aiTitle: string | undefined
  let customTitle: string | undefined
  for (const line of tail) {
    if (line.startsWith('{"type":"ai-title"')) {
      aiTitle = parseRow(line)?.aiTitle ?? aiTitle
    } else if (line.startsWith('{"type":"custom-title"')) {
      customTitle = parseRow(line)?.customTitle ?? customTitle
    }
  }
  const tailText = tail.join('\n')
  const scanned: Omit<CachedEntry, 'size' | 'mtimeMs'> = {
    title: customTitle ?? aiTitle,
    cwd: lastString(tailText, 'cwd'),
    branch: lastString(tailText, 'gitBranch'),
  }
  if (!wantsPrompts) return scanned

  const head =
    size <= TAIL_BYTES ? tail : await readLines($, file, 0, HEAD_BYTES, size)
  const prompts: string[] = []
  for (const line of head) {
    if (!line.includes('"type":"user"')) continue
    const row = parseRow(line)
    const prompt = row === undefined ? '' : promptOf(row)
    if (prompt === '' || prompts.at(-1) === prompt) continue
    prompts.push(clip(prompt, PROMPT_CHARS))
    if (prompts.length >= 12) break
  }
  scanned.prompts = prompts
  if (scanned.cwd === undefined) {
    scanned.cwd = lastString(head.join('\n'), 'cwd')
  }

  return scanned
}

async function readCache($: Engine): Promise<Record<string, CachedEntry>> {
  const stored = await $.store.get(INDEX_KEY)

  return typeof stored === 'object' && stored !== null
    ? (stored as Record<string, CachedEntry>)
    : {}
}

/**
 * Every past session on this machine, newest first, the asking session left
 * out. A transcript is read again only when its size or date changed.
 */
export async function loadIndex($: Engine): Promise<SessionIndex> {
  const [info, current, home, profile, configured] = await Promise.all([
    $.session.info(),
    $.session.id(),
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('CLAUDE_CONFIG_DIR'),
  ])
  const homeDir = home ?? profile ?? ''
  const parts = info.transcriptPath.split(/[\\/]/)
  let here = ''
  let root = `${configured ?? `${homeDir}/.claude`}/projects`
  if (parts.length >= 3) {
    here = parts.at(-2) ?? ''
    root = parts.slice(0, -2).join('/')
  }
  const configDir = root.replace(/[\\/]projects$/, '')

  const [folders, history, cache] = await Promise.all([
    $.fs.list(root).catch(() => []),
    readHistory($, configDir),
    readCache($),
  ])
  const listed = await mapLimit(
    folders.filter(folder => folder.kind === 'dir'),
    16,
    async folder => {
      const files = await $.fs.list(`${root}/${folder.name}`).catch(() => [])

      return files
        .filter(
          file =>
            file.kind === 'file' && file.size > 0 && UUID_FILE.test(file.name),
        )
        .map(file => ({
          id: file.name.slice(0, -'.jsonl'.length),
          file: `${root}/${folder.name}/${file.name}`,
          slug: folder.name,
          size: file.size,
          mtimeMs: file.mtimeMs,
        }))
    },
  )
  const found = listed.flat().filter(file => file.id !== current)

  let isCacheStale = false
  const scanned = await mapLimit(found, 16, async file => {
    const typed = history.get(file.id)
    const kept = cache[file.id]
    const needsPrompts = typed === undefined || typed.prompts.length === 0
    let meta: CachedEntry
    if (
      kept !== undefined &&
      kept.size === file.size &&
      kept.mtimeMs === file.mtimeMs &&
      (!needsPrompts || kept.prompts !== undefined)
    ) {
      meta = kept
    } else {
      isCacheStale = true
      try {
        meta = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          ...(await scanTranscript($, file.file, file.size, needsPrompts)),
        }
      } catch {
        meta = { size: file.size, mtimeMs: file.mtimeMs }
      }
    }
    const prompts = needsPrompts ? (meta.prompts ?? []) : typed.prompts
    const entry: SessionEntry = {
      ...file,
      title: meta.title,
      cwd: projectDir(file.slug, [typed?.project, meta.cwd]),
      branch: meta.branch,
      prompts,
    }

    return { entry, meta }
  })

  scanned.sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs)
  if (isCacheStale || Object.keys(cache).length !== scanned.length) {
    const next: Record<string, CachedEntry> = {}
    for (const { entry, meta } of scanned.slice(0, CACHE_MAX)) {
      next[entry.id] = meta
    }
    await $.store.set(INDEX_KEY, next).catch(() => undefined)
  }

  return {
    // A session nobody typed in (a script's run) is nothing to come back to.
    entries: scanned
      .map(({ entry }) => entry)
      .filter(entry => entry.prompts.length > 0),
    here,
    home: homeDir,
  }
}

/**
 * The folder a session belongs to: of the folders its rows name, the one its
 * project folder is named after, since that is where `claude --resume` finds
 * it. A session's own directory can move while it runs; the project does not.
 */
export const projectDir = (
  slug: string,
  candidates: readonly (string | undefined)[],
): string | undefined => {
  const named = candidates.filter(
    (path): path is string => path !== undefined && path !== '',
  )

  return (
    named.find(path => path.replace(/[^a-zA-Z0-9]/g, '-') === slug) ?? named[0]
  )
}

/** A path with the home folder shortened to `~`. */
export const shortPath = (path: string, home: string): string =>
  home !== '' && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path
