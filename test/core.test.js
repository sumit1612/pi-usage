'use strict';

/**
 * pi-usage core tests. Builds a tiny session directory with the tricky real-world
 * shapes the aggregator must handle:
 *   - a forked session that copies its parent's history (same entry ids)
 *   - a subagent run stored twice (artifact transcript + run-N/session.jsonl)
 *   - a transcript-only subagent with *numeric* cost and no totalTokens
 *   - a model_change event copied into the fork
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate, toData } = require('../lib/core.js');

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-test-'));
  const proj = path.join(dir, '--proj--');

  // --- main session (2 assistant entries + 1 model change) ---
  writeJsonl(path.join(proj, 'main.jsonl'), [
    { type: 'session', version: 3, id: 'MAIN', timestamp: '2026-01-05T10:00:00Z', cwd: '/proj' },
    { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-01-05T10:00:01Z', provider: 'p1', modelId: 'm1' },
    {
      type: 'message', id: 'a1', parentId: null, timestamp: '2026-01-05T10:01:00Z',
      message: {
        role: 'assistant', model: 'm1', provider: 'p1', api: 'openai-completions',
        usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, reasoning: 10, totalTokens: 360, cost: { input: 0.10, output: 0.20, cacheRead: 0.30, cacheWrite: 0, total: 0.60 } },
      },
    },
    {
      type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-01-05T10:02:00Z',
      message: {
        role: 'assistant', model: 'm1', provider: 'p1', api: 'openai-completions',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
      },
    },
  ]);

  // --- fork: copies a1 + a2 (same ids) + a3 (new) ---
  writeJsonl(path.join(proj, 'main', 'forks', 'fork.jsonl'), [
    { type: 'session', version: 3, id: 'FORK', timestamp: '2026-01-05T11:00:00Z', cwd: '/proj', parentSession: path.join(proj, 'main.jsonl') },
    { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-01-05T10:00:01Z', provider: 'p1', modelId: 'm1' },
    {
      type: 'message', id: 'a1', parentId: null, timestamp: '2026-01-05T10:01:00Z',
      message: {
        role: 'assistant', model: 'm1', provider: 'p1', api: 'openai-completions',
        usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, reasoning: 10, totalTokens: 360, cost: { input: 0.10, output: 0.20, cacheRead: 0.30, cacheWrite: 0, total: 0.60 } },
      },
    },
    {
      type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-01-05T10:02:00Z',
      message: {
        role: 'assistant', model: 'm1', provider: 'p1', api: 'openai-completions',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
      },
    },
    {
      type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-01-05T11:01:00Z',
      message: {
        role: 'assistant', model: 'm1', provider: 'p1', api: 'openai-completions',
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
      },
    },
  ]);

  // --- subagent run1: stored BOTH as transcript and session.jsonl ---
  writeJsonl(path.join(proj, 'main', 'run1', 'run-0', 'session.jsonl'), [
    { type: 'session', version: 3, id: 'SUB1', timestamp: '2026-01-05T12:00:00Z', cwd: '/proj' },
    {
      type: 'message', id: 's1', parentId: null, timestamp: '2026-01-05T12:01:00Z',
      message: {
        role: 'assistant', model: 'm2', provider: 'p2', api: 'openai-completions',
        usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } },
      },
    },
  ]);
  writeJsonl(path.join(proj, 'subagent-artifacts', 'run1_worker_0_transcript.jsonl'), [
    { version: 1, recordType: 'message', runId: 'run1', agent: 'worker', role: 'user', timestamp: '2026-01-05T12:00:00Z', cwd: '/proj', text: 'task' },
    {
      version: 1, recordType: 'message', runId: 'run1', agent: 'worker', role: 'assistant', model: 'm2', timestamp: '2026-01-05T12:01:00Z', cwd: '/proj',
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
    },
  ]);

  // --- subagent run2: transcript-only, numeric cost, no totalTokens ---
  writeJsonl(path.join(proj, 'subagent-artifacts', 'run2_scout_0_transcript.jsonl'), [
    { version: 1, recordType: 'message', runId: 'run2', agent: 'scout', role: 'assistant', model: 'm3', timestamp: '2026-01-05T12:02:00Z', cwd: '/proj', usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.08 } },
  ]);

  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('aggregates with fork dedup, subagent dedup, and numeric-cost transcripts', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agg = aggregate({ all: true, dir });
    const d = toData(agg);

    // 5 counted calls: a1, a2, a3(fork-only), s1(sub session), run2(transcript-only)
    assert.equal(d.totals.calls, 5);
    assert.equal(d.totals.tokens.total, 360 + 15 + 10 + 30 + 40);
    assert.ok(Math.abs(d.totals.cost.total - 0.78) < 1e-9, `cost ${d.totals.cost.total} != 0.78`);

    // session counts: 1 main, 1 fork, 2 subagents (run1 session + run2 transcript)
    assert.deepEqual(d.sessionCounts, { main: 1, fork: 1, subagent: 2 });

    // model switches deduped across fork (mc1 counted once)
    assert.equal(d.modelSwitches, 1);
  } finally {
    cleanup();
  }
});

test('fork history is not double-counted; fork-only work is attributed', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agg = aggregate({ all: true, dir });
    const d = toData(agg);

    // p1/m1 = a1 + a2 + a3 (3 calls), not 5 (a1+a2 would be double-counted from fork)
    const m1 = d.byModel['p1/m1'];
    assert.ok(m1, 'p1/m1 bucket exists');
    assert.equal(m1.calls, 3);
    assert.equal(m1.tokens.total, 360 + 15 + 10);
    assert.ok(Math.abs(m1.cost.total - 0.65) < 1e-9);
  } finally {
    cleanup();
  }
});

test('subagent runs stored twice are counted once (session.jsonl preferred)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agg = aggregate({ all: true, dir });
    const d = toData(agg);

    // run1 exists as both transcript and session.jsonl → counted once (30 tok, $0.05)
    assert.equal(d.byModel['p2/m2'].calls, 1);
    assert.equal(d.byModel['p2/m2'].tokens.total, 30);
    assert.ok(Math.abs(d.byModel['p2/m2'].cost.total - 0.05) < 1e-9);

    // run2 is transcript-only with numeric cost → ?/m3 (40 tok, $0.08)
    assert.equal(d.byModel['?/m3'].calls, 1);
    assert.equal(d.byModel['?/m3'].tokens.total, 40);
    assert.ok(Math.abs(d.byModel['?/m3'].cost.total - 0.08) < 1e-9);

    // agents derived from transcript names (worker for run1, scout for run2)
    assert.deepEqual(Object.keys(d.byAgent).sort(), ['scout', 'worker']);
  } finally {
    cleanup();
  }
});

test('derived metrics: cacheHitRate and costPer1M', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agg = aggregate({ all: true, dir });
    const t = agg.totals;

    const cacheRead = 200;
    const resident = (100 + 10 + 5 + 20 + 40) + cacheRead + 0;
    assert.ok(Math.abs(t.cacheHitRate - cacheRead / resident) < 1e-9);

    const expectedPer1M = (0.78 * 1e6) / 455;
    assert.ok(Math.abs(t.costPer1M - expectedPer1M) < 0.01, `costPer1M ${t.costPer1M}`);
  } finally {
    cleanup();
  }
});

test('filters: cwd, model, provider, group', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(aggregate({ all: true, dir, cwd: '/proj' }).totals.calls, 5);
    assert.equal(aggregate({ all: true, dir, cwd: '/other' }).totals.calls, 0);

    const m1 = aggregate({ all: true, dir, model: 'm1' });
    assert.equal(m1.totals.calls, 3);

    const p2 = aggregate({ all: true, dir, provider: 'p2' });
    assert.equal(p2.totals.calls, 1);

    // group: all entries in Jan 2026 → one month bucket
    const month = toData(aggregate({ all: true, dir, group: 'month' }));
    assert.deepEqual(Object.keys(month.byDay), ['2026-01']);
  } finally {
    cleanup();
  }
});

test('toData exposes the full extended shape', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const d = toData(aggregate({ all: true, dir }));
    for (const k of ['totals', 'byModel', 'byProvider', 'byAgent', 'byDay', 'bySession', 'modelSwitches', 'apiBreakdown', 'sessionCounts']) {
      assert.ok(k in d, `missing key ${k}`);
    }
    assert.deepEqual(Object.keys(d.byProvider).sort(), ['p1', 'p2']);
    // api breakdown: 4 openai-completions calls (a1,a2,a3,s1), run2 transcript has no api field
    assert.equal(d.apiBreakdown['openai-completions'].calls, 4);
  } finally {
    cleanup();
  }
});

test('infers provider for transcript models (no bare ?/ bucket, provider filter works)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-prov-'));
  const proj = path.join(dir, '--p--');
  writeJsonl(path.join(proj, 'main.jsonl'), [
    { type: 'session', version: 3, id: 'M', timestamp: '2026-01-01T00:00:00Z', cwd: '/p' },
    {
      type: 'message', id: 'x1', parentId: null, timestamp: '2026-01-01T00:01:00Z',
      message: { role: 'assistant', model: 'gpt-6-astra', provider: 'openai-codex', usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.10 } } },
    },
  ]);
  // transcript with the same bare model id but no provider field
  writeJsonl(path.join(proj, 'subagent-artifacts', 'run9_worker_0_transcript.jsonl'), [
    { version: 1, recordType: 'message', runId: 'run9', agent: 'worker', role: 'assistant', model: 'gpt-6-astra', timestamp: '2026-01-01T00:02:00Z', cwd: '/p', usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.05 } },
  ]);
  try {
    const d = toData(aggregate({ all: true, dir }));
    assert.ok(d.byModel['openai-codex/gpt-6-astra'], 'merged under provider/model');
    assert.ok(!('?/gpt-6-astra' in d.byModel), 'no bare ?/ bucket');
    assert.equal(d.byModel['openai-codex/gpt-6-astra'].calls, 2);
    assert.equal(d.byModel['openai-codex/gpt-6-astra'].tokens.total, 15);
    // --provider now includes the transcript entry
    assert.equal(aggregate({ all: true, dir, provider: 'openai-codex' }).totals.calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
