'use strict';

/**
 * pi-usage core — shared aggregation engine.
 *
 * Scans pi session JSONL files and sums token / context / cost usage. Used by
 * both the CLI (bin/pi-usage) and the /usage extension (extensions/usage.ts),
 * so the numbers always agree.
 *
 * Only assistant / compaction / branch_summary usage is counted. Tool results
 * (which can embed a *summary* of subagent usage) are ignored to avoid
 * double-counting; subagent turns are read from their own session files.
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

function isSessionHeader(line) {
  try {
    return JSON.parse(line).type === 'session';
  } catch {
    return false;
  }
}

function emptyUsage() {
  return {
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, context: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// context = input + cacheRead + cacheWrite (tokens resident in the request)
function finalize(usage) {
  usage.tokens.context = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  return usage;
}

function addUsage(agg, u) {
  const t = agg.tokens;
  const cst = agg.cost;
  agg.calls += 1;
  t.input += u.input || 0;
  t.output += u.output || 0;
  t.cacheRead += u.cacheRead || 0;
  t.cacheWrite += u.cacheWrite || 0;
  t.reasoning += u.reasoning || 0;
  t.total += u.totalTokens ?? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  const cost = u.cost || {};
  cst.input += cost.input || 0;
  cst.output += cost.output || 0;
  cst.cacheRead += cost.cacheRead || 0;
  cst.cacheWrite += cost.cacheWrite || 0;
  cst.total += cost.total ?? (cost.input || 0) + (cost.output || 0) + (cost.cacheRead || 0) + (cost.cacheWrite || 0);
}

function usageFromEntry(entry) {
  if (entry.type === 'message' && entry.message && entry.message.role === 'assistant' && entry.message.usage) {
    return { usage: entry.message.usage, model: entry.message.model, provider: entry.message.provider, ts: entry.timestamp };
  }
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
    return { usage: entry.usage, model: null, provider: null, ts: entry.timestamp };
  }
  return null;
}

function tsToMs(ts) {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = Date.parse(ts);
    if (!isNaN(d)) return d;
  }
  return null;
}

/**
 * Aggregate usage across all sessions under `opts.dir`.
 * @param {object} [opts]
 * @param {string} [opts.dir]         session dir (default ~/.pi/agent/sessions)
 * @param {boolean} [opts.all]        include all time (default false)
 * @param {number} [opts.since]       last N days (default 30)
 * @param {string} [opts.model]       filter by model substring
 * @param {string} [opts.provider]    filter by provider substring
 */
function aggregate(opts = {}) {
  const dir = opts.dir || process.env.PI_SESSION_DIR || DEFAULT_SESSION_DIR;
  const all = !!opts.all;
  const since = Number.isFinite(opts.since) && opts.since >= 0 ? opts.since : 30;
  const modelFilter = (opts.model || '').toLowerCase();
  const providerFilter = (opts.provider || '').toLowerCase();

  const agg = {
    totals: emptyUsage(),
    byModel: new Map(),
    byDay: new Map(),
    bySession: new Map(),
    sessionsMain: 0,
    sessionsSubagent: 0,
  };

  if (!fs.existsSync(dir)) {
    const err = new Error(`Session directory not found: ${dir}`);
    err.code = 'ENOENT';
    throw err;
  }

  const now = Date.now();
  const sinceMs = all ? 0 : now - since * 24 * 60 * 60 * 1000;
  const root = path.resolve(dir);

  for (const file of walkJsonl(root)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    if (!lines.length || !isSessionHeader(lines[0].trim())) continue;

    const rel = path.relative(root, file);
    const depth = rel.split(path.sep).filter(Boolean).length;
    const kind = depth === 2 ? 'main' : 'subagent';
    if (kind === 'main') agg.sessionsMain++;
    else agg.sessionsSubagent++;

    const session = { file, kind, name: null, cwd: null, started: null, usage: emptyUsage() };

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'session') {
        session.cwd = entry.cwd;
        session.started = entry.timestamp;
        continue;
      }
      if (entry.type === 'session_info' && entry.name) session.name = entry.name;

      const got = usageFromEntry(entry);
      if (!got) continue;

      const ts = tsToMs(got.ts);
      if (ts != null && ts < sinceMs) continue;

      const key = got.model ? `${got.provider || '?'}/${got.model}` : 'summary';
      if (modelFilter && !key.toLowerCase().includes(modelFilter)) continue;
      if (providerFilter && !(got.provider || '').toLowerCase().includes(providerFilter)) continue;

      const um = got.usage;
      addUsage(agg.totals, um);
      addUsage(session.usage, um);

      if (!agg.byModel.has(key)) agg.byModel.set(key, { provider: got.provider || null, model: got.model || null, usage: emptyUsage() });
      addUsage(agg.byModel.get(key).usage, um);

      const day = (got.ts ? new Date(ts).toISOString() : new Date(now)).slice(0, 10);
      if (!agg.byDay.has(day)) agg.byDay.set(day, emptyUsage());
      addUsage(agg.byDay.get(day), um);
    }

    if (session.usage.calls > 0) {
      finalize(session.usage);
      agg.bySession.set(session.file, session);
    }
  }

  finalize(agg.totals);
  for (const v of agg.byModel.values()) finalize(v.usage);
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
    byModel: Object.fromEntries([...agg.byModel.entries()].map(([k, v]) => [k, v.usage])),
    byDay: Object.fromEntries([...agg.byDay.entries()].sort()),
    bySession: Object.fromEntries(
      [...agg.bySession.entries()].map(([k, s]) => [k, { name: s.name, kind: s.kind, cwd: s.cwd, started: s.started, usage: s.usage }])
    ),
    sessionCounts: { main: agg.sessionsMain, subagent: agg.sessionsSubagent },
  };
}

module.exports = { aggregate, toData, DEFAULT_SESSION_DIR };
