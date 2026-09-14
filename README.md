# pi-usage

<p align="center">
  <strong>Token, context, and cost analytics for the <a href="https://github.com/earendil-works/pi-mono">pi coding agent</a> — fast, local, and honest about the numbers.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-usage-cli"><img src="https://img.shields.io/npm/v/pi-usage-cli" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-usage-cli"><img src="https://img.shields.io/npm/dm/pi-usage-cli" alt="npm downloads"></a>
  <a href="https://github.com/sumit1612/pi-usage/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/pi-usage-cli" alt="license"></a>
  <a href="https://www.npmjs.com/package/pi-usage-cli"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node"></a>
  <a href="https://github.com/sumit1612/pi-usage"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies"></a>
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="pi-usage dashboard" width="640">
</p>

---

## Why pi-usage

Running an agent means spending tokens — and guessing where they go. **pi-usage** turns pi's raw session logs into a clear, honest accounting of every token and dollar, in two interfaces that *always agree*:

| | `/usage` | `pi-usage` |
|---|---|---|
| **Where** | Interactive TUI inside pi | Standalone CLI |
| **Style** | Theme-aware, keyboard-driven | Zero-dependency, pipe-friendly |
| **Best for** | Exploring while you work | Scripts, CI, quick checks |

Both read the **same** session data through the **same** aggregation engine, so a model's cost is identical whether you're drilling into the TUI or exporting JSON.

### Highlights

- 🔒 **100% local & private** — reads your session files directly. Nothing is uploaded, no telemetry, no accounts.
- 🧮 **Correct by construction** — deduplicates forks, subagent re-runs, and tool-result summaries so totals aren't inflated (see [How it counts](#how-it-counts)).
- 📦 **Zero dependencies** — the CLI is a single Node script; install it anywhere Node ≥ 18 runs.
- 🎨 **Theme-aware TUI** — `/usage` inherits pi's active theme and shows a live *this-session* cost in the footer.
- 📊 **Six views** — models, providers, agents, days, sessions, and an overview with token/efficiency breakdowns.
- 💸 **Budget guardrails** — `--budget N` exits non-zero when recorded spend crosses a threshold (great for CI).
- 🖨️ **Machine-readable** — JSON, CSV, and TSV exports for spreadsheets and dashboards.

---

## Quick start

```bash
# One-off, no install:
npx -y pi-usage-cli --all

# Install globally:
npm install -g pi-usage-cli
pi-usage                 # overview (last 30 days)
pi-usage --all           # all time
pi-usage models          # per-model table
pi-usage --budget 20     # exit 3 if spend exceeds $20
```

Inside pi, just type:

```text
/usage
```

---

## Install

### As a pi package (recommended)

```bash
pi install npm:pi-usage-cli                    # from npm
pi install git:github.com/sumit1612/pi-usage   # from git
pi install /path/to/pi-usage                   # local directory
```

This registers the `/usage` slash command automatically. Type `/usage` to open the dashboard.

### As a standalone CLI

```bash
npm install -g pi-usage-cli
pi-usage            # overview
pi-usage models     # per-model table
```

---

## CLI usage

```
pi-usage [overview|models|providers|agents|days|sessions] [flags]
```

### Views

| View | Shows |
|---|---|
| `overview` | Totals + token/efficiency breakdown + models + providers/agents + API endpoints *(default)* |
| `models` | Per-model table with cache-hit %, $/1M, reasoning, context |
| `providers` | Per-provider table |
| `agents` | Per-subagent table (`worker`, `scout`, `reviewer`, …) |
| `days` | Per-day table with spend bars (groups by `day`/`week`/`month`) |
| `sessions` | Per-session table |

### Flags

| Flag | Description |
|---|---|
| `--since <n>` | Last N days (default 30) |
| `--all` | Include all time |
| `--model <str>` | Filter by model substring |
| `--provider <str>` | Filter by provider substring |
| `--cwd <path>` | Filter by project working directory |
| `--group <g>` | Group days by `day` \| `week` \| `month` |
| `--sort <k>` | Sort by `cost` \| `tokens` \| `calls` \| `name` |
| `--limit <n>` | Max table rows (default 15) |
| `--dir <path>` | Session directory (default `~/.pi/agent/sessions`) |
| `--json` | Machine-readable JSON |
| `--csv` / `--tsv` | Delimited export of the current view |
| `--budget <n>` | Exit `3` when recorded cost exceeds $n |
| `--watch` | Re-render every 2 s (live session dir) |
| `--color` / `--plain` | Force / disable color and Unicode |
| `-h, --help` | Show help |

### Example output

```text
  pi-usage                                                            All time
  10 main / 1 fork / 2 subagent

  RECORDED COST      TOKENS             CALLS              CACHE HIT
  $23.95             77.9M              564                95.3%

  MODELS
  ────────────────────────────────────────────────────────────────────────────
  NAME                                             CALLS     TOKENS       COST
  openai-codex/gpt-6-astra                            67       7.7M     $15.00
  deepseek/deepseek-v4-pro                           493      70.2M      $8.95
  deepseek/deepseek-flash                              4      14.6K    $0.0030

  PROVIDERS
  ────────────────────────────────────────────────────────────────────────────
  NAME                                             CALLS     TOKENS       COST
  openai-codex                                        67       7.7M     $15.00
  deepseek                                           497      70.2M      $8.96

  PROVIDER / API
  ────────────────────────────────────────────────────────────────────────────
  deepseek/openai-completions    / 70,233,964 tok / 497 calls
  openai-codex/openai-codex-responses / 7,706,854 tok / 67 calls
```

Color and decorative Unicode are auto-detected on a TTY; `--color` forces them and `--plain` strips them for clean pipes.

---

## `/usage` TUI

| Key | Action |
|---|---|
| `←` / `→` | Cycle views |
| `1`–`6` | Jump to a view |
| `↑` / `↓` | Move selection |
| `enter` | Drill into the selected row (usage detail) |
| `esc` | Close detail, or close the dashboard |
| `q` | Close the dashboard |
| `r` | Refresh data |

Flags pass through: `/usage models`, `/usage --all`, `/usage --since 7`, `/usage --model gpt`, `/usage --cwd ~/proj`, `/usage --group week`.

A live **this-session** cost indicator sits in the footer, updating on every assistant response.

---

## Metrics

| Field | Meaning |
|---|---|
| `input` / `output` / `cache read` / `cache write` / `reasoning` | Token breakdown |
| `context` | `input + cacheRead + cacheWrite` — tokens resident in the request |
| `total` | Billable tokens (provider-reported `totalTokens`) |
| `cost` | $ per component + total |
| `cache hit` | `cacheRead / (input + cacheRead + cacheWrite)` |
| `reasoning` | `reasoning / total` |
| `$/1M` | Blended cost per million tokens |
| `avg tok/call` | `total / calls` |
| `model switches` | `model_change` events in main/fork sessions |
| `Provider / API` | Traffic grouped by `provider/api` (e.g. `deepseek/openai-completions`) |

---

## Exports & automation

Every view exports cleanly, so pi-usage slots into pipelines:

```bash
pi-usage --json            # full aggregate as JSON
pi-usage models --csv      # per-model table as CSV
pi-usage days --tsv        # per-day table as TSV

# CI guard: fail the job if spend passes $25
pi-usage --all --budget 25
```

`--json` gives you the whole aggregate (totals, per-model/per-provider/per-agent/per-day buckets, sessions, and the provider/API breakdown). CSV/TSV export the currently selected view; `overview` exports models.

---

## How it counts

Reliability is the point, so the engine is deliberately conservative about double-counting:

- **Only** `assistant`, compaction, and branch-summary usage is counted. Tool results — which can embed a *summary* of subagent usage — are skipped.
- **Forks** copy their parent's history with identical entry ids. Entries are deduplicated by id *within an explicitly linked parent/fork lineage*, so unrelated sessions that happen to reuse ids are kept separate. Only the fork's *new* work is attributed to it.
- **Subagents** may be stored twice (an artifact transcript **and** a `run-N/session.jsonl`). The canonical `session.jsonl` is preferred per `runId`, so a run is never counted twice.
- **Transcripts** use a different schema (`recordType`, top-level `usage`, numeric `cost`) and are normalized to the same shape. A missing provider is inferred only when *every* observed use of that model agrees; ambiguous models stay under `?/model` and are excluded from named-provider filters.
- The **Provider / API** breakdown is keyed `provider/api` so it reconciles with the Providers view (e.g. `deepseek/openai-completions` rather than a bare protocol name).

Totals always equal the sum of the model, provider, and API buckets — a property the test suite asserts directly.

---

## Project structure

```
lib/core.js          shared aggregation engine (no dependencies)
lib/core.d.ts        TypeScript types for the engine
lib/presentation.js  responsive standalone dashboard renderer
bin/pi-usage         CLI flags, exports, and watch loop
extensions/usage.ts  /usage slash command (interactive TUI)
test/                correctness + presentation + review suites
docs/screenshot.png  dashboard preview
```

---

## Development & testing

```bash
npm test
```

The suite (20 cases across `test/core.test.js`, `test/presentation.test.js`, and `test/review.test.js`) builds tiny session directories with the tricky real-world shapes — forked history, duplicate subagent runs, numeric-cost transcripts — and asserts each logical entry is counted exactly once, plus that every view fits narrow and wide terminals.

---

## Publishing

```bash
npm version patch | minor | major
npm publish
```

The package is tagged `pi-package` (in `package.json`), so it surfaces in the [package gallery](https://pi.dev/packages).

---

## License

[MIT](LICENSE)
