/**
 * Tests for findHistoricalIndexFile — which JSONL the loader picks for a retailer.
 *
 * Run with:  node tests/test_index_file_pick.js
 *
 * The gap folder shipped two candidates for retailer "gap":
 *   gap.jsonl           0 bytes   (an empty stub)
 *   gap_gap.jsonl.gz    1.07 GB   (the real index, 21322 records)
 * Both names contain "gap", so the fuzzy fallback returned whichever the
 * directory picker enumerated first — the empty one — and every product id
 * was then reported as "not present in the index file at all".
 *
 * A zero-byte file can never be the index, so it is never a candidate.
 *
 * findHistoricalIndexFile is pulled out of the shipped app.js and run for real.
 */

"use strict";

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT   = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');

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

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extractFn(appSrc, 'function findHistoricalIndexFile(', 'app.js'), sandbox);
const { findHistoricalIndexFile } = sandbox;

//  Tiny runner
let passed = 0, failed = 0;
const failures = [];
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

/** A stand-in for the File objects the directory picker hands us. */
const file = (name, size) => ({ name, size });
const pick = (files, retailer) => {
  const got = findHistoricalIndexFile(files, retailer);
  return got ? got.name : null;
};

console.log('\n── the real gap folder ───────────────────────────────────');
// Enumeration order is the browser's, so assert both orders give the same answer.
const gapEmptyFirst = [
  file('.DS_Store', 8196),
  file('gap.jsonl', 0),
  file('gap_gap.jsonl.gz', 1076259793),
  file('golden_dataset_labelled_desc_gap.csv', 296696),
];
const gapRealFirst = [
  file('.DS_Store', 8196),
  file('gap_gap.jsonl.gz', 1076259793),
  file('gap.jsonl', 0),
  file('golden_dataset_labelled_desc_gap.csv', 296696),
];
eq('empty stub listed first is skipped', pick(gapEmptyFirst, 'gap'), 'gap_gap.jsonl.gz');
eq('real index listed first is kept',    pick(gapRealFirst,  'gap'), 'gap_gap.jsonl.gz');

console.log('── zero-byte files are never candidates ──────────────────');
eq('a zero-byte exact-name file loses to a real one',
   pick([file('gap_historical_index.jsonl', 0), file('gap_gap.jsonl.gz', 1076259793)], 'gap'),
   'gap_gap.jsonl.gz');
eq('the lone-file fallback will not return an empty file',
   pick([file('catalog.jsonl', 0)], 'gap'), null);
eq('every candidate empty means no index',
   pick([file('gap.jsonl', 0), file('gap_other.jsonl', 0)], 'gap'), null);

console.log('── existing behaviour still holds ────────────────────────');
eq('the exact name wins',
   pick([file('gap_other.jsonl', 999), file('gap_historical_index.jsonl', 500)], 'gap'),
   'gap_historical_index.jsonl');
eq('the exact name matches case-insensitively',
   pick([file('GAP_Historical_Index.jsonl', 500)], 'gap'), 'GAP_Historical_Index.jsonl');
eq('a retailer-named file is used when the exact name is absent',
   pick([file('oldnavy.jsonl', 400), file('gap_dump.jsonl', 400)], 'gap'), 'gap_dump.jsonl');
eq('a lone non-empty jsonl is used whatever it is called',
   pick([file('catalog.jsonl', 400)], 'gap'), 'catalog.jsonl');
eq('a gzipped index is still a candidate',
   pick([file('gap_historical_index.jsonl.gz', 400)], 'gap'), 'gap_historical_index.jsonl.gz');
eq('no jsonl at all means no index',
   pick([file('dataset.csv', 400)], 'gap'), null);

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
console.log('═'.repeat(60));
if (failures.length) { console.log('\n' + failures.join('\n')); process.exit(1); }
