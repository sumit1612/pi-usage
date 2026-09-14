'use strict';

/**
 * pi-usage core — shared aggregation engine.
 *
 * Scans pi session JSONL files and sums token / context / cost usage. Used by
 * both the CLI (bin/pi-usage) and the /usage extension (extensions/usage.ts),
 * so the numbers always agree.
 *
 * Correctness notes (see README "How it counts"):
 *  - Only assistant / compaction / branch-summary usage is counted. Tool results
 *    (which can embed a *summary* of subagent usage) are ignored to avoid
 *    double-counting.
 *  - Forked sessions copy their parent's history with identical entry ids. We
 *    dedupe assistant entries by entry id so shared history is counted once.
 *  - Subagent runs may be stored twice (an artifact transcript AND a
 *    run-N/session.jsonl). We prefer the canonical session.jsonl per runId and
 *    skip the transcript when it exists, so a run is never counted twice.
 *  - Subagent transcripts use a different schema: top-level `usage`, `recordType`,
 *    and a *numeric* `cost`. We normalize both shapes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

function* walkJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Normalize a raw usage object into the canonical shape. Handles:
 *  - `cost` as an object (standard) or as a plain number (subagent transcripts).
 *  - missing `reasoning` / `totalTokens` (older or transcript entries).
 */
function normalizeUsage(raw) {
  const u = raw || {};
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const reasoning = num(u.reasoning);
  const totalTokens =
    u.totalTokens != null && Number.isFinite(u.totalTokens)
      ? num(u.totalTokens)
      : input + output + cacheRead + cacheWrite + reasoning;

  let cost;
  if (typeof u.cost === 'number') {
    cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: num(u.cost) };
  } else if (u.cost && typeof u.cost === 'object') {
    const cin = num(u.cost.input);
    const cout = num(u.cost.output);
    const cr = num(u.cost.cacheRead);
    const cw = num(u.cost.cacheWrite);
    cost = {
      input: cin,
      output: cout,
      cacheRead: cr,
      cacheWrite: cw,
      total:
        u.cost.total != null && Number.isFinite(u.cost.total) ? num(u.cost.total) : cin + cout + cr + cw,
    };
  } else {
    cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }

  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost };
}

function emptyUsage() {
  return {
    calls: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      context: 0,
      total: 0,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    // derived metrics (computed in finalize)
    cacheHitRate: 0,
    reasoningRatio: 0,
    costPer1M: 0,
    avgTokensPerCall: 0,
  };
}

function addUsage(agg, u) {
  const t = agg.tokens;
  const c = agg.cost;
  agg.calls += 1;
  t.input += u.input;
  t.output += u.output;
  t.cacheRead += u.cacheRead;
  t.cacheWrite += u.cacheWrite;
  t.reasoning += u.reasoning;
  t.total += u.totalTokens;
  c.input += u.cost.input;
  c.output += u.cost.output;
  c.cacheRead += u.cost.cacheRead;
  c.cacheWrite += u.cost.cacheWrite;
  c.total += u.cost.total;
}

// context = input + cacheRead + cacheWrite (tokens resident in the request);
// plus derived efficiency metrics.
function finalize(u) {
  u.tokens.context = u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite;
  const t = u.tokens;
  const resident = t.input + t.cacheRead + t.cacheWrite;
  u.cacheHitRate = resident > 0 ? t.cacheRead / resident : 0;
  u.reasoningRatio = t.total > 0 ? t.reasoning / t.total : 0;
  u.costPer1M = t.total > 0 ? (u.cost.total * 1e6) / t.total : 0;
  u.avgTokensPerCall = u.calls > 0 ? t.total / u.calls : 0;
  return u;
}

function tsToMs(ts) {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = Date.parse(ts);
    if (!isNaN(d)) return d;
  }
  return null;
}

function dayKey(tsMs, group) {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (group === 'month') return `${y}-${m}`;
  if (group === 'week') {
    // ISO-8601 week number
    const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dow = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dow);
    const isoYear = tmp.getUTCFullYear();
    const isoWeek = Math.ceil(
      ((tmp - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7
    );
    return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
  }
  return `${y}-${m}-${day}`;
}

/**
 * Classify a JSONL file by its first (non-empty) line and relative path.
 * Returns null for files we don't recognize.
 */
function classifyFile(rel, firstLine) {
  const segs = rel.split(path.sep).filter(Boolean);
  const joined = segs.join(path.sep);
  const head = parseLine(firstLine);
  if (!head) return null;

  // Subagent artifact transcript: no `type`, has `recordType`.
  if (head.type == null && typeof head.recordType === 'string') {
    return { kind: 'transcript', runId: head.runId || null, agent: head.agent || null, header: null };
  }

  if (head.type !== 'session') return null;
  const header = head;

  // Fork / clone: explicit parentSession header, or nested under forks/.
  if (header.parentSession || joined.includes(`forks${path.sep}`)) {
    return { kind: 'fork', header, runId: null, agent: null };
  }

  // Subagent session: <cwd>/<mainSession>/<runId>/run-<n>/session.jsonl
  if (/run-\d+\/session\.jsonl$/.test(joined)) {
    const runId = segs.length >= 3 ? segs[segs.length - 3] : null;
    return { kind: 'subagent-session', header, runId, agent: null };
  }

  // Top-level main session: <cwd>/<file>.jsonl
  if (segs.length === 2) return { kind: 'main', header, runId: null, agent: null };

  // Any other nested session file we didn't recognize: treat as a subagent session.
  return { kind: 'subagent-session', header, runId: null, agent: null };
}

function matchesCwd(sessionCwd, filterCwd) {
  if (!filterCwd) return true;
  if (!sessionCwd) return false;
  return sessionCwd === filterCwd || sessionCwd.startsWith(filterCwd + path.sep);
}

function usageFromSessionEntry(entry) {
  if (entry.type === 'message' && entry.message) {
    const m = entry.message;
    if (m.role === 'assistant' && m.usage) {
      return {
        usage: normalizeUsage(m.usage),
        model: m.model || null,
        provider: m.provider || null,
        api: m.api || null,
        ts: tsToMs(entry.timestamp),
      };
    }
    if ((m.role === 'compactionSummary' || m.role === 'branchSummary') && m.usage) {
      return {
        usage: normalizeUsage(m.usage),
        model: null,
        provider: null,
        api: null,
        ts: tsToMs(entry.timestamp),
      };
    }
    return null;
  }
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
    return {
      usage: normalizeUsage(entry.usage),
      model: null,
      provider: null,
      api: null,
      ts: tsToMs(entry.timestamp),
    };
  }
  return null;
}

/**
 * Add one counted usage record to the aggregate (applying time/model/provider
 * filters first). `session` is the current session bucket, `agent` is the
 * subagent agent name (or null).
 */
function countUsage(agg, session, got, opts, agent) {
  if (got.ts != null && got.ts < opts.sinceMs) return;
  // Resolve provider for transcript entries that only carry a bare model id
  // (subagent transcripts omit provider). Falls back to a known mapping.
  const candidates = agg.modelProviders.get(got.model);
  const provider = got.provider || (candidates?.size === 1 ? [...candidates][0] : null);
  const key = got.model ? `${provider || '?'}/${got.model}` : 'summary';
  if (opts.modelFilter && !key.toLowerCase().includes(opts.modelFilter)) return;
  if (opts.providerFilter && !(provider || '').toLowerCase().includes(opts.providerFilter)) return;

  addUsage(agg.totals, got.usage);
  addUsage(session.usage, got.usage);

  if (!agg.byModel.has(key)) agg.byModel.set(key, emptyUsage());
  addUsage(agg.byModel.get(key), got.usage);

  if (provider) {
    if (!agg.byProvider.has(provider)) agg.byProvider.set(provider, emptyUsage());
    addUsage(agg.byProvider.get(provider), got.usage);
  }

  if (got.api) {
    // Key by provider/api so the API breakdown labels reconcile with the
    // Providers view (e.g. "deepseek/openai-completions" instead of the bare
    // protocol name "openai-completions", which reads as an OpenAI provider).
    const label = provider ? `${provider}/${got.api}` : got.api;
    const a = agg.apiBreakdown.get(label) || { calls: 0, tokens: 0 };
    a.calls += 1;
    a.tokens += got.usage.totalTokens;
    agg.apiBreakdown.set(label, a);
  }

  if (agent) {
    if (!agg.byAgent.has(agent)) agg.byAgent.set(agent, emptyUsage());
    addUsage(agg.byAgent.get(agent), got.usage);
  }

  const day = dayKey(got.ts != null ? got.ts : Date.now(), opts.group);
  if (!agg.byDay.has(day)) agg.byDay.set(day, emptyUsage());
  addUsage(agg.byDay.get(day), got.usage);
}

/**
 * Process a standard session-format file (main, fork, or subagent session).
 * Returns true if the session passed the cwd filter (regardless of usage).
 */
function processSessionFile(info, agg, opts, seen, seenSwitch, agent) {
  const { file, kind, header } = info;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  const session = {
    file,
    kind,
    name: null,
    cwd: header.cwd || null,
    started: header.timestamp || null,
    parentSession: header.parentSession || null,
    agent: agent || null,
    usage: emptyUsage(),
  };

  if (!matchesCwd(session.cwd, opts.cwd)) return false;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;

    if (entry.type === 'session') {
      session.cwd = entry.cwd || session.cwd;
      session.started = entry.timestamp || session.started;
      continue;
    }
    if (entry.type === 'session_info' && entry.name) session.name = entry.name;

    const identity = entry.id ? JSON.stringify([info.lineage, entry.id]) : null;
    if (entry.type === 'model_change') {
      // Only user-facing sessions (main/fork) count as model *switches*;
      // subagent model selections are initializations, not switches.
      if (kind !== 'subagent' && identity && !seenSwitch.has(identity)) {
        seenSwitch.add(identity);
        agg.modelSwitches += 1;
      }
      continue;
    }

    const got = usageFromSessionEntry(entry);
    if (!got) continue;

    // Entry IDs are only meaningful within a verified parent/fork lineage.
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);

    countUsage(agg, session, got, opts, agent);
  }

  if (session.usage.calls > 0) {
    finalize(session.usage);
    agg.bySession.set(session.file, session);
  }
  return true;
}

/**
 * Process a subagent artifact transcript (recordType-based schema, top-level
 * usage, possibly numeric cost). Returns true if the cwd filter passed.
 */
function processTranscript(info, agg, opts) {
  const { file, runId, agent } = info;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  const session = {
    file,
    kind: 'subagent',
    name: agent || null,
    cwd: null,
    started: null,
    parentSession: null,
    agent: agent || null,
    usage: emptyUsage(),
  };

  // Transcripts have no session header; resolve cwd from the first record
  // so the --cwd filter can be applied before any usage is counted.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const d = parseLine(line);
    if (d && d.cwd) { session.cwd = d.cwd; break; }
  }
  if (!matchesCwd(session.cwd, opts.cwd)) return false;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const d = parseLine(line);
    if (!d) continue;
    if (d.recordType !== 'message') continue;
    if (d.role !== 'assistant' || !d.usage) continue;
    if (session.started == null && (d.timestamp || d.ts != null)) {
      session.started = d.timestamp || (d.ts != null ? new Date(d.ts).toISOString() : null);
    }

    const got = {
      usage: normalizeUsage(d.usage),
      model: d.message?.model || d.model || null,
      provider: d.message?.provider || d.provider || null,
      api: d.message?.api || d.api || null,
      ts: tsToMs(d.ts != null ? d.ts : d.timestamp),
    };
    countUsage(agg, session, got, opts, d.agent || agent || null);
  }

  if (session.usage.calls > 0) {
    finalize(session.usage);
    agg.bySession.set(session.file, session);
  }
  return matchesCwd(session.cwd, opts.cwd);
}

/**
 * Aggregate usage across all sessions under `opts.dir`.
 * @param {object} [opts]
 * @param {string} [opts.dir]         session dir (default ~/.pi/agent/sessions)
 * @param {boolean} [opts.all]        include all time (default false)
 * @param {number} [opts.since]       last N days (default 30)
 * @param {string} [opts.model]       filter by model substring
 * @param {string} [opts.provider]    filter by provider substring
 * @param {string} [opts.cwd]         filter by project working directory
 * @param {string} [opts.group]       day | week | month (default day)
 */
function aggregate(opts = {}) {
  const dir = opts.dir || process.env.PI_SESSION_DIR || DEFAULT_SESSION_DIR;
  const all = !!opts.all;
  const since = Number.isFinite(opts.since) && opts.since >= 0 ? opts.since : 30;
  const group = ['day', 'week', 'month'].includes(opts.group) ? opts.group : 'day';
  const effOpts = {
    sinceMs: all ? 0 : Date.now() - since * 24 * 60 * 60 * 1000,
    modelFilter: (opts.model || '').toLowerCase(),
    providerFilter: (opts.provider || '').toLowerCase(),
    cwd: opts.cwd ? path.resolve(String(opts.cwd)) : null,
    group,
  };

  const agg = {
    totals: emptyUsage(),
    byModel: new Map(),
    byProvider: new Map(),
    byAgent: new Map(),
    byDay: new Map(),
    bySession: new Map(),
    modelSwitches: 0,
    apiBreakdown: new Map(),
    modelProviders: new Map(),
    sessionsMain: 0,
    sessionsFork: 0,
    sessionsSubagent: 0,
  };

  if (!fs.existsSync(dir)) {
    const err = new Error(`Session directory not found: ${dir}`);
    err.code = 'ENOENT';
    throw err;
  }

  const root = path.resolve(dir);

  // Discover + classify all files.
  const mains = [];
  const subSessions = [];
  const transcripts = [];
  for (const file of walkJsonl(root)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const first = text.split('\n').find((l) => l.trim()) || '';
    const cls = classifyFile(path.relative(root, file), first.trim());
    if (!cls) continue;
    // Collect all explicit provider evidence before filtering or counting.
    // A model name shared across providers must remain ambiguous.
    for (const line of text.split('\n')) {
      const record = parseLine(line);
      if (!record) continue;
      const message = record.message || record;
      if (message.role !== 'assistant') continue;
      const model = message.model || record.model;
      const provider = message.provider || record.provider;
      if (!model || !provider) continue;
      if (!agg.modelProviders.has(model)) agg.modelProviders.set(model, new Set());
      agg.modelProviders.get(model).add(provider);
    }
    if (cls.kind === 'main' || cls.kind === 'fork') {
      mains.push({ file, kind: cls.kind, header: cls.header });
    } else if (cls.kind === 'subagent-session') {
      subSessions.push({ file, kind: 'subagent', header: cls.header, runId: cls.runId });
    } else {
      transcripts.push({ file, runId: cls.runId, agent: cls.agent });
    }
  }

  // Resolve explicit parent links only among discovered session headers.
  // Missing parents and cycles stay isolated rather than risking lost usage.
  const sessionsByPath = new Map([...mains, ...subSessions].map(s => [path.resolve(s.file), s]));
  for (const session of sessionsByPath.values()) {
    let current = session;
    const visited = new Set();
    session.lineage = path.resolve(session.file);
    while (!visited.has(current.file)) {
      visited.add(current.file);
      const parent = current.header.parentSession;
      if (!parent) { session.lineage = path.resolve(current.file); break; }
      const parentPath = path.isAbsolute(parent) ? parent : path.resolve(path.dirname(current.file), parent);
      const next = sessionsByPath.get(parentPath);
      if (!next) break;
      current = next;
    }
  }

  // runId -> agent (from transcript names), and runIds that already have a
  // canonical session.jsonl (so their transcripts are skipped).
  const runAgent = new Map();
  for (const t of transcripts) if (t.runId && t.agent) runAgent.set(t.runId, t.agent);
  const runHasSession = new Set(subSessions.map((s) => s.runId).filter(Boolean));

  // Process parents before forks so shared (copied) history is attributed to
  // the parent session and only a fork's *new* work is attributed to the fork.
  // (Totals are deduped regardless of order, but per-session attribution isn't.)
  mains.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1;
    const ta = tsToMs(a.header.timestamp) || 0;
    const tb = tsToMs(b.header.timestamp) || 0;
    return ta - tb;
  });

  const seen = new Set();
  const seenSwitch = new Set();

  for (const m of mains) {
    if (processSessionFile(m, agg, effOpts, seen, seenSwitch, null)) {
      if (m.kind === 'fork') agg.sessionsFork += 1;
      else agg.sessionsMain += 1;
    }
  }
  for (const s of subSessions) {
    const agent = (s.runId && runAgent.get(s.runId)) || null;
    if (processSessionFile(s, agg, effOpts, seen, seenSwitch, agent)) {
      agg.sessionsSubagent += 1;
    }
  }
  for (const t of transcripts) {
    if (t.runId && runHasSession.has(t.runId)) continue; // canonical session file already counted
    if (processTranscript(t, agg, effOpts)) {
      agg.sessionsSubagent += 1;
    }
  }

  finalize(agg.totals);
  for (const v of agg.byModel.values()) finalize(v);
  for (const v of agg.byProvider.values()) finalize(v);
  for (const v of agg.byAgent.values()) finalize(v);
  for (const v of agg.byDay.values()) finalize(v);
  return agg;
}

/**
 * Convert an aggregate result into plain JSON-serializable data (the shape
 * consumed by the /usage extension and `pi-usage --json`).
 */
function toData(agg) {
  return {
    totals: agg.totals,
    byModel: Object.fromEntries([...agg.byModel.entries()]),
    byProvider: Object.fromEntries([...agg.byProvider.entries()]),
    byAgent: Object.fromEntries([...agg.byAgent.entries()]),
    byDay: Object.fromEntries([...agg.byDay.entries()].sort()),
    bySession: Object.fromEntries(
      [...agg.bySession.entries()].map(([k, s]) => [
        k,
        { name: s.name, kind: s.kind, cwd: s.cwd, started: s.started, agent: s.agent, usage: s.usage },
      ])
    ),
    modelSwitches: agg.modelSwitches,
    apiBreakdown: Object.fromEntries([...agg.apiBreakdown.entries()]),
    sessionCounts: {
      main: agg.sessionsMain,
      fork: agg.sessionsFork,
      subagent: agg.sessionsSubagent,
    },
  };
}

module.exports = { aggregate, toData, normalizeUsage, DEFAULT_SESSION_DIR };
