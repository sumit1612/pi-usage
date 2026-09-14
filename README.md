# pi-usage

Token, context, and cost usage dashboard for the [pi coding agent](https://github.com/earendil-works/pi-mono). Two ways to use it:

- **`/usage`** — an interactive, theme-aware TUI dashboard inside pi.
- **`pi-usage`** — a standalone zero-dependency CLI (works anywhere Node runs).

Both read the same session data and always agree.

![pi-usage dashboard](docs/screenshot.png)

## Install

### As a pi package (recommended)

```bash
pi install npm:pi-usage-cli         # from npm
pi install git:github.com/sumit1612/pi-usage  # from git
pi install /path/to/pi-usage            # local directory
```

This loads the `/usage` slash command automatically. Then type `/usage` in pi.

### As a standalone CLI

```bash
npm install -g pi-usage-cli
pi-usage            # overview
pi-usage models     # per-model table
```

## CLI usage

```
pi-usage [view] [flags]

VIEWS
  overview   totals + usage + models + providers  (default)
  models     per-model table (with efficiency metrics)
  providers  per-provider table
  agents     per-subagent-agent table
  days       per-day table + bars
  sessions   per-session table

FLAGS
  --since <n>      last N days (default 30)
  --all            include all time
  --model <str>    filter by model substring
  --provider <str> filter by provider substring
  --cwd <path>     filter by project working directory
  --group <g>      group days by day | week | month (default day)
  --sort <k>       sort tables by cost | tokens | calls | name (default cost)
  --limit <n>      max rows in tables (default 15)
  --dir <path>     session directory (default ~/.pi/agent/sessions)
  --csv            machine-readable CSV (per current view)
  --tsv            machine-readable TSV (per current view)
  --budget <n>     warn + exit 3 if total spend exceeds $n
  --watch          re-render every 2s (live session dir)
  --color          force color even when piped
  --plain          flat output (no color / unicode)
  --json           machine-readable JSON output
  -h, --help       show help
```

Colors match pi's built-in **dark** theme. Output is auto-detected: rich (color + unicode) on a TTY, clean flat tables when piped.

## `/usage` keys

| Key | Action |
|---|---|
| `←` / `→` | cycle views |
| `1`–`6` | jump to a view |
| `↑` / `↓` | move selection |
| `enter` | drill into the selected row (usage detail) |
| `esc` | close detail, or close the dashboard |
| `q` | close the dashboard |
| `r` | refresh data |

Flags are passed through: `/usage models`, `/usage --all`, `/usage --since 7`, `/usage --model gpt`, `/usage --cwd ~/proj`, `/usage --group week`.

`/usage` also shows a live **this-session** cost indicator in the footer, updated on every assistant response.

## Metrics

| Field | Meaning |
|---|---|
| input / output / cache read / cache write / reasoning | token breakdown |
| context | `input + cacheRead + cacheWrite` — tokens resident in the request |
| total | billable tokens (provider-reported `totalTokens`) |
| cost | $ per component + total |
| cache hit | `cacheRead / (input + cacheRead + cacheWrite)` |
| reasoning | `reasoning / total` |
| $/1M | blended cost per million tokens |
| avg tok/call | `total / calls` |
| model switches | `model_change` events (main/fork sessions) |

## How it counts

- Only `assistant`, compaction, and branch-summary usage is counted. Tool results — which can embed a *summary* of subagent usage — are skipped to avoid double-counting.
- **Forks**: a forked session copies its parent's history with identical entry ids. Entries are deduplicated by id, so shared history is counted once and only the fork's *new* work is attributed to it.
- **Subagents**: a subagent run may be stored twice (an artifact transcript and a `run-N/session.jsonl`). The canonical `session.jsonl` is preferred per `runId`; the transcript is skipped when it exists, so a run is never counted twice.
- **Transcripts**: subagent artifact transcripts use a different schema (`recordType`, top-level `usage`, numeric `cost`). Both shapes are normalized.

## Structure

```
lib/core.js          shared aggregation engine (no dependencies)
lib/core.d.ts        TypeScript types for the engine
bin/pi-usage         CLI (presentation only)
extensions/usage.ts  /usage slash command (interactive TUI)
test/core.test.js    correctness tests (fork dedup, subagent dedup, transcripts)
```

## Testing

```bash
npm test
```

The suite builds a tiny session directory with the tricky real-world shapes (forked history, duplicate subagent runs, numeric-cost transcripts) and asserts the aggregator counts each logical entry exactly once.

## Publishing

```bash
npm publish
# or push to GitHub and: pi install git:github.com/sumit1612/pi-usage
```

Tag with `pi-package` (already in `package.json`) to appear in the [package gallery](https://pi.dev/packages).

## License

MIT
