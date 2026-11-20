# smart-resume

English | [日本語](README.ja.md)

A Claude Code plugin that adds `/smart-resume`: find a past session from whatever you remember about it, and resume it.

This document is for people who install the plugin and people who change it. It records how to use it, how it works, and why it is built this way.

```
/smart-resume the one where we fixed the payment bug
```

Haiku picks the 1 to 3 past sessions that match and lists each with bullet points of what was done in it. Choose one with the arrow keys and press Enter: it resumes the way the built-in `/resume` does.

## Install

At the Claude Code prompt:

```
/plugin install smart-resume --marketplace shirakawayohane/claude-smart-resume
```

From a shell:

```
claude plugin install smart-resume --marketplace shirakawayohane/claude-smart-resume
```

Claude Code itself is not modified. Claude Code is the only requirement: no Node, Python or other runtime is used. The plugin is a hooks module (function hooks), so it needs a Claude Code version that has that API. It was verified on 2.1.329.

## Usage

| Input | What happens |
|-------|--------------|
| `/smart-resume <what you are looking for>` | Searches and shows the candidates |
| `/smart-resume` (no argument) | Puts `/smart-resume ` back in the prompt box and asks you to type the rest |

Once the candidates are shown:

- `↑` `↓` to choose, `Enter` to resume. Number keys work too
- To search again in other words, type them in the dialog's last field (Type something) and press `Enter`
- `Esc` or "None of these" closes it without doing anything

Where the chosen session opens is the same as with the built-in `/resume`:

- A session of the same project (worktrees of the same repository included) is resumed in place
- For a session of another directory, `cd <dir> && claude --resume <id>` is shown and copied to the clipboard

## Settings

Change them in `/config`.

| Option | Default | Meaning |
|--------|---------|---------|
| `model` | `claude-haiku-5-5` | The model that picks and summarizes. Where it is not served, the plugin falls back to `haiku` |
| `maxResults` | `3` | The most candidates to show (1 to 3) |
| `language` | `auto` | Language of the dialog and the summaries: `auto`, `ja` or `en`. Under `auto` the on-screen text follows the language of the search words, and each summary follows the language its session was written in |

## How it works

1. **Build the index.** `~/.claude/history.jsonl` (the history of typed prompts) is grouped by session, and the title and working directory are read from the last 96 KB of each session log (`~/.claude/projects/<project>/<id>.jsonl`). Only for sessions missing from the history are prompts read from the first 256 KB of the log. The result is kept in the plugin's store, and a log is read again only when its size or modification time changed.
2. **Pick the candidates.** Every session goes into one numbered list that is handed to the model once, together with the search words. The list is kept under 90,000 characters. The 40 sessions that share the most characters with the search words and the 40 most recent get their prompts in detail; the rest get their title and first prompt.
3. **Summarize.** For each session picked, the model is given the prompts and excerpts of the assistant's replies (from the start of the log, its end, and three places between) and writes a title and 2 to 4 bullet points. Summaries are kept in the store and reused until the log's size changes.
4. **Ask.** The list with its bullet points is drawn at the end of the transcript, and Claude Code's standard question dialog opens under it.
5. **Resume.** The built-in `/resume` is run with the chosen session's id.

On a machine with about 470 sessions and 6.5 GB of logs, candidates appeared about 4 seconds after the search started (index 0.3 s, picking 1.7 s, summaries 1.5 s).

## Why it is built this way

### Read the history and the ends of each log, never whole logs

One session log can be hundreds of megabytes, and reading them all would take tens of seconds per search. The prompts a person typed are already in `history.jsonl` with their session id, and the title (the `ai-title` / `custom-title` rows) is written repeatedly near the end of the log. In a sample of 150 logs, all 125 that had a title had a title row within their last 64 KB.

Scanning the logs with an external command (`grep`, `python`) was rejected because it would require a runtime on the machine of whoever installs the plugin.

### One model call sees every session

Narrowing by matching words first and handing only the survivors to the model drops a session titled "right clicks" when the search says 「右クリック」. Absorbing paraphrases and language differences is the reason to use a model at all, so every session is on the list, at least in its short form.

The picking call runs at `medium` effort. At `low` there were cases where the model skipped a session listed in its short form and answered that nothing matched. `low` is enough for the summaries.

### Candidates are shown as a list in the transcript plus the standard dialog

A version that drew the list and its buttons in a pane (`$.ui.open`) was built and rejected. In the fullscreen layout a pane docks on the right, and the width the person last set for the dock wins. At a width of 24 columns each bullet point wrapped over 3 to 4 lines and was unreadable.

The standard question dialog (`$.ui.ask`) is as wide as the transcript, and its arrow keys, Enter and Esc match `/resume`. A plugin can only pass it option labels, though, not descriptions. So the bullet points are drawn separately at the end of the transcript with `$.ui.place`. That list is display only: it is not kept in the conversation record and the model never reads it.

### With no argument, the command goes back into the prompt box

The only free-text screen a plugin can open is a field in a pane, which has the width problem above. Putting `/smart-resume ` back in the prompt box gives the same width and the same keys under every display setting.

### Resuming is left to the built-in `/resume`

The plugin has no session-switching code of its own: it runs `/resume <id>`. The state after resuming is then always the same as the built-in's, and it follows changes in Claude Code.

`/resume <id>` does not find a session of another directory (it answers `Session … was not found`). The built-in picker shows a `cd` command in that case, so the plugin shows the same. Whether a session can be opened in place is decided by whether its project folder is the same, or its working directory is in `git worktree list`.

## Limits

- Only sessions whose logs are still on this machine can be found. Sessions past Claude Code's log retention (30 days by default) do not appear
- Sessions in which nobody typed a prompt (a script's run, for example) are left out
- The prompts and reply excerpts of your sessions are sent to the model with the same credentials as the session itself, and the cost is billed to your account. With Haiku 5.5 one search stays under 100,000 input tokens
- The formats of `history.jsonl` and the session logs are internal to Claude Code and can change between versions

## Development

```
claude plugin validate .   # checks the manifest and the hooks module, type-checks
claude plugin test .       # runs hooks/*.test.tsx
claude --plugin-dir .      # starts with the plugin loaded from this folder (saving a file reloads it)
```

| File | Contents |
|------|----------|
| `hooks/register.tsx` | Registers the command, runs the search, draws the list, resumes |
| `hooks/sessions.ts` | The session index (reading the history and the logs, the cache) |
| `hooks/search.ts` | The two questions asked of the model (picking, summarizing) |
| `types/index.d.ts` | The type of the list's on-screen state |
