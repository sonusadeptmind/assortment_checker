// Tests for the 90-day updated_at recency filter applied to historical-index
// JSONL ingestion.  Loads the live helpers from annotation/data.js and the
// production buildFilteredIndex from annotation/csv.js — no inline copy —
// so any divergence in those files surfaces here.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dataJs = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf8');
const csvJs  = fs.readFileSync(path.join(ROOT, 'annotation', 'csv.js'),  'utf8');

// Hoist the recency helpers from annotation/data.js into globalThis.
const constDecl = dataJs.match(/const HISTORICAL_INDEX_MAX_AGE_DAYS = \d+;/m)[0];
const fnA = dataJs.match(/function parseUpdatedAt\([^)]*\)[\s\S]*?\n\}/m)[0];
const fnB = dataJs.match(/function pickUpdatedAt\([^)]*\)[\s\S]*?\n\}/m)[0];
const fnC = dataJs.match(/function isRecentUpdate\([^)]*\)[\s\S]*?\n\}/m)[0];
eval(`
${constDecl.replace('const ', 'globalThis.')}
globalThis.parseUpdatedAt = ${fnA.replace('function parseUpdatedAt', 'function')};
globalThis.pickUpdatedAt  = ${fnB.replace('function pickUpdatedAt',  'function')};
globalThis.isRecentUpdate = ${fnC.replace('function isRecentUpdate', 'function')};
`);

// Hoist buildFilteredIndex from annotation/csv.js.
const bfi = csvJs.match(/function buildFilteredIndex\([^)]*\)[\s\S]*?\n\}/m)[0];
eval(`globalThis.buildFilteredIndex = ${bfi.replace('function buildFilteredIndex', 'function')};`);

let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) {
  if (cond) { passed++; }
  else { failed++; failures.push(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok);
  if (!ok) failures[failures.length - 1] += `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
}

const today = new Date('2026-05-07T00:00:00Z').getTime();

console.log('parseUpdatedAt — value shapes');

eq('null returns null', parseUpdatedAt(null), null);
eq('undefined returns null', parseUpdatedAt(undefined), null);
eq('empty string returns null', parseUpdatedAt(''), null);
eq('garbage string returns null', parseUpdatedAt('not a date'), null);
eq('empty array returns null', parseUpdatedAt([]), null);

// Bare "YYYY-MM-DD HH:MM:SS" (no timezone) must parse as UTC, so the 90-day
// window is identical regardless of the machine's local timezone.
assert('space-separator parses as UTC (tz-independent)',
  parseUpdatedAt('2026-02-06 00:00:00').getTime() === Date.UTC(2026, 1, 6, 0, 0, 0));
assert('iso "T" without tz parses as UTC',
  parseUpdatedAt('2026-04-15T12:00:00').getTime() === Date.UTC(2026, 3, 15, 12, 0, 0));

assert('iso-Z parses', parseUpdatedAt('2026-04-15T12:00:00Z') instanceof Date);
assert('iso-no-Z parses', parseUpdatedAt('2026-04-15T12:00:00+00:00') instanceof Date);
assert('space-separator (production format) parses',
  parseUpdatedAt('2026-05-01 09:39:30') instanceof Date);
assert('list-wrapped string unwraps and parses',
  parseUpdatedAt(['2026-05-01 09:39:30']) instanceof Date);
assert('list-wrapped iso unwraps and parses',
  parseUpdatedAt(['2026-04-15T12:00:00Z']) instanceof Date);
assert('list-wrapped epoch ms unwraps and parses',
  parseUpdatedAt([Date.UTC(2026, 3, 15)]) instanceof Date);

console.log('pickUpdatedAt — production document shape');

const prodDoc = {
  product_id: '896147',
  updated_at: ['2026-05-01 09:39:30'],   // top-level list (matches gap_historical_index.jsonl)
  product_dump: {
    product_id: '896147',
    updated_at: '2026-05-01 09:39:30',   // dump string
  },
};

eq('picks top-level when present (list)',
  pickUpdatedAt(prodDoc), ['2026-05-01 09:39:30']);

eq('falls back to product_dump.updated_at when top missing',
  pickUpdatedAt({ product_dump: { updated_at: '2026-05-01 09:39:30' } }),
  '2026-05-01 09:39:30');

eq('returns null when neither path has it',
  pickUpdatedAt({ product_dump: { product_id: 'x' } }), null);

console.log('isRecentUpdate — 90-day window');

assert('list-wrapped 30 days old → recent',
  isRecentUpdate(['2026-04-07 00:00:00'], HISTORICAL_INDEX_MAX_AGE_DAYS, today) === true);
assert('list-wrapped 120 days old → stale',
  isRecentUpdate(['2026-01-07 00:00:00'], HISTORICAL_INDEX_MAX_AGE_DAYS, today) === false);
assert('exactly 90 days old → recent (boundary inclusive)',
  isRecentUpdate(['2026-02-06 00:00:00'], HISTORICAL_INDEX_MAX_AGE_DAYS, today) === true);
assert('missing → stale',
  isRecentUpdate(undefined, HISTORICAL_INDEX_MAX_AGE_DAYS, today) === false);

console.log('buildFilteredIndex — production-shape end-to-end');

// Pretend "today" is May 7 2026 by stubbing Date.now used by the helper.
const realDateNow = Date.now;
Date.now = () => today;

const fixturePath = path.join(__dirname, 'gap_historical_index.jsonl');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const allowedPids = ['pid_001', 'pid_002', 'pid_003', 'pid_004', 'pid_005', 'pid_999'];

const r1 = buildFilteredIndex(fixtureText, allowedPids);
eq('all 6 fresh records survive the filter (parsed)', r1.parsed, 6);
eq('no records filtered as stale', r1.skippedStale, 0);
eq('newIndex pid_001 present', !!r1.newIndex['pid_001'], true);
eq('newIndex pid_999 present', !!r1.newIndex['pid_999'], true);

// Stale fixture: same shape but updated_at well outside the window.
const staleLine = JSON.stringify({
  product_id: 'pid_old',
  updated_at: ['2025-08-01 12:00:00'],   // ~280 days before "today"
  title: 'Old Item',
  product_dump: { product_id: 'pid_old', updated_at: '2025-08-01 12:00:00' },
}) + '\n';
const r2 = buildFilteredIndex(staleLine, ['pid_old']);
eq('stale record is filtered (parsed=0)', r2.parsed, 0);
eq('stale record counted as skippedStale', r2.skippedStale, 1);

// Mixed fresh + stale + missing.
const freshLine = JSON.stringify({
  product_id: 'pid_fresh',
  updated_at: ['2026-04-30 12:00:00'],
  title: 'Fresh Item',
  product_dump: { product_id: 'pid_fresh', updated_at: '2026-04-30 12:00:00' },
}) + '\n';
const missingLine = JSON.stringify({
  product_id: 'pid_missing',
  title: 'Missing Updated At',
  product_dump: { product_id: 'pid_missing' },
}) + '\n';
const r3 = buildFilteredIndex(freshLine + staleLine + missingLine,
                              ['pid_fresh', 'pid_old', 'pid_missing']);
eq('mixed: only fresh record kept (parsed=1)', r3.parsed, 1);
eq('mixed: 2 records skipped as stale/undated', r3.skippedStale, 2);
eq('mixed: pid_fresh in index', !!r3.newIndex['pid_fresh'], true);
eq('mixed: pid_old not in index', !!r3.newIndex['pid_old'], false);
eq('mixed: pid_missing not in index', !!r3.newIndex['pid_missing'], false);

Date.now = realDateNow;

console.log('\n════════════════════════════════════════════════════════════');
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
console.log('════════════════════════════════════════════════════════════');
if (failed) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
