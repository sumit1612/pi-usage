'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { aggregate, toData } = require('../lib/core');
const stripTypes = require('node:module').stripTypeScriptTypes;
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name, records) => {
    const file = path.join(dir, 'project', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    return file;
  };
  const message = (id, provider, cost = 1) => ({
    type: 'message', id, timestamp: '2026-01-01T00:01:00Z',
    message: { role: 'assistant', provider, model: 'shared-model', api: 'example-api',
      usage: { input: 10, output: 2, totalTokens: 12, cost: { total: cost } } }
  });
  const session = (name, records, parentSession) => put(name, [
    { type: 'session', id: name, timestamp: '2026-01-01T00:00:00Z', cwd: '/project', parentSession }, ...records
  ]);
  const transcript = (provider) => put('subagent-artifacts/run_worker_transcript.jsonl', [{
    recordType: 'message', runId: 'run', role: 'assistant', agent: 'worker', model: 'shared-model',
    timestamp: '2026-01-01T00:02:00Z', cwd: '/project', usage: { input: 5, cost: 1 },
    ...(provider ? { message: { role: 'assistant', provider, model: 'shared-model' } } : {})
  }]);
  return { dir, session, message, transcript };
}

test('independent sessions sharing an entry ID both count; linked fork copies do not', t => {
  const f = fixture(t);
  const parent = f.session('a.jsonl', [f.message('collision', 'p1')]);
  f.session('b.jsonl', [f.message('collision', 'p2', 2)]);
  f.session('a/forks/c.jsonl', [f.message('collision', 'p1'), f.message('new', 'p1')], parent);
  const d = toData(aggregate({ dir: f.dir, all: true }));
  assert.equal(d.totals.calls, 3);
  assert.equal(d.totals.cost.total, 4);
  assert.equal(d.bySession[parent].usage.calls, 1);
  assert.equal(Object.values(d.bySession).find(s => s.kind === 'fork').usage.calls, 1);
});

test('ambiguous model providers remain unknown and are not attributed by traversal order', t => {
  const f = fixture(t);
  f.session('a.jsonl', [f.message('a', 'p1')]);
  f.session('b.jsonl', [f.message('b', 'p2')]);
  f.transcript();
  const d = toData(aggregate({ dir: f.dir, all: true }));
  assert.equal(d.byModel['?/shared-model'].calls, 1);
  for (const provider of ['p1', 'p2']) {
    assert.equal(aggregate({ dir: f.dir, all: true, provider }).totals.calls, 1);
  }
});

test('explicit nested transcript provider takes precedence over ambiguous evidence', t => {
  const f = fixture(t);
  f.session('a.jsonl', [f.message('a', 'p1')]);
  f.session('b.jsonl', [f.message('b', 'p2')]);
  f.transcript('p1');
  assert.equal(aggregate({ dir: f.dir, all: true, provider: 'p1' }).totals.calls, 2);
});

test('CLI overview renders a populated API Map', t => {
  const f = fixture(t);
  f.session('a.jsonl', [f.message('a', 'p1')]);
  const result = spawnSync(process.execPath, [path.join(root, 'bin/pi-usage'), '--dir', f.dir, '--all', '--plain'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API\n/);
  assert.match(result.stdout, /example-api.*12 tok.*1 calls/);
});

test('byModel runtime and declaration agree on Usage values', t => {
  const f = fixture(t);
  f.session('a.jsonl', [f.message('a', 'p1')]);
  const u = aggregate({ dir: f.dir, all: true }).byModel.get('p1/shared-model');
  assert.equal(u.calls, 1);
  assert.equal(u.cost.total, 1);
  assert.match(fs.readFileSync(path.join(root, 'lib/core.d.ts'), 'utf8'), /byModel: Map<string, Usage>;/);
});

test('TUI overview percentages use totals, not the largest model', { skip: !stripTypes }, t => {
  const f = fixture(t);
  f.session('a.jsonl', [f.message('a', 'p1', 3)]);
  f.session('b.jsonl', [f.message('b', 'p2', 1)]);
  let source = fs.readFileSync(path.join(root, 'extensions/usage.ts'), 'utf8');
  // Load the real renderer, omitting host imports; no pi session is started.
  source = source.replace(/^import .*;\r?$/gm, '').replace('export default function usageCommand', 'function usageCommand');
  const context = vm.createContext({ truncateToWidth: s => s });
  vm.runInContext(stripTypes(source) + '\n globalThis.renderUsage = build;', context);
  const d = toData(aggregate({ dir: f.dir, all: true }));
  const lines = context.renderUsage(d, 'overview', 0, 0, null, 160,
    { fg: (_, s) => s, bold: s => s }, 'all time');
  const first = lines.find(l => l.includes('p1/shared-model'));
  const second = lines.find(l => l.includes('p2/shared-model'));
  assert.match(first, /50%.*75%/);
  assert.match(second, /50%.*25%/);
});
