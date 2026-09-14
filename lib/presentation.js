'use strict';

// Standalone, dependency-free presentation. No session reads or accounting here.
const path = require('node:path');
const ansi = /\x1b\[[0-9;]*m/g;
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cellWidth(s) {
  if (/^\p{Mark}+$/u.test(s)) return 0;
  const n = s.codePointAt(0);
  return /\p{Extended_Pictographic}/u.test(s) || (n >= 0x1100 && (
    n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) ||
    (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe6f) ||
    (n >= 0xff01 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) ||
    (n >= 0x20000 && n <= 0x3fffd))) ? 2 : 1;
}
function width(s) {
  return [...graphemes.segment(String(s).replace(ansi, ''))].reduce((n, g) => n + cellWidth(g.segment), 0);
}
function fit(value, size, right = false) {
  const text = clean(value);
  let out = text;
  if (width(text) > size) {
    out = '';
    for (const g of graphemes.segment(text)) {
      if (width(out) + cellWidth(g.segment) > size - 1) break;
      out += g.segment;
    }
    out += '~';
  }
  const gap = ' '.repeat(Math.max(0, size - width(out)));
  return right ? gap + out : out + gap;
}
const compact = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const money = n => '$' + n.toFixed(n > 0 && n < 1 ? 4 : 2);
const percent = n => (n * 100).toFixed(1) + '%';

function renderDashboard(agg, opts, terminalWidth = 80, color = false) {
  const available = Math.max(16, Math.floor(terminalWidth));
  const w = available - 4;
  const sep = opts.plain ? ' / ' : ' · ';
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const muted = s => paint('90', s);
  const accent = s => paint('38;2;138;190;183', s);
  const bold = s => paint('1', s);
  const line = (left, right, size) => {
    const r = clean(right);
    const room = size - width(r) - 2;
    return room > 2 ? fit(left, room) + '  ' + r : fit(left, size).trimEnd();
  };
  const title = (text, size) => [bold(clean(text).toUpperCase()), muted((opts.plain ? '-' : '─').repeat(size))];
  const sorted = entries => entries.sort((a, b) => opts.sort === 'name' ? a[0].localeCompare(b[0]) :
    opts.sort === 'tokens' ? b[1].tokens.total - a[1].tokens.total : opts.sort === 'calls' ? b[1].calls - a[1].calls : b[1].cost.total - a[1].cost.total);

  function table(label, entries, size, detailed = false) {
    const rows = sorted([...entries]);
    const shown = rows.slice(0, opts.limit || 15);
    const cols = [{ name: 'COST', min: 9, value: u => money(u.cost.total) }];
    if (size >= 38) cols.unshift({ name: 'TOKENS', min: 9, value: u => compact(u.tokens.total) });
    if (size >= 64) cols.unshift({ name: 'CALLS', min: 7, value: u => String(u.calls) });
    if (detailed && size >= 92) cols.splice(cols.length - 1, 0,
      { name: 'CACHE', min: 7, value: u => percent(u.cacheHitRate) },
      { name: '$/1M', min: 9, value: u => money(u.costPer1M) });
    if (detailed && size >= 122) cols.splice(cols.length - 1, 0,
      { name: 'REASONING', min: 9, value: u => percent(u.reasoningRatio) },
      { name: 'CONTEXT', min: 10, value: u => compact(u.tokens.context) });
    for (const c of cols) c.size = Math.max(c.min, ...shown.map(([, u]) => width(c.value(u))));
    const nameW = Math.max(1, size - cols.reduce((n, c) => n + c.size + 2, 0));
    // Very narrow terminals use stacked key/value rows, never truncate numbers.
    if (nameW < 10) return [...title(label, size), ...shown.flatMap(([key, u]) => [fit(key, size).trimEnd(), fit(money(u.cost.total), size, true)])];
    const result = [...title(label, size), muted(fit('NAME', nameW) + cols.map(c => '  ' + fit(c.name, c.size, true)).join(''))];
    for (const [key, u] of shown) result.push(fit(key, nameW) + cols.map(c => '  ' + (c.name === 'COST' ? accent(fit(c.value(u), c.size, true)) : fit(c.value(u), c.size, true))).join(''));
    if (!rows.length) result.push(muted('No usage in this period.'));
    if (rows.length > shown.length) result.push(muted(`${rows.length - shown.length} more; use --limit ${rows.length}`));
    return result;
  }
  function usage(size) {
    const u = agg.totals;
    return [...title('Token breakdown', size),
      ...['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].map(k =>
        line(({ cacheRead: 'Cache read', cacheWrite: 'Cache write' })[k] || k[0].toUpperCase() + k.slice(1), u.tokens[k].toLocaleString('en-US'), size))];
  }
  function efficiency(size) {
    const u = agg.totals;
    return [...title('Efficiency', size),
      line('Cache hit', percent(u.cacheHitRate), size),
      line('Reasoning share', percent(u.reasoningRatio), size),
      line('Blended $/1M', money(u.costPer1M), size),
      line('Avg tokens / call', compact(u.avgTokensPerCall), size),
      line('Model selections', String(agg.modelSwitches), size)];
  }
  function pair(left, right) {
    if (w < 100) return [...left(w), '', ...right(w)];
    const a = Math.floor((w - 6) / 2), b = w - a - 6;
    const l = left(a), r = right(b);
    return Array.from({ length: Math.max(l.length, r.length) }, (_, i) =>
      (l[i] || '') + ' '.repeat(Math.max(0, a - width(l[i] || ''))) + '      ' + (r[i] || ''));
  }

  const period = opts.all ? 'All time' : `Last ${opts.since ?? 30} days`;
  const lines = ['', bold(line('pi-usage', period, w)), muted(fit(
    `${agg.sessionsMain} main${sep}${agg.sessionsFork} fork${sep}${agg.sessionsSubagent} subagent`, w).trimEnd())];
  const filters = [opts.model && `model: ${opts.model}`, opts.provider && `provider: ${opts.provider}`, opts.cwd && `project: ${opts.cwd}`].filter(Boolean);
  if (filters.length) lines.push(muted(fit(filters.join(sep), w).trimEnd()));
  lines.push('');
  const metrics = [['RECORDED COST', money(agg.totals.cost.total)], ['TOKENS', compact(agg.totals.tokens.total)], ['CALLS', String(agg.totals.calls)], ['CACHE HIT', percent(agg.totals.cacheHitRate)]];
  const perRow = w >= 76 ? 4 : w >= 36 ? 2 : 1;
  const tile = Math.floor((w - (perRow - 1) * 3) / perRow);
  for (let start = 0; start < metrics.length; start += perRow) {
    const row = metrics.slice(start, start + perRow);
    lines.push(muted(row.map(([k]) => fit(k, tile)).join('   ')));
    lines.push(bold(row.map(([, v]) => fit(v, tile)).join('   ')));
    lines.push('');
  }
  const view = opts.view || 'overview';
  if (view === 'overview') {
    lines.push(...table('Models', agg.byModel, w, true), '',
      ...pair(usage, efficiency), '',
      ...pair(size => table('Providers', agg.byProvider, size), size => table('Agents', agg.byAgent, size)));
    if (agg.apiBreakdown.size) {
      lines.push('', ...title('Provider / API', w));
      for (const [api, v] of agg.apiBreakdown) lines.push(fit(`${api}${sep}${v.tokens.toLocaleString('en-US')} tok${sep}${v.calls} calls`, w).trimEnd());
    }
  } else if (view === 'days') {
    const rows = [...agg.byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-(opts.limit || 15));
    lines.push(...title(opts.group === 'week' ? 'Weekly usage' : opts.group === 'month' ? 'Monthly usage' : 'Daily usage', w));
    const max = Math.max(1, ...rows.map(([, u]) => u.cost.total));
    for (const [day, u] of rows) {
      lines.push(line(day, `${compact(u.tokens.total)} tok${sep}${money(u.cost.total)}`, w));
      if (!opts.plain && w >= 48) lines.push(accent('━'.repeat(Math.round(u.cost.total / max * w))));
    }
    if (!rows.length) lines.push(muted('No usage in this period.'));
  } else {
    const entries = view === 'sessions' ? [...agg.bySession.values()].map(s => [
      `${s.name || path.basename(s.file, '.jsonl')} [${s.kind}]`, s.usage]) :
      view === 'providers' ? agg.byProvider : view === 'agents' ? agg.byAgent : agg.byModel;
    lines.push(...table(view, entries, w, true));
  }
  lines.push('', muted(fit('Local session data. Recorded cost may differ from your bill.', w).trimEnd()), '');
  return lines.map(l => l ? '  ' + l : '').join('\n');
}
module.exports = { renderDashboard, width };
