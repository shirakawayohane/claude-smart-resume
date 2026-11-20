import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildList, jsonIn } from './search'
import { cleanPrompt, projectDir } from './sessions'
import type { SessionEntry } from './sessions'

const ROOT = '/cfg/projects'
const HERE = '-work-app'
const CURRENT = '00000000-0000-4000-8000-000000000000'
const KEYS = 'aaaaaaaa-0000-4000-8000-000000000001'
const PAYMENT = 'bbbbbbbb-0000-4000-8000-000000000002'

const row = (value: unknown): string => JSON.stringify(value)

const FILES: Record<string, string> = {
  '/cfg/history.jsonl': [
    row({ display: 'remap caps lock to ctrl', project: '/work/app', sessionId: KEYS }),
    row({ display: '/model sonnet', project: '/work/app', sessionId: KEYS }),
    row({ display: 'fix the payment webhook retry bug', project: '/work/shop', sessionId: PAYMENT }),
    '',
  ].join('\n'),
  [`${ROOT}/${HERE}/${KEYS}.jsonl`]: [
    row({ type: 'user', cwd: '/work/app', message: { content: 'remap caps lock to ctrl' } }),
    row({ type: 'assistant', message: { content: [{ type: 'text', text: 'Mapped Caps Lock to Control with hidutil and made it survive a restart.' }] } }),
    row({ type: 'ai-title', aiTitle: 'Keyboard remapping', sessionId: KEYS }),
    '',
  ].join('\n'),
  [`${ROOT}/-work-shop/${PAYMENT}.jsonl`]: [
    row({ type: 'user', cwd: '/work/shop', message: { content: 'fix the payment webhook retry bug' } }),
    row({ type: 'ai-title', aiTitle: 'Payment webhook retries', sessionId: PAYMENT }),
    '',
  ].join('\n'),
}

const DIRS: Record<string, { name: string; kind: 'file' | 'dir'; mtimeMs: number }[]> = {
  [ROOT]: [
    { name: HERE, kind: 'dir', mtimeMs: 0 },
    { name: '-work-shop', kind: 'dir', mtimeMs: 0 },
  ],
  [`${ROOT}/${HERE}`]: [
    { name: `${KEYS}.jsonl`, kind: 'file', mtimeMs: 2000 },
    { name: `${CURRENT}.jsonl`, kind: 'file', mtimeMs: 3000 },
    { name: 'memory', kind: 'dir', mtimeMs: 0 },
  ],
  [`${ROOT}/-work-shop`]: [{ name: `${PAYMENT}.jsonl`, kind: 'file', mtimeMs: 1000 }],
}

type World = {
  /** The session numbers the model picks, as the list numbers them. */
  picks: number[]
  /** What the person answers in the dialog: a label, or free text. */
  answer: (labels: string[]) => string
}

/** The engine beneath the mod: files, the model, the dialog, /resume. */
const world = (on: On, { picks, answer }: World) => {
  const seen = {
    resumed: [] as string[],
    logged: [] as string[],
    copied: [] as string[],
    listed: [] as string[][],
    prompts: [] as string[],
    filled: [] as string[],
  }
  let done: () => void = () => undefined
  const settled = new Promise<void>(resolve => {
    done = resolve
  })

  mock.store(on)
  mock.env(on, { HOME: '/home/me', LANG: 'en_US.UTF-8' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: `${ROOT}/${HERE}/${CURRENT}.jsonl` } }))
  on('session.id', () => ({ value: CURRENT }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path] ?? []).map(entry => ({
      ...entry,
      size: entry.kind === 'file' ? (FILES[`${e.path}/${entry.name}`] ?? 'x').length : 0,
      isLink: false,
    })),
  }))
  on('fs.stat', (_, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)

    return { value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = FILES[e.path] ?? ''
    const start = e.offset ?? 0

    return { value: text.slice(start, start + (e.length ?? text.length)) }
  })
  on('process.run', () => ({
    value: {
      exitCode: 128,
      stdout: '',
      stderr: 'not a repo',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', (_, e) => {
    seen.prompts.push(e.prompt)
    const text = e.system?.includes('Pick the sessions')
      ? JSON.stringify({ picks })
      : JSON.stringify({ title: 'A summary', bullets: ['Did one thing', 'Did another'] })

    return {
      value: {
        isAnswered: true,
        text,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: e.id } }))
  on('ui.log', (_, e) => {
    seen.logged.push(e.text)
    done()

    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]
    const labels = (question?.options ?? []).map(option => option.label)
    seen.listed.push(labels)

    return {
      result: {
        questions: e.questions,
        answers: { [question?.question ?? '']: answer(labels) },
      },
    }
  })
  on('command.run', { command: 'resume' }, (_, e) => {
    seen.resumed.push(e.args)
    done()

    return { text: '' }
  })

  return { seen, settled }
}

/** `/smart-resume <words>`, as the person's Enter raises it. */
const typed = ($: Engine, args: string) =>
  $.command.run({
    command: 'smart-resume',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('a prompt is read as the person typed it', () => {
  expect(cleanPrompt('  fix   the\nbug ')).toBe('fix the bug')
  expect(cleanPrompt('<system-reminder>be nice</system-reminder>hello')).toBe('hello')
  expect(
    cleanPrompt('<command-name>/review</command-name><command-args>the diff</command-args>'),
  ).toBe('/review the diff')
  // A bare command and a search for a session say nothing about the session.
  expect(cleanPrompt('/clear')).toBe('')
  expect(cleanPrompt('/model sonnet')).toBe('')
  expect(cleanPrompt('/smart-resume the payment bug')).toBe('')
  expect(cleanPrompt('[Request interrupted by user]')).toBe('')
})

test('a session belongs to the folder its project is named after', () => {
  expect(projectDir('-work-app', ['/tmp/elsewhere', '/work/app'])).toBe('/work/app')
  expect(projectDir('-work-app', [undefined, '/tmp/elsewhere'])).toBe('/tmp/elsewhere')
  expect(projectDir('-work-app', [])).toBe(undefined)
})

test('the JSON of an answer is found whatever surrounds it', () => {
  expect(jsonIn('Sure:\n```json\n{"picks":[2,1]}\n```')).toEqual({ picks: [2, 1] })
  expect(jsonIn('no json here')).toBe(undefined)
})

test('every session is on the list, the matching ones in detail', () => {
  const entries: SessionEntry[] = Array.from({ length: 120 }, (_, i) => ({
    id: `id-${i}`,
    file: `/f/${i}.jsonl`,
    slug: '-work-app',
    size: 10,
    mtimeMs: 1_000_000 - i,
    title: i === 100 ? 'Stripe refund flow' : `Chore ${i}`,
    prompts:
      i === 100
        ? ['look at the code', 'the stripe refund webhook is firing twice']
        : [`tidy up module ${i}`, `rename file ${i}`],
  }))
  const { text, listed } = buildList(entries, 'stripe refund webhook')

  expect(listed.length).toBe(120)
  // An old session the search text matches gets its prompts in full.
  expect(text).toContain('the stripe refund webhook is firing twice')
  // An old session it does not match is a line and its first prompt.
  expect(text).toContain('tidy up module 90')
  expect(text).not.toContain('rename file 90')
})

test('a session of this project is resumed by /resume', async ($, on) => {
  const { seen, settled } = world(on, {
    picks: [1, 2],
    answer: labels => labels[0] ?? '',
  })

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await typed($, 'the keyboard one')
  await settled

  // The current session is never offered; the newest match is listed first.
  expect(seen.prompts[0]).toContain('#1 |')
  expect(seen.prompts[0]).toContain('Keyboard remapping')
  expect(seen.prompts[0]).toContain('remap caps lock to ctrl')
  expect(seen.prompts[0]).not.toContain('/model sonnet')
  expect(seen.listed[0]).toEqual([
    'Keyboard remapping',
    'Payment webhook retries',
    'None of these',
  ])
  expect(seen.resumed).toEqual([KEYS])
})

test('a session of another folder is handed over as a command', async ($, on) => {
  const { seen, settled } = world(on, {
    picks: [2],
    answer: labels => labels[0] ?? '',
  })

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await typed($, 'payment webhook')
  await settled

  const command = `cd /work/shop && claude --resume ${PAYMENT}`
  expect(seen.resumed).toEqual([])
  expect(seen.copied).toEqual([command])
  expect(seen.logged.at(-1)).toContain(command)
})

test('nothing is resumed when the person picks none', async ($, on) => {
  const { seen, settled } = world(on, {
    picks: [],
    answer: () => 'None of these',
  })

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await typed($, 'something else entirely')
  await settled

  // No pick from the model: the person is told, and no dialog opens.
  expect(seen.listed).toEqual([])
  expect(seen.resumed).toEqual([])
  expect(seen.logged.at(-1)).toContain('no session looks like')
})

test('words typed in the dialog start a new search', async ($, on) => {
  let asked = 0
  const { seen, settled } = world(on, {
    picks: [1],
    answer: labels => (asked++ === 0 ? 'the payment one instead' : (labels[0] ?? '')),
  })

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await typed($, 'the keyboard one')
  await settled

  const searches = seen.prompts.filter(prompt => prompt.includes('<looking_for>'))
  expect(searches.length).toBe(2)
  expect(searches[1]).toContain('the payment one instead')
  expect(seen.resumed).toEqual([KEYS])
})

test('with no words the command is put back in the prompt to finish', async ($, on) => {
  const { seen } = world(on, { picks: [], answer: () => '' })

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await typed($, '')

  expect(seen.filled).toEqual(['/smart-resume '])
  expect(seen.prompts).toEqual([])
})
