'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDashboard, width } = require('../lib/presentation');
function data() {
  const u = { calls: 42, tokens: { input: 100, output: 200, cacheRead: 10000, cacheWrite: 0, reasoning: 50, context: 10100, total: 10300 },
    cost: { total: 1.234 }, cacheHitRate: 0.99, reasoningRatio: 0.01, costPer1M: 120, avgTokensPerCall: 245 };
  return { totals: u, byModel: new Map([['provider/model-with-a-very-long-name-模型-🧪', u]]),
    byProvider: new Map([['provider', u]]), byAgent: new Map([['worker', u]]), byDay: new Map([['2026-01-01', u]]),
    bySession: new Map([['file', { file: 'file', name: 'A long session name 模型 🧪', kind: 'main', usage: u }]]),
    apiBreakdown: new Map([['example-api', { calls: 42, tokens: 10300 }]]), sessionsMain: 1, sessionsFork: 0, sessionsSubagent: 1, modelSwitches: 2 };
}
for (const columns of [40, 60, 80, 120, 160]) {
  test(`all dashboard views fit ${columns} terminal columns`, () => {
    for (const view of ['overview', 'models', 'providers', 'agents', 'days', 'sessions']) {
      for (const color of [true, false]) {
        const text = renderDashboard(data(), { all: true, view, limit: 15 }, columns, color);
        for (const line of text.split('\n')) assert.ok(width(line) <= columns, `${view}: ${width(line)} > ${columns}: ${line}`);
        assert.match(text, /1\.23/);
      }
    }
  });
}
test('wide overview uses paired panels; narrow view stacks them', () => {
  const wide = renderDashboard(data(), { all: true }, 140);
  const narrow = renderDashboard(data(), { all: true }, 80);
  assert.match(wide, /TOKEN BREAKDOWN +EFFICIENCY/);
  assert.doesNotMatch(narrow, /TOKEN BREAKDOWN +EFFICIENCY/);
});
test('plain ASCII data produces ASCII-only output without escape sequences', () => {
  const a = data(); a.byModel = new Map([['provider/model', a.totals]]);
  const text = renderDashboard(a, { all: true, plain: true }, 120);
  assert.doesNotMatch(text, /[^\x00-\x7f]/);
});
