/**
 * Tests for the "why is this card empty?" distinction.
 *
 * Run with:  node tests/test_stale_message.js
 *
 * A product with no catalog entry has two possible causes with two different
 * fixes, and the grid used to call both "Product not in catalog":
 *   - it IS in the index file but its updated_at is outside the 90-day window
 *     → "Filtered out by the 90-day rule" (refresh the index)
 *   - the index file has no record for that id at all
 *     → "Not in the index file"
 *
 * _parseAnnotationJsonlStream, docPid and staleAgeLabel are pulled out of the
 * shipped app.js and run for real, over a real stream.
 *
 * Also asserts the parse now applies the 90-day filter and nothing else.
 */

"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf-8');

function extractFn(src, signature, label) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature} in ${label}`);
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const sandbox = {
  console, ReadableStream, TextDecoderStream, TextEncoder,
  HISTORICAL_INDEX_MAX_AGE_DAYS: 90,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
  extractFn(appSrc,  'function toStr(',                  'app.js'),
  extractFn(appSrc,  'function toStrTrim(',              'app.js'),
  extractFn(appSrc,  'function toStrList(',              'app.js'),
  extractFn(appSrc,  'function firstStr(',               'app.js'),
  extractFn(appSrc,  'function firstNonEmpty(',          'app.js'),
  extractFn(appSrc,  'function toBool(',                 'app.js'),
  extractFn(appSrc,  'function normalizeProductRecord(', 'app.js'),
  extractFn(appSrc,  'function docPid(',                 'app.js'),
  extractFn(appSrc,  'function staleAgeLabel(',          'app.js'),
  extractFn(appSrc,  'async function _parseAnnotationJsonlStream(', 'app.js'),
  extractFn(dataSrc, 'function parseUpdatedAt(',         'annotation/data.js'),
  extractFn(dataSrc, 'function pickUpdatedAt(',          'annotation/data.js'),
  extractFn(dataSrc, 'function isRecentUpdate(',         'annotation/data.js'),
].join('\n\n'), sandbox);

const { _parseAnnotationJsonlStream, docPid, staleAgeLabel } = sandbox;

//  Tiny runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) { if (cond) passed++; else { failed++; failures.push(`FAIL  ${label}`); } }
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const DAY = 864e5;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

//  docPid — every id shape the real indexes ship
console.log('\n── docPid ────────────────────────────────────────────────');
eq('top-level product_id',  docPid({ product_id: 'p1' }), 'p1');
eq('numeric product_id coerced', docPid({ product_id: 785938 }), '785938');
eq('falls back to id',      docPid({ id: 'p2' }), 'p2');
eq('falls back to _id',     docPid({ _id: 'p3' }), 'p3');
eq('reads product_dump.product_id',
  docPid({ product_dump: { product_id: 'p4' } }), 'p4');
eq('top level wins over the dump',
  docPid({ product_id: 'top', product_dump: { product_id: 'nested' } }), 'top');
eq('no id at all → empty',  docPid({ title: 'no id here' }), '');
eq('a non-object is tolerated', docPid(null), '');

//  staleAgeLabel — the phrase the card shows
console.log('── staleAgeLabel ─────────────────────────────────────────');
assert('reports the age in days', /^last updated 18[12] days ago$/.test(staleAgeLabel(daysAgo(182))));
eq('singular day', staleAgeLabel(daysAgo(1)), 'last updated 1 day ago');
// The real gap index ships updated_at as a single-element array.
assert('unwraps the array form retailers ship',
  /^last updated 18[12] days ago$/.test(staleAgeLabel([daysAgo(182)])));
eq('undated is called out, not silently zero',
  staleAgeLabel(null), 'no usable updated_at');
eq('an unparseable value is called out',
  staleAgeLabel('whenever'), 'no usable updated_at');

//  The parser reports which REQUESTED products the filter dropped
console.log('── stale tracking through the real parser ────────────────');

const rec = (pid, ageDays, extra = {}) => JSON.stringify({
  product_id: pid,
  title: `Product ${pid}`,
  // array form, exactly as the gap index ships it
  updated_at: [new Date(Date.now() - ageDays * DAY).toISOString().replace('T', ' ').slice(0, 19)],
  product_liveness: true,
  product_dump: { product_id: pid },
  ...extra,
});

function streamOf(lines) {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  return new ReadableStream({
    start(c) { c.enqueue(bytes.slice(0, 30)); c.enqueue(bytes.slice(30)); c.close(); },
  });
}

// fresh1/fresh2 load; stale1/stale2 are requested but too old; strangerStale is
// old AND not requested, so it must not appear in the report.
const LINES = [
  rec('fresh1', 2), rec('stale1', 182), rec('fresh2', 40),
  rec('stale2', 400), rec('strangerStale', 500), rec('strangerFresh', 3),
];
const ALLOWED = ['fresh1', 'fresh2', 'stale1', 'stale2', 'neverInFile'];

(async () => {
  const r = await _parseAnnotationJsonlStream(streamOf(LINES), ALLOWED, { buildFullLive: true });

  eq('only fresh requested products load', Object.keys(r.newIndex).sort(), ['fresh1', 'fresh2']);
  eq('requested-but-stale products are reported',
    Object.keys(r.stalePids).sort(), ['stale1', 'stale2']);
  assert('an unrequested stale product is NOT reported', !('strangerStale' in r.stalePids));
  assert('a product absent from the file is NOT reported as stale',
    !('neverInFile' in r.stalePids));
  eq('every stale line is still counted', r.skippedStale, 3);

  // The recorded value must be usable by the card.
  assert('the reported value drives the age label',
    /^last updated 18[12] days ago$/.test(staleAgeLabel(r.stalePids.stale1)));

  // This is the reported bug: 785938 is in the file, 182 days old. It must be
  // reported as filtered, so the card can stop claiming it is not in the catalog.
  const gapLike = await _parseAnnotationJsonlStream(
    streamOf([rec('785938', 182)]), ['785938'], {});
  eq('785938 does not load', Object.keys(gapLike.newIndex), []);
  eq('785938 is reported as filtered, not missing',
    Object.keys(gapLike.stalePids), ['785938']);

  console.log('── only the 90-day filter runs during the parse ──────────');
  // Dead stock is no longer dropped at parse time — the Add Products dialog
  // filters liveness itself, and nothing else filters the review index.
  const dead = await _parseAnnotationJsonlStream(
    streamOf([rec('deadFresh', 5, { product_liveness: false })]), ['deadFresh'], {});
  eq('a fresh out-of-stock product still loads', Object.keys(dead.newIndex), ['deadFresh']);
  eq('and is not reported as stale', Object.keys(dead.stalePids), []);
  assert('the parser exposes no liveOnly option any more', !/opts\.liveOnly/.test(appSrc));
  assert('nothing calls the parser with liveOnly',
    !/liveOnly:\s*true/.test(fs.readFileSync(path.join(ROOT, 'add_products.js'), 'utf-8')));

  console.log('── the grid message distinguishes the two causes ─────────');
  assert('card names the 90-day rule',      /Filtered out by the 90-day rule/.test(appSrc));
  assert('card names the absent case',      /Not in the index file/.test(appSrc));
  assert('the misleading message is gone',  !/>Product not in catalog</.test(appSrc));
  assert('the card carries an explanatory tooltip',
    /This product IS in the index file but its updated_at is outside/.test(appSrc));
  assert('the load notification separates the two causes',
    /are not present in the index file at all/.test(appSrc));
  assert('a cache hit keeps the stale set',
    /staleFilteredPids = cached\.stalePids \|\| \{\};/.test(appSrc));

  console.log('\n' + '═'.repeat(60));
  console.log(`  Tests passed: ${passed}`);
  console.log(`  Tests failed: ${failed}`);
  console.log('═'.repeat(60));
  if (failures.length) { console.log('\n' + failures.join('\n')); process.exit(1); }
})();
