/**
 * End-to-end test of the OOS policy inside the real index parser.
 *
 * Run with:  node tests/test_oos_policy_load.js
 *
 * _parseAnnotationJsonlStream is pulled out of app.js and run over a real
 * JSONL stream, so this exercises the actual filtering the app does at load
 * time rather than a restatement of it.
 *
 * Invariants:
 *   - live products are never touched by the OOS policy (the separate 90-day
 *     recency filter still applies to them)
 *   - policy 'exclude'  → every OOS product is dropped
 *   - policy 'include'  → OOS kept while updated_at is within 30 days
 *   - dropped PIDs come back in oosExcluded so the caller can prune the
 *     keywords and write them to qa_metadata.json
 *   - the Add Products live pool is unaffected either way
 */

"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf-8');

/** Brace-balanced extraction, starting after the parameter list so default
 *  object params (`opts = {}`) don't terminate the scan early. */
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
  OOS_MAX_AGE_DAYS: 30,
  oosPolicy: 'include',
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
  extractFn(appSrc,  'function toStr(',                    'app.js'),
  extractFn(appSrc,  'function toStrTrim(',                'app.js'),
  extractFn(appSrc,  'function toStrList(',                'app.js'),
  extractFn(appSrc,  'function firstStr(',                 'app.js'),
  extractFn(appSrc,  'function firstNonEmpty(',            'app.js'),
  extractFn(appSrc,  'function toBool(',                   'app.js'),
  extractFn(appSrc,  'function normalizeProductRecord(',   'app.js'),
  extractFn(appSrc,  'function oosDropReason(',            'app.js'),
  extractFn(appSrc,  'async function _parseAnnotationJsonlStream(', 'app.js'),
  extractFn(dataSrc, 'function parseUpdatedAt(',           'annotation/data.js'),
  extractFn(dataSrc, 'function pickUpdatedAt(',            'annotation/data.js'),
  extractFn(dataSrc, 'function isRecentUpdate(',           'annotation/data.js'),
].join('\n\n'), sandbox);

const { _parseAnnotationJsonlStream } = sandbox;

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

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

/** One JSONL record in the shape the historical index ships. */
const rec = (pid, live, ageDays) => JSON.stringify({
  product_id: pid,
  title: `Product ${pid}`,
  brand: 'Gap',
  product_liveness: live,
  updated_at: daysAgo(ageDays),
  product_dump: { product_id: pid, title: `Product ${pid}` },
});

// live1/live2 in stock; oosFresh went out 5 days ago; oosStale 45 days ago;
// oosEdge sits a minute inside the 30-day boundary; live90 is inside the 90-day
// recency window but well outside the 30-day OOS one (it must be unaffected).
// (The exactly-30-days boundary is inclusive — covered against a fixed clock in
// test_qa_fixes.js; pinning it here would race the wall clock by milliseconds.)
const LINES = [
  rec('live1',    true,  1),
  rec('oosFresh', false, 5),
  rec('oosEdge',  false, 30 - 1 / 1440),
  rec('oosStale', false, 45),
  rec('live2',    true,  60),
  rec('live90',   true,  80),
];
const ALLOWED = ['live1', 'oosFresh', 'oosEdge', 'oosStale', 'live2', 'live90'];

function streamOf(lines) {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  return new ReadableStream({
    start(c) {
      // Deliberately split mid-record so the partial-line buffering is exercised.
      c.enqueue(bytes.slice(0, 40));
      c.enqueue(bytes.slice(40));
      c.close();
    },
  });
}

const parse = opts =>
  _parseAnnotationJsonlStream(streamOf(LINES), ALLOWED, { buildFullLive: true, ...opts });

(async () => {
  console.log('\n── policy: include (default) ─────────────────────────────');
  let r = await parse({ oosPolicy: 'include' });
  let inIndex = Object.keys(r.newIndex).sort();

  eq('live products always survive',
    inIndex.filter(p => p.startsWith('live')), ['live1', 'live2', 'live90']);
  assert('OOS updated 5 days ago is kept',  inIndex.includes('oosFresh'));
  assert('OOS just inside the 30-day window is kept', inIndex.includes('oosEdge'));
  assert('OOS 45 days old is dropped',     !inIndex.includes('oosStale'));
  eq('only the stale OOS product is reported', r.oosExcluded.sort(), ['oosStale']);
  eq('the drop is counted', r.oosDropped, 1);
  assert('the dropped product keeps no dump either', !('oosStale' in r.newDumps));

  console.log('── policy: exclude ───────────────────────────────────────');
  r = await parse({ oosPolicy: 'exclude' });
  inIndex = Object.keys(r.newIndex).sort();

  eq('exclude keeps exactly the live products', inIndex, ['live1', 'live2', 'live90']);
  eq('every OOS product is reported',
    r.oosExcluded.sort(), ['oosEdge', 'oosFresh', 'oosStale']);
  eq('all three drops are counted', r.oosDropped, 3);

  console.log('── the Add Products live pool ────────────────────────────');
  // The full live pool is built from liveness alone, so the session's policy
  // never changes it — Add Products must never offer an OOS product.
  const incl = await parse({ oosPolicy: 'include' });
  const excl = await parse({ oosPolicy: 'exclude' });
  eq('live pool is identical under both policies',
    Object.keys(incl.fullIndex).sort(), Object.keys(excl.fullIndex).sort());
  eq('live pool holds only live products',
    Object.keys(incl.fullIndex).sort(), ['live1', 'live2', 'live90']);

  console.log('── the 90-day recency filter is untouched ────────────────');
  const stale = [rec('ancient', true, 200), rec('fresh', true, 2)];
  r = await _parseAnnotationJsonlStream(streamOf(stale), ['ancient', 'fresh'],
    { buildFullLive: true, oosPolicy: 'include' });
  eq('a live product older than 90 days is still dropped',
    Object.keys(r.newIndex), ['fresh']);
  eq('it is counted as stale, not as an OOS exclusion', r.skippedStale, 1);
  eq('and it is not reported as OOS-excluded', r.oosExcluded, []);

  console.log('\n' + '═'.repeat(60));
  console.log(`  Tests passed: ${passed}`);
  console.log(`  Tests failed: ${failed}`);
  console.log('═'.repeat(60));
  if (failures.length) { console.log('\n' + failures.join('\n')); process.exit(1); }
})();
