/**
 * /usage — interactive usage dashboard for pi.
 *
 * Renders token / context / cost usage from the shared core (../lib/core.js) as
 * a themed, interactive TUI component — matches pi's active theme.
 *
 * Loads once (single synchronous aggregate); view switching and scrolling are
 * in-memory, so it stays fast.
 *
 * Keys:
 *   ← / →       cycle views (overview / models / days / sessions)
 *   1..4        jump to a view
 *   ↑ / ↓       scroll lists
 *   r           refresh data
 *   esc / q     close
 *
 * Flags (passed to the core): --all, --since N, --model X, --provider Y, --dir
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { aggregate, toData } from "../lib/core.js";
import type { UsageData } from "../lib/core.js";

const VIEWS = ["overview", "models", "days", "sessions"] as const;
type View = (typeof VIEWS)[number];
const SUGGESTIONS = [...VIEWS, "--all", "--since", "--model", "--provider", "--dir"];
const MAX_ROWS = 12;

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ---------------------------------------------------------------------------
// formatting helpers (no deps)
// ---------------------------------------------------------------------------

function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}
function money(n: number): string {
  if (!isFinite(n)) return "$0";
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (a >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  if (a >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
function pct(n: number): string {
  if (n > 0 && n < 0.5) return n.toFixed(1) + "%";
  return Math.round(n) + "%";
}
function bar(frac: number, width: number): { fill: string; empty: string } {
  const cells = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  const units = Math.max(0, Math.min(1, frac)) * width * 8;
  let fill = "", empty = "";
  for (let i = 0; i < width; i++) {
    const rem = units - i * 8;
    if (rem >= 8) fill += "█";
    else if (rem <= 0) empty += " ";
    else fill += cells[Math.round(rem)];
  }
  return { fill, empty };
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function pad(s: string, n: number, right = false): string {
  const v = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (v.length >= n) return s;
  const gap = " ".repeat(n - v.length);
  return right ? gap + s : s + gap;
}

// ---------------------------------------------------------------------------
// data normalization
// ---------------------------------------------------------------------------

interface ModelRow { key: string; calls: number; tokens: UsageData["totals"]["tokens"]; cost: UsageData["totals"]["cost"]; }
interface DayRow { day: string; calls: number; tokens: UsageData["totals"]["tokens"]; cost: UsageData["totals"]["cost"]; }
interface SessionRow { name: string; kind: string; calls: number; tokens: UsageData["totals"]["tokens"]; cost: UsageData["totals"]["cost"]; }

function modelsOf(data: UsageData): ModelRow[] {
  return Object.entries(data.byModel)
    .map(([key, v]) => ({ key, calls: v.calls, tokens: v.tokens, cost: v.cost }))
    .sort((a, b) => b.cost.total - a.cost.total);
}
function daysOf(data: UsageData): DayRow[] {
  return Object.entries(data.byDay)
    .map(([day, v]) => ({ day, calls: v.calls, tokens: v.tokens, cost: v.cost }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
function sessionsOf(data: UsageData): SessionRow[] {
  return Object.entries(data.bySession)
    .map(([file, s]) => ({
      name: s.name || file.split("/").pop()!.replace(/\.jsonl$/, ""),
      kind: s.kind,
      calls: s.usage.calls,
      tokens: s.usage.tokens,
      cost: s.usage.cost,
    }))
    .sort((a, b) => b.cost.total - a.cost.total);
}

// ---------------------------------------------------------------------------
// dashboard component
// ---------------------------------------------------------------------------

class Dashboard {
  view: View;
  scroll = 0;
  onChange: () => void = () => {};
  onClose: () => void = () => {};
  private data: UsageData;
  private load: () => UsageData;
  private theme: Theme;
  private periodLabel: string;
  private cache?: { width: number; view: View; scroll: number; lines: string[] };

  constructor(view: View, theme: Theme, periodLabel: string, data: UsageData, load: () => UsageData) {
    this.view = view;
    this.theme = theme;
    this.periodLabel = periodLabel;
    this.data = data;
    this.load = load;
  }

  private listLength(): number {
    if (this.view === "days") return Object.keys(this.data.byDay).length;
    if (this.view === "sessions") return Object.keys(this.data.bySession).length;
    return Object.keys(this.data.byModel).length;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") { this.onClose(); return; }
    if (data === "r") {
      try { this.data = this.load(); } catch { /* keep stale data */ }
      this.scroll = 0;
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const i = VIEWS.indexOf(this.view);
      const next = matchesKey(data, Key.right) ? (i + 1) % VIEWS.length : (i - 1 + VIEWS.length) % VIEWS.length;
      this.view = VIEWS[next];
      this.scroll = 0;
      this.onChange();
      return;
    }
    if (/^[1-4]$/.test(data)) { this.view = VIEWS[parseInt(data, 10) - 1]; this.scroll = 0; this.onChange(); return; }
    if (matchesKey(data, Key.down) || data === "j") {
      const max = Math.max(0, this.listLength() - MAX_ROWS);
      if (this.scroll < max) { this.scroll++; this.onChange(); }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.scroll > 0) { this.scroll--; this.onChange(); }
      return;
    }
  }

  invalidate(): void { this.cache = undefined; }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width && this.cache.view === this.view && this.cache.scroll === this.scroll) {
      return this.cache.lines;
    }
    const lines = build(this.data, this.view, this.scroll, width, this.theme, this.periodLabel);
    this.cache = { width, view: this.view, scroll: this.scroll, lines };
    return lines;
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function build(data: UsageData, view: View, scroll: number, width: number, theme: Theme, periodLabel: string): string[] {
  const fg = (c: string, s: string) => theme.fg(c, s);
  const bold = (s: string) => theme.bold(s);
  const dim = (s: string) => theme.fg("dim", s);
  const sec = (t: string) => fg("accent", "▍") + " " + fg("accent", bold(t));

  const lines: string[] = [];
  const t = data.totals;
  const counts = data.sessionCounts;

  lines.push(fg("accent", bold("pi-usage")) + "  " + dim(`${view} · ${periodLabel} · ${counts.main} main · ${counts.subagent} sub`));
  lines.push("");
  lines.push(
    bold(compact(t.tokens.total)) + " " + dim("tokens") +
    "    " + fg("success", bold(money(t.cost.total))) + " " + dim("spent") +
    "    " + bold(String(t.calls)) + " " + dim("calls")
  );
  lines.push("");

  const slice = <T,>(arr: T[]): T[] => {
    const start = Math.min(scroll, Math.max(0, arr.length - MAX_ROWS));
    return arr.slice(start, start + MAX_ROWS);
  };
  const range = (n: number) => dim(`  ${Math.min(scroll, n - MAX_ROWS) + 1}–${Math.min(scroll + MAX_ROWS, n)} of ${n} · ↑↓ scroll`);

  if (view === "overview") {
    const models = modelsOf(data);
    const maxCost = Math.max(1e-9, ...models.map((m) => m.cost.total));
    const maxTok = Math.max(1e-9, ...models.map((m) => m.tokens.total));
    const nameW = 22, tokW = 6, costW = 8, pctW = 4;
    const fixed = 2 + nameW + 6 * 2 + tokW + pctW + costW + pctW;
    let barW = Math.max(0, Math.floor((width - fixed) / 2));
    if (barW < 3) barW = 0;
    const tokGroupW = tokW + (barW ? 2 + barW + 2 : 2) + pctW;
    const costGroupW = costW + (barW ? 2 + barW + 2 : 2) + pctW;

    lines.push(sec("By model"));
    lines.push("  " + dim(pad("MODEL", nameW)) + "  " + dim(pad("TOKENS", tokGroupW)) + "  " + dim(pad("COST", costGroupW)));
    if (models.length === 0) lines.push("  " + dim("no data"));
    for (const m of slice(models)) {
      const tokShare = m.tokens.total / maxTok;
      const costShare = m.cost.total / maxCost;
      let row = "  " + pad(truncate(m.key, nameW), nameW) + "  " + pad(compact(m.tokens.total), tokW, true);
      if (barW) { const b = bar(tokShare, barW); row += "  " + fg("accent", b.fill) + fg("dim", b.empty); }
      row += "  " + pad(dim(pct(tokShare * 100)), pctW, true);
      row += "  " + pad(fg("success", money(m.cost.total)), costW, true);
      if (barW) { const b = bar(costShare, barW); row += "  " + fg("success", b.fill) + fg("dim", b.empty); }
      row += "  " + pad(dim(pct(costShare * 100)), pctW, true);
      lines.push(row);
    }
    if (models.length > MAX_ROWS) lines.push(range(models.length));
  } else if (view === "models") {
    const models = modelsOf(data);
    const nameW = 28, callsW = 6, tokW = 8, costW = 9;
    lines.push(sec("Models"));
    lines.push("  " + dim(pad("MODEL", nameW)) + "  " + dim(pad("CALLS", callsW, true)) + "  " + dim(pad("TOKENS", tokW, true)) + "  " + dim(pad("COST", costW, true)));
    if (models.length === 0) lines.push("  " + dim("no data"));
    for (const m of slice(models)) {
      lines.push("  " + pad(truncate(m.key, nameW), nameW) + "  " + pad(String(m.calls), callsW, true) + "  " + pad(compact(m.tokens.total), tokW, true) + "  " + pad(fg("success", money(m.cost.total)), costW, true));
    }
    if (models.length > MAX_ROWS) lines.push(range(models.length));
  } else if (view === "days") {
    const days = daysOf(data);
    const maxCost = Math.max(1e-9, ...days.map((d) => d.cost.total));
    const dateW = 11, callsW = 5, tokW = 7, costW = 8;
    const fixed = 2 + dateW + 2 + callsW + 2 + tokW + 2 + costW + 2;
    const barW = Math.max(0, Math.min(40, width - fixed));
    lines.push(sec("By day"));
    lines.push("  " + dim(pad("DATE", dateW)) + "  " + dim(pad("CALLS", callsW, true)) + "  " + dim(pad("TOKENS", tokW, true)) + "  " + dim(pad("COST", costW, true)) + (barW ? "  " + dim(pad("", barW)) : ""));
    if (days.length === 0) lines.push("  " + dim("no data"));
    for (const d of slice(days)) {
      let row = "  " + pad(d.day, dateW) + "  " + pad(String(d.calls), callsW, true) + "  " + pad(compact(d.tokens.total), tokW, true) + "  " + pad(fg("success", money(d.cost.total)), costW, true);
      if (barW) { const b = bar(d.cost.total / maxCost, barW); row += "  " + fg("success", b.fill) + fg("dim", b.empty); }
      lines.push(row);
    }
    if (days.length > MAX_ROWS) lines.push(range(days.length));
  } else {
    const sessions = sessionsOf(data);
    const nameW = 30, callsW = 6, tokW = 8, costW = 9;
    lines.push(sec("Sessions"));
    lines.push("  " + dim(pad("SESSION", nameW)) + "  " + dim(pad("CALLS", callsW, true)) + "  " + dim(pad("TOKENS", tokW, true)) + "  " + dim(pad("COST", costW, true)));
    if (sessions.length === 0) lines.push("  " + dim("no data"));
    for (const s of slice(sessions)) {
      const tag = s.kind === "subagent" ? " ·sub" : "";
      lines.push("  " + pad(truncate(s.name, nameW), nameW) + "  " + pad(String(s.calls), callsW, true) + "  " + pad(compact(s.tokens.total), tokW, true) + "  " + pad(fg("success", money(s.cost.total)), costW, true) + dim(tag));
    }
    if (sessions.length > MAX_ROWS) lines.push(range(sessions.length));
  }

  lines.push("");
  lines.push(dim("  ← → view · 1-4 jump · ↑↓ scroll · r refresh · esc close"));

  return lines.map((l) => truncateToWidth(l, width));
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export default function usageCommand(pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Interactive usage dashboard (tokens / context / cost)",
    getArgumentCompletions: (prefix) => {
      const matches = SUGGESTIONS.filter((s) => s.startsWith(prefix));
      return matches.length ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const viewArg = (argv.find((a) => (VIEWS as readonly string[]).includes(a)) || "overview") as View;
      const all = argv.includes("--all");
      let since = 30;
      const si = argv.findIndex((a) => a === "--since");
      if (si >= 0) {
        const v = parseInt(argv[si + 1] || "", 10);
        if (Number.isFinite(v) && v >= 0) since = v;
      }
      const flag = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] || undefined : undefined;
      };
      const model = flag("--model");
      const provider = flag("--provider");
      const dir = flag("--dir");
      const periodLabel = all ? "all time" : `last ${since} day${since === 1 ? "" : "s"}`;

      const load = (): UsageData => toData(aggregate({ dir, all, since, model, provider }));

      let data: UsageData;
      try {
        data = load();
      } catch (e) {
        ctx.ui.notify(`pi-usage failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const dash = new Dashboard(viewArg, theme as Theme, periodLabel, data, load);
        dash.onChange = () => { dash.invalidate(); tui.requestRender(); };
        dash.onClose = () => done(undefined);
        return {
          render: (w: number) => dash.render(w),
          invalidate: () => dash.invalidate(),
          handleInput: (d: string) => dash.handleInput(d),
        };
      });
    },
  });
}
