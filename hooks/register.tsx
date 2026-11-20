// /smart-resume <what you remember>
//
// Finds the past sessions that match a description with a small model, lists
// up to three of them at the transcript's end with what was done in each,
// asks which one to go back to in Claude Code's own question dialog (arrows
// and Enter), and resumes the pick by running the built-in /resume on its id.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Lang, Listing, Proposal } from '../types'
import { fallbackSummary, rank, summarize } from './search'
import { clip, loadIndex, shortPath } from './sessions'
import type { Engine, SessionEntry } from './sessions'

const NAME = 'smart-resume'
// The rows at the transcript's end that list the suggestions: one per
// search, so each list is drawn where its own dialog opens.
const LIST = 'smart-resume-list-'

// Change the tag when Listing's fields change: it declines what an earlier
// version stored, which outlives a reload.
const listing = atom(
  { plugin: 'smart-resume', key: 'listing' } as const,
  null as Listing,
  { shape: 'listing-2' },
)

type Config = { model: string; max: number; language: string }

const STRINGS = {
  ja: {
    fillHint: '探したい内容を続けて入力して Enter',
    step: {
      index: 'セッション一覧を読み込み中…',
      rank: (count: number) =>
        `${count} 件のセッションから候補を選んでいます…`,
      summarize: '候補のやったことを要約中…',
    },
    header: '再開',
    question: 'どのセッションを再開しますか？',
    searched: (count: number) => `${count} 件から検索`,
    here: 'このプロジェクト',
    noneLabel: 'どれでもない',
    again:
      '言葉を変えて探し直すときは、最後の入力欄に書いて Enter',
    empty: (query: string, count: number) =>
      `「${query}」に該当しそうなセッションは見つかりませんでした（${count} 件から検索）。`,
    none: 'このマシンに再開できるセッションがありません。',
    failed: (message: string) => `検索に失敗しました: ${message}`,
    resumeFailed: (message: string) =>
      `セッションを再開できませんでした: ${message}`,
    elsewhere: (isCopied: boolean) =>
      `別のディレクトリのセッションです。${
        isCopied ? 'コマンドをクリップボードにコピーしました。' : ''
      }再開するには:`,
    ago: (value: number, unit: 'm' | 'h' | 'd' | 'mo') =>
      `${value}${{ m: '分', h: '時間', d: '日', mo: 'か月' }[unit]}前`,
    now: 'たった今',
  },
  en: {
    fillHint: 'Type what you are looking for, then Enter',
    step: {
      index: 'reading your sessions…',
      rank: (count: number) =>
        `picking from ${count} sessions…`,
      summarize: 'summarizing the candidates…',
    },
    header: 'Resume',
    question: 'Which session do you want to resume?',
    searched: (count: number) => `searched ${count} sessions`,
    here: 'this project',
    noneLabel: 'None of these',
    again:
      'To search again in other words, type them in the last field and press Enter',
    empty: (query: string, count: number) =>
      `no session looks like "${query}" (searched ${count}).`,
    none: 'there are no sessions to resume on this machine.',
    failed: (message: string) => `the search failed: ${message}`,
    resumeFailed: (message: string) =>
      `could not resume the session: ${message}`,
    elsewhere: (isCopied: boolean) =>
      `This session is from a different directory. ${
        isCopied ? 'Command copied to clipboard. ' : ''
      }To resume, run:`,
    ago: (value: number, unit: 'm' | 'h' | 'd' | 'mo') =>
      `${value}${unit} ago`,
    now: 'just now',
  },
} as const

// What the person set in /config, read when the module loads.
let config: Config = { model: 'claude-haiku-5-5', max: 3, language: 'auto' }

// One search runs at a time: starting another ends the one in flight.
// Module state: a reload ends it too.
let runs = 0
let inFlight: AbortController | undefined

type Ticket = { run: number; signal: AbortSignal }

function begin(): Ticket {
  runs++
  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller

  return { run: runs, signal: controller.signal }
}

const hasJapanese = (text: string): boolean =>
  /[\u3040-\u30ff\u3400-\u9fff]/.test(text)

async function langFor($: Engine, text: string): Promise<Lang> {
  if (config.language === 'ja' || config.language === 'en') {
    return config.language
  }
  if (hasJapanese(text)) return 'ja'
  if (text.trim() !== '') return 'en'
  // With nothing typed yet: the language of the last search, then the
  // machine's.
  const last = await $.store.get('lang').catch(() => undefined)
  if (last === 'ja' || last === 'en') return last
  const locale =
    (await $.env.get('LC_ALL')) ||
    (await $.env.get('LC_MESSAGES')) ||
    (await $.env.get('LANG')) ||
    ''

  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

const ageOf = (mtimeMs: number, lang: Lang): string => {
  const t = STRINGS[lang]
  const minutes = Math.floor((Date.now() - mtimeMs) / 60_000)
  if (minutes < 1) return t.now
  if (minutes < 60) return t.ago(minutes, 'm')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t.ago(hours, 'h')
  const days = Math.floor(hours / 24)
  if (days < 60) return t.ago(days, 'd')

  return t.ago(Math.floor(days / 30), 'mo')
}

const shellQuote = (text: string): string =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

/** The proposals of one search, each under a label of its own. */
const proposalsOf = (
  picked: readonly SessionEntry[],
  summaries: readonly { title: string; bullets: string[] }[],
  here: string,
  home: string,
): Proposal[] => {
  const taken = new Set<string>()

  return picked.map((entry, i) => {
    const summary = summaries[i] ?? fallbackSummary(entry)
    // A title the session already carries is the one /resume lists.
    const title = clip(entry.title ?? summary.title, 70)
    let label = clip(title, 48)
    for (let n = 2; taken.has(label); n++) label = `${clip(title, 44)} (${n})`
    taken.add(label)

    return {
      sessionId: entry.id,
      title,
      label,
      mtimeMs: entry.mtimeMs,
      where: shortPath(entry.cwd ?? entry.slug, home),
      cwd: entry.cwd,
      isHere: entry.slug === here,
      bullets: summary.bullets,
    }
  })
}

/**
 * Lists the proposals at the transcript's end and asks which to resume in
 * the engine's own question dialog: the arrows choose, Enter picks. Resolves
 * the proposal picked, the words typed in the dialog's free-text field (a
 * new search), or nothing when the person closed it or chose none.
 */
async function choose(
  $: Engine,
  shown: NonNullable<Listing>,
): Promise<Proposal | string | undefined> {
  const t = STRINGS[shown.lang]
  await update($, listing, () => shown)
  await $.ui.place({ id: shown.rowId })
  let answer: string
  try {
    answer = await $.ui.ask(t.question, {
      header: t.header,
      options: [...shown.proposals.map(({ label }) => label), t.noneLabel],
    })
  } catch {
    // Closed with Escape.
    return undefined
  } finally {
    await update($, listing, () => null)
  }
  const picked = shown.proposals.find(({ label }) => label === answer)
  if (picked !== undefined) return picked
  const typed = answer.trim()

  return typed === '' || typed === t.noneLabel ? undefined : typed
}

/** Whether `cwd` is a worktree of the repository this session runs in. */
async function isOwnWorktree($: Engine, cwd: string): Promise<boolean> {
  try {
    const listed = await $.process.run(
      ['git', 'worktree', 'list', '--porcelain'],
      { timeoutMs: 5000 },
    )
    if (listed.exitCode !== 0) return false

    return listed.stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
      .some(root => cwd === root || cwd.startsWith(`${root}/`))
  } catch {
    return false
  }
}

/**
 * Resumes the picked session as /resume does: here when it belongs to this
 * project, and for one that ran in another folder, by handing the person the
 * command that opens it there.
 */
async function resume(
  $: Engine,
  proposal: Proposal,
  lang: Lang,
): Promise<void> {
  const t = STRINGS[lang]
  try {
    const isReachable =
      proposal.isHere ||
      (proposal.cwd !== undefined && (await isOwnWorktree($, proposal.cwd)))
    if (isReachable) {
      const ran = await $.command.run({
        command: 'resume',
        args: proposal.sessionId,
      })
      if (!/not found/i.test(ran.text ?? '')) return
    }
    const command =
      proposal.cwd === undefined
        ? `claude --resume ${proposal.sessionId}`
        : `cd ${shellQuote(proposal.cwd)} && claude --resume ${proposal.sessionId}`
    const isCopied = await $.ui
      .copy({ text: command })
      .then(result => result.isCopied)
      .catch(() => false)
    $.ui.log(`${t.elsewhere(isCopied)} ${command}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(t.resumeFailed(message))
  }
}

/** One search, from the words typed to the session resumed. */
async function find($: Engine, query: string): Promise<void> {
  const { run, signal } = begin()
  const isLive = (): boolean => run === runs
  const lang = await langFor($, query)
  const t = STRINGS[lang]
  let next: string | undefined
  try {
    void $.store.set('lang', lang).catch(() => undefined)
    $.ui.status(t.step.index)
    const index = await loadIndex($)
    if (!isLive()) return
    const scanned = index.entries.length
    if (scanned === 0) {
      $.ui.log(t.none)

      return
    }
    $.ui.status(t.step.rank(scanned))
    const ask = { model: config.model, signal }
    const picked = await rank($, index, query, config.max, ask)
    if (!isLive()) return
    if (picked.length === 0) {
      $.ui.log(t.empty(query, scanned))

      return
    }
    $.ui.status(t.step.summarize)
    // Under auto each session is summarized in its own language, whatever
    // language the search was typed in.
    const summaryLang =
      config.language === 'ja' || config.language === 'en'
        ? config.language
        : 'auto'
    const summaries = await summarize($, picked, summaryLang, ask)
    if (!isLive()) return
    $.ui.status(undefined)
    const proposals = proposalsOf(picked, summaries, index.here, index.home)
    const chosen = await choose($, {
      rowId: `${LIST}${run}-${Date.now().toString(36)}`,
      lang,
      query,
      scanned,
      proposals,
    })
    if (!isLive() || chosen === undefined) return
    if (typeof chosen === 'string') next = chosen
    else await resume($, chosen, lang)
  } catch (error) {
    if (!isLive()) return
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(t.failed(message))
  } finally {
    if (isLive()) $.ui.status(undefined)
  }
  if (next !== undefined) await find($, next)
}

export const register: Register = (on, options) => {
  config = {
    model: String(options.model ?? '').trim() || 'claude-haiku-5-5',
    max: Math.max(1, Math.min(3, Math.floor(Number(options.maxResults)) || 3)),
    language: String(options.language ?? 'auto'),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description:
        'Find a past session by describing it, and resume the one you pick',
      argumentHint: '[what you are looking for]',
    })

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const query = e.args.trim()
    if (query === '') {
      // Nothing to search for yet: the command is put back in the prompt for
      // the person to finish.
      const lang = await langFor($, '')
      await $.prompt.fill({ text: `/${NAME} `, mode: 'replace' })
      $.ui.toast(STRINGS[lang].fillHint, { timeoutMs: 6000 })
    } else {
      // Not awaited: the status line shows the search's progress, and the
      // prompt is the person's again until the dialog asks.
      void find($, query)
    }

    return {}
  })

  // The suggestions, drawn above the dialog that asks which one to resume.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== NAME || !e.props.id.startsWith(LIST)) return next(e)
    const shown = await read($, listing)
    // A row of an earlier search draws nothing.
    if (shown === null || shown.rowId !== e.props.id) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const t = STRINGS[shown.lang]

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          smart-resume 「{shown.query}」 · {t.searched(shown.scanned)}
        </Text>
        {shown.proposals.map((proposal, i) => (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>
                {i + 1}. {proposal.title}
              </Text>
              <Text dimColor>
                {'  '}
                {ageOf(proposal.mtimeMs, shown.lang)} ·{' '}
                {proposal.isHere ? t.here : `↗ ${proposal.where}`}
              </Text>
            </Text>
            <Box flexDirection="column" paddingLeft={3}>
              {proposal.bullets.map(bullet => (
                <Text>• {bullet}</Text>
              ))}
            </Box>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>{t.again}</Text>
        </Box>
      </Box>
    )
  })
}
