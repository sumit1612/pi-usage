/**
 * /usage — interactive usage dashboard for pi.
 *
 * Renders token / context / cost usage from the shared core (../lib/core.js) as
 * a themed, interactive TUI component — matches pi's active theme.
 *
 * Loads once (single synchronous aggregate); view switching, scrolling, and
 * drill-down are in-memory, so it stays fast.
 *
 * Keys:
 *   ← / →       cycle views (overview / models / providers / agents / days / sessions)
 *   1..6        jump to a view
 *   ↑ / ↓       move selection (scrolls into view)
 *   enter       drill into the selected row (usage detail)
 *   esc         close detail, or close the dashboard
 *   q           close the dashboard
 *   r           refresh data
 *
 * Flags (passed to the core): --all, --since N, --model X, --provider Y, --dir P, --cwd P, --group G
 *
 * Also shows a live "this session" cost indicator in the footer, updated on
 * every assistant message_end event.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { aggregate, toData } from "../lib/core.js";
import type { UsageData, Usage } from "../lib/core.js";

const VIEWS = ["overview", "models", "providers", "agents", "days", "sessions"] as const;
type View = (typeof VIEWS)[number];
const SUGGESTIONS = [...VIEWS, "--all", "--since", "--model", "--provider", "--dir", "--cwd", "--group"];
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
function pct1(n: number): string {
  return (isFinite(n) ? n : 0).toFixed(1) + "%";
}
function rate(n: number): string {
  if (!isFinite(n)) return "$0";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
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

interface ModelRow { key: string; calls: number; tokens: Usage["tokens"]; cost: Usage["cost"]; cacheHitRate: number; reasoningRatio: number; costPer1M: number; }
interface DayRow { day: string; calls: number; tokens: Usage["tokens"]; cost: Usage["cost"]; }
interface SessionRow { key: string; name: string; kind: string; agent: string | null; cwd: string | null; started: string | null; calls: number; tokens: Usage["tokens"]; cost: Usage["cost"]; }

function modelsOf(data: UsageData): ModelRow[] {
  return Object.entries(data.byModel)
    .map(([key, v]) => ({ key, calls: v.calls, tokens: v.tokens, cost: v.cost, cacheHitRate: v.cacheHitRate, reasoningRatio: v.reasoningRatio, costPer1M: v.costPer1M }))
    .sort((a, b) => b.cost.total - a.cost.total);
}
function providersOf(data: UsageData): ModelRow[] {
  return Object.entries(data.byProvider)
    .map(([key, v]) => ({ key, calls: v.calls, tokens: v.tokens, cost: v.cost, cacheHitRate: v.cacheHitRate, reasoningRatio: v.reasoningRatio, costPer1M: v.costPer1M }))
    .sort((a, b) => b.cost.total - a.cost.total);
}
function agentsOf(data: UsageData): ModelRow[] {
  return Object.entries(data.byAgent)
    .map(([key, v]) => ({ key, calls: v.calls, tokens: v.tokens, cost: v.cost, cacheHitRate: v.cacheHitRate, reasoningRatio: v.reasoningRatio, costPer1M: v.costPer1M }))
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
      key: file,
      name: s.name || file.split("/").pop()!.replace(/\.jsonl$/, ""),
      kind: s.kind,
      agent: s.agent,
      cwd: s.cwd,
      started: s.started,
      calls: s.usage.calls,
      tokens: s.usage.tokens,
      cost: s.usage.cost,
    }))
    .sort((a, b) => b.cost.total - a.cost.total);
}

// a generic "row" used for selection + drill-down across list views
interface Row {
  key: string;
  label: string;
  sub: string;
  calls: number;
  tokens: Usage["tokens"];
  cost: Usage["cost"];
  cacheHitRate?: number;
  reasoningRatio?: number;
  costPer1M?: number;
  extra?: string[];
}

function rowsFor(view: View, data: UsageData): Row[] {
  if (view === "days") {
    return daysOf(data).map((d) => ({
      key: d.day, label: d.day, sub: "", calls: d.calls, tokens: d.tokens, cost: d.cost,
    }));
  }
  if (view === "sessions") {
    return sessionsOf(data).map((s) => ({
      key: s.key, label: s.name, sub: s.kind, calls: s.calls, tokens: s.tokens, cost: s.cost,
      extra: [s.kind, s.agent || "", s.cwd || "", s.started || ""],
    }));
  }
  const src = view === "providers" ? providersOf(data) : view === "agents" ? agentsOf(data) : modelsOf(data);
  return src.map((m) => ({
    key: m.key, label: m.key, sub: "", calls: m.calls, tokens: m.tokens, cost: m.cost,
    cacheHitRate: m.cacheHitRate, reasoningRatio: m.reasoningRatio, costPer1M: m.costPer1M,
  }));
}

// ---------------------------------------------------------------------------
// dashboard component
// ---------------------------------------------------------------------------

class Dashboard {
  view: View;
  scroll = 0;
  sel = 0;
  detail: string | null = null;
  onChange: () => void = () => {};
  onClose: () => void = () => {};
  private data: UsageData;
  private load: () => UsageData;
  private theme: Theme;
  private periodLabel: string;
  private cache?: { width: number; view: View; scroll: number; sel: number; detail: string | null; lines: string[] };

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
    if (this.view === "providers") return Object.keys(this.data.byProvider).length;
    if (this.view === "agents") return Object.keys(this.data.byAgent).length;
    return Object.keys(this.data.byModel).length;
  }

  handleInput(data: string): void {
    // detail mode: esc returns to the list
    if (this.detail) {
      if (matchesKey(data, Key.escape) || data === "q") {
        this.detail = null;
        this.onChange();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") { this.onClose(); return; }
    if (data === "r") {
      try { this.data = this.load(); } catch { /* keep stale data */ }
      this.scroll = 0; this.sel = 0;
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const rows = rowsFor(this.view, this.data);
      const row = rows[this.sel];
      if (row) {
        this.detail = row.key;
        this.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const i = VIEWS.indexOf(this.view);
      const next = matchesKey(data, Key.right) ? (i + 1) % VIEWS.length : (i - 1 + VIEWS.length) % VIEWS.length;
      this.view = VIEWS[next];
      this.scroll = 0; this.sel = 0;
      this.onChange();
      return;
    }
    if (/^[1-6]$/.test(data)) { this.view = VIEWS[parseInt(data, 10) - 1]; this.scroll = 0; this.sel = 0; this.onChange(); return; }
    const len = this.listLength();
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.sel < len - 1) {
        this.sel++;
        if (this.sel >= this.scroll + MAX_ROWS) this.scroll++;
        this.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.sel > 0) {
        this.sel--;
        if (this.sel < this.scroll) this.scroll--;
        this.onChange();
      }
      return;
    }
  }

  invalidate(): void { this.cache = undefined; }

  render(width: number): string[] {
    const key = `${width}|${this.view}|${this.scroll}|${this.sel}|${this.detail || ""}`;
    if (this.cache && this.cache.width === width && this.cache.view === this.view &&
        this.cache.scroll === this.scroll && this.cache.sel === this.sel && this.cache.detail === this.detail) {
      return this.cache.lines;
    }
    const lines = build(this.data, this.view, this.scroll, this.sel, this.detail, width, this.theme, this.periodLabel);
    this.cache = { width, view: this.view, scroll: this.scroll, sel: this.sel, detail: this.detail, lines };
    return lines;
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function build(
  data: UsageData,
  view: View,
  scroll: number,
  sel: number,
  detail: string | null,
  width: number,
  theme: Theme,
  periodLabel: string
): string[] {
  const fg = (c: string, s: string) => theme.fg(c, s);
  const bold = (s: string) => theme.bold(s);
  const dim = (s: string) => theme.fg("dim", s);
  const sec = (t: string) => fg("accent", "▍") + " " + fg("accent", bold(t));

  const lines: string[] = [];
  const t = data.totals;
  const counts = data.sessionCounts;

  lines.push(fg("accent", bold("pi-usage")) + "  " + dim(`${view} · ${periodLabel} · ${counts.main} main · ${counts.fork} fork · ${counts.subagent} sub`));
  lines.push("");

  // ---- detail panel ----
  if (detail) {
    const rows = rowsFor(view, data);
    const row = rows.find((r) => r.key === detail);
    if (row) {
      lines.push(sec("Detail"));
      lines.push("  " + bold(row.label));
      if (row.sub) lines.push("  " + dim(row.sub));
      for (const e of row.extra || []) if (e) lines.push("  " + dim(e));
      lines.push("");
      lines.push(
        bold(compact(row.tokens.total)) + " " + dim("tokens") +
        "    " + fg("success", bold(money(row.cost.total))) + " " + dim("spent") +
        "    " + bold(String(row.calls)) + " " + dim("calls")
      );
      lines.push("");
      const u = row.tokens, c = row.cost;
      lines.push("  " + pad("input", 12) + pad(compact(u.input), 10, true) + "  " + pad(money(c.input), 10, true));
      lines.push("  " + pad("output", 12) + pad(compact(u.output), 10, true) + "  " + pad(money(c.output), 10, true));
      lines.push("  " + pad("cache read", 12) + pad(compact(u.cacheRead), 10, true) + "  " + pad(money(c.cacheRead), 10, true));
      lines.push("  " + pad("cache write", 12) + pad(compact(u.cacheWrite), 10, true) + "  " + pad(money(c.cacheWrite), 10, true));
      lines.push("  " + pad("reasoning", 12) + pad(compact(u.reasoning), 10, true));
      lines.push("  " + pad("context", 12) + pad(compact(u.context), 10, true));
      lines.push("  " + pad("total", 12) + pad(compact(u.total), 10, true) + "  " + pad(money(c.total), 10, true));
      if (row.cacheHitRate !== undefined) {
        lines.push("");
        lines.push("  " + dim("cache hit") + "  " + fg("accent", pct1(row.cacheHitRate * 100)) +
          "    " + dim("reasoning") + "  " + fg("warning", pct1((row.reasoningRatio || 0) * 100)) +
          "    " + dim("$/1M") + "  " + fg("success", rate(row.costPer1M || 0)));
      }
      lines.push("");
      lines.push(dim("  esc back · q close"));
    }
    return lines.map((l) => truncateToWidth(l, width));
  }

  lines.push(
    bold(compact(t.tokens.total)) + " " + dim("tokens") +
    "    " + fg("success", bold(money(t.cost.total))) + " " + dim("spent") +
    "    " + bold(String(t.calls)) + " " + dim("calls") +
    "    " + fg("accent", pct1(t.cacheHitRate * 100)) + " " + dim("cache hit") +
    "    " + fg("success", rate(t.costPer1M)) + " " + dim("$/1M")
  );
  lines.push("");

  const rows = rowsFor(view, data);
  const slice = <T,>(arr: T[]): T[] => {
    const start = Math.min(scroll, Math.max(0, arr.length - MAX_ROWS));
    return arr.slice(start, start + MAX_ROWS);
  };
  const range = (n: number) => dim(`  ${Math.min(scroll, n - MAX_ROWS) + 1}–${Math.min(scroll + MAX_ROWS, n)} of ${n} · ↑↓ select`);

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
    for (const m of models.slice(0, 6)) {
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
  } else {
    const titles: Record<string, string> = {
      models: "Models", providers: "Providers", agents: "Agents", days: "Days", sessions: "Sessions",
    };
    const isDays = view === "days";
    const isSessions = view === "sessions";
    const nameW = isDays ? 11 : isSessions ? 28 : 26;
    const callsW = 6, tokW = 8, costW = 9, cacheW = 7, perMW = 7;
    let head = "  " + dim(pad(isDays ? "DATE" : isSessions ? "SESSION" : view === "agents" ? "AGENT" : view === "providers" ? "PROVIDER" : "MODEL", nameW)) +
      "  " + dim(pad("CALLS", callsW, true)) + "  " + dim(pad("TOKENS", tokW, true));
    if (view === "models" || view === "providers") head += "  " + dim(pad("CACHE%", cacheW, true)) + "  " + dim(pad("$/1M", perMW, true));
    head += "  " + dim(pad("COST", costW, true));
    lines.push(sec(titles[view] || view));
    lines.push(head);
    if (rows.length === 0) lines.push("  " + dim("no data"));

    for (const [i, r] of slice(rows).entries()) {
      const absIdx = Math.min(scroll, Math.max(0, rows.length - MAX_ROWS)) + i;
      const cursor = absIdx === sel ? fg("accent", ">") : " ";
      let line = "  " + cursor + " " + pad(truncate(r.label, nameW), nameW) +
        "  " + pad(String(r.calls), callsW, true) + "  " + pad(compact(r.tokens.total), tokW, true);
      if (view === "models" || view === "providers") {
        line += "  " + pad(pct1((r.cacheHitRate || 0) * 100), cacheW, true) + "  " + pad(rate(r.costPer1M || 0), perMW, true);
      }
      line += "  " + pad(fg("success", money(r.cost.total)), costW, true);
      if (isSessions) {
        const tag = r.sub === "fork" ? "·fork" : r.sub === "subagent" ? "·sub" : "";
        line += dim(tag);
      }
      lines.push(line);
    }
    if (rows.length > MAX_ROWS) lines.push(range(rows.length));
  }

  lines.push("");
  lines.push(dim("  ← → view · 1-6 jump · ↑↓ select · enter detail · r refresh · esc close"));

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
      const cwd = flag("--cwd");
      const groupRaw = flag("--group");
      const group = groupRaw && ["day", "week", "month"].includes(groupRaw) ? groupRaw as "day" | "week" | "month" : "day";
      const periodLabel = all ? "all time" : `last ${since} day${since === 1 ? "" : "s"}`;

      const load = (): UsageData => toData(aggregate({ dir, all, since, model, provider, cwd, group }));

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

  // Live "this session" cost indicator in the footer.
  let live = { calls: 0, tokens: 0, cost: 0 };
  pi.on("session_start", (_event, ctx) => {
    live = { calls: 0, tokens: 0, cost: 0 };
    ctx.ui.setStatus("pi-usage", "");
  });
  pi.on("message_end", (event, ctx) => {
    if ((event as { message?: { role?: string; usage?: unknown } }).message?.role !== "assistant") return;
    const u = (event as { message?: { usage?: Record<string, unknown> } }).message?.usage as Record<string, unknown> | undefined;
    if (!u) return;
    live.calls += 1;
    const tt = typeof u.totalTokens === "number" ? u.totalTokens
      : (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    live.tokens += tt;
    const c = u.cost;
    live.cost += typeof c === "number" ? c : ((c as { total?: number })?.total ?? 0);
    const label = `${compact(live.tokens)} tok · $${live.cost.toFixed(3)}`;
    try {
      ctx.ui.setStatus("pi-usage", (ctx.ui as unknown as { theme?: Theme }).theme?.fg("success", label) ?? label);
    } catch {
      ctx.ui.setStatus("pi-usage", label);
    }
  });
}
