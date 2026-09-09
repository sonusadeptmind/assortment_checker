/**
 * Tests for the four QA-report fixes in the Add Products / review flow.
 *
 * Run with:  node tests/test_qa_fixes.js
 *
 * The functions under test are pulled straight out of app.js / annotation
 * modules into a Node sandbox (repo style, see test_coercion.js) so these
 * assertions run against the shipped source, not a hand-kept copy.
 *
 * Covers:
 *   1. Grade 2 on add    — addDialogGrade drives the grade written by
 *                          confirmAddProducts (grade 1 stays the default)
 *   2. Payload blanking  — resolveProductDump falls back to the Add Products
 *                          live source, so searching a not-yet-added product's
 *                          payload no longer empties the viewer
 *   3. Filter persistence— refreshAfterMarking keeps activeFilters (only the
 *                          selection is dropped), and no marking flow calls
 *                          clearFilter any more
 *   4. OOS at load time  — oosDropReason / pruneOosExcludedFromKeywords /
 *                          buildOosTrace: the include-vs-exclude choice made
 *                          when the index loads, the 30-day freshness window,
 *                          and the pruning that keeps excluded products out of
 *                          the review set, the metrics and the progress bar
 */

"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf-8');
const bulkSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'bulk.js'), 'utf-8');
const addSrc  = fs.readFileSync(path.join(ROOT, 'add_products.js'), 'utf-8');

/** Pull one function out of a source file by balancing braces from its
 *  signature (same idea as test_coercion.js, but the brace scan starts after
 *  the parameter list so default object params like `opts = {}` don't end it). */
function extractFn(src, signature, label) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature} in ${label}`);

  // Walk the parameter list to its closing paren.
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

//  Sandbox: the browser globals these functions read, plus no-op renderers

const sandbox = {
  console,
  // mutable app state
  productIndex: {},
  productDumps: {},
  dumpFilterCache: {},
  dumpFilterDirty: true,
  gradedLabels: {},
  approvals: {},
  disapprovals: {},
  activeKeyword: null,
  activeFilters: [],
  filteredPids: null,
  selectedPids: new Set(),
  currentUser: 'sonus',
  appMode: 'annotation',
  HISTORICAL_INDEX_MAX_AGE_DAYS: 90,
  OOS_MAX_AGE_DAYS: 30,
  oosPolicy: 'include',
  oosExcludedPids: [],
  addSourceDumps: {},          // stands in for fullLiveDumps (annotation mode)
  // render side effects are irrelevant here — count the calls instead
  renderCalls: { pills: 0, badge: 0, count: 0, grid: 0 },
};
sandbox.globalThis = sandbox;
sandbox.getAddSourceDumps = () => sandbox.addSourceDumps;
sandbox.renderFilterPills  = () => { sandbox.renderCalls.pills++; };
sandbox.updateFiltersBadge = () => { sandbox.renderCalls.badge++; };
sandbox.updateGridCount    = () => { sandbox.renderCalls.count++; };
sandbox.renderGrid         = () => { sandbox.renderCalls.grid++; };
vm.createContext(sandbox);

const bundle = [
  extractFn(appSrc,  'function toStr(',              'app.js'),
  extractFn(appSrc,  'function strictContains(',     'app.js'),
  extractFn(appSrc,  'function getBasePids(',        'app.js'),
  extractFn(appSrc,  'function oosDropReason(',     'app.js'),
  extractFn(appSrc,  'function pruneOosExcludedFromKeywords(', 'app.js'),
  extractFn(appSrc,  'function buildOosTrace(',      'app.js'),
  extractFn(appSrc,  'function buildIndexCacheKey(', 'app.js'),
  extractFn(appSrc,  'function resolveProductDump(', 'app.js'),
  extractFn(appSrc,  'function ensureDumpCache(',    'app.js'),
  extractFn(appSrc,  'function _pidMatchesFilter(',  'app.js'),
  extractFn(appSrc,  'function recomputeFilteredPids(', 'app.js'),
  extractFn(appSrc,  'function refreshAfterMarking(',  'app.js'),
  extractFn(addSrc,  'function productMatchesContentFilter(', 'add_products.js'),
  extractFn(dataSrc, 'function annGetGrade(',        'annotation/data.js'),
  extractFn(dataSrc, 'function annSetGrade(',        'annotation/data.js'),
  extractFn(dataSrc, 'function annCountGrades(',     'annotation/data.js'),
  extractFn(dataSrc, 'function parseUpdatedAt(',     'annotation/data.js'),
  extractFn(dataSrc, 'function isRecentUpdate(',     'annotation/data.js'),
].join('\n\n');
vm.runInContext(bundle, sandbox);

const {
  oosDropReason, pruneOosExcludedFromKeywords, buildOosTrace, buildIndexCacheKey,
  resolveProductDump, recomputeFilteredPids, refreshAfterMarking,
} = sandbox;

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

//  1. Grade 2 when adding products
//
//  confirmAddProducts is DOM-bound, so mirror only its grading line and prove
//  it is parameterised by addDialogGrade rather than a hard-coded 1.
console.log('\n── issue 1: add products at grade 1 or 2 ─────────────────');

const addSelectedAt = (grade, pids) => {
  sandbox.gradedLabels = {};
  pids.forEach(pid =>
    sandbox.annSetGrade('sonus', 'summer dress', pid, grade, { reason: 'manually_added' }));
  return sandbox.gradedLabels.sonus;
};

let store = addSelectedAt(1, ['p1', 'p2']);
eq('default grade 1 is written',        store['summer dress::p1'].grade, 1);
eq('reason tags the manual addition',   store['summer dress::p1'].reason, 'manually_added');

store = addSelectedAt(2, ['p1', 'p2']);
eq('grade 2 is written when chosen',    store['summer dress::p1'].grade, 2);
eq('grade 2 applies to every selected', store['summer dress::p2'].grade, 2);
eq('grade 2 keeps the manual reason',   store['summer dress::p2'].reason, 'manually_added');

// The dialog must actually offer, reset and read a grade-2 choice.
assert('add_products.js declares addDialogGrade',      /let addDialogGrade\s*=\s*1;/.test(addSrc));
assert('confirmAddProducts grades at addDialogGrade',
  /annSetGrade\(currentUser, kw, pid, addDialogGrade,/.test(addSrc));
assert('no hard-coded grade 1 left in confirmAddProducts',
  !/annSetGrade\(currentUser, kw, pid, 1,/.test(addSrc));
assert('grade choice resets to 1 on open',             /resetAddGradeChoice\(\);/.test(addSrc));
assert('onAddGradeChange reads the radio',             /input\[name="addGrade"\]:checked/.test(addSrc));

const html = fs.readFileSync(path.join(ROOT, 'assortment_checker.html'), 'utf-8');
assert('dialog offers a grade 1 radio', /name="addGrade" value="1"/.test(html));
assert('dialog offers a grade 2 radio', /name="addGrade" value="2"/.test(html));
assert('grade 1 is preselected',        /name="addGrade" value="1" checked/.test(html));

//  2. Product payload no longer blanks when searched
console.log('── issue 2: payload survives a dump search ───────────────');

sandbox.productDumps  = { inSet: { title: 'already in the keyword', color: 'red' } };
sandbox.addSourceDumps = { candidate: { title: 'browsed from Add Products', color: 'blue' } };

eq('dump of an already-added product resolves',
  resolveProductDump('inSet'), { title: 'already in the keyword', color: 'red' });
eq('dump of an Add-dialog candidate resolves from the live source',
  resolveProductDump('candidate'), { title: 'browsed from Add Products', color: 'blue' });
eq('unknown pid degrades to an empty object', resolveProductDump('nope'), {});

// The regression itself: searching re-reads the dump, and the old code read
// productDumps only — so a candidate's payload rendered as "{}".
const candidateJson = JSON.stringify(resolveProductDump('candidate'), null, 2);
assert('candidate payload is non-empty on re-read', candidateJson !== '{}');
assert('candidate payload still carries its fields', candidateJson.includes('browsed from Add Products'));

assert('searchProductDump uses the shared resolver',
  /function searchProductDump\(\)[\s\S]{0,600}resolveProductDump\(modalPid\)/.test(appSrc));
assert('searchProductDump no longer reads productDumps directly',
  !/const dump = productDumps\[modalPid\]/.test(appSrc));

//  3. Filters persist through a marking action
console.log('── issue 3: filter persists until explicitly cleared ─────');

sandbox.appMode      = 'annotation';
sandbox.currentUser  = 'sonus';
sandbox.productIndex = {
  a1: { title: 'Blue linen shirt', brand: 'Gap',    liveness: true },
  a2: { title: 'Blue denim shirt', brand: 'Gap',    liveness: true },
  a3: { title: 'Red wool coat',    brand: 'Oldnavy', liveness: true },
};
sandbox.productDumps    = {};
sandbox.dumpFilterDirty = true;
sandbox.activeKeyword   = { keyword: 'blue shirt', product_ids: ['a1', 'a2', 'a3'], re_product_ids: [] };
sandbox.activeFilters   = [{ field: 'brand', operator: 'contains', value: 'Gap', label: 'Brand = "Gap"' }];
sandbox.gradedLabels    = {};
recomputeFilteredPids();
eq('filter narrows the grid to the two Gap items', sandbox.filteredPids, ['a1', 'a2']);

// Mark the filtered products, then refresh the way the bulk flows now do.
sandbox.selectedPids = new Set(['a1', 'a2']);
sandbox.annSetGrade('sonus', 'blue shirt', 'a1', 1);
sandbox.annSetGrade('sonus', 'blue shirt', 'a2', 1);
const before = sandbox.renderCalls.grid;
refreshAfterMarking();

eq('activeFilters survive the marking action', sandbox.activeFilters.length, 1);
eq('the surviving filter is unchanged',        sandbox.activeFilters[0].value, 'Gap');
eq('filteredPids are recomputed, not dropped', sandbox.filteredPids, ['a1', 'a2']);
eq('the stale selection is cleared',           sandbox.selectedPids.size, 0);
assert('the grid is re-rendered',              sandbox.renderCalls.grid === before + 1);

// A grade filter re-evaluates against the labels just written.
sandbox.activeFilters = [{ field: 'grade', operator: 'contains', value: 'unlabeled', label: 'Grade = "unlabeled"' }];
refreshAfterMarking();
eq('grade filter re-runs against the new labels', sandbox.filteredPids, ['a3']);

// No marking path may reset the filter any more; the Clear button still does.
assert('bulk grade keeps the filter',      !/annSetGrade\(currentUser, activeKeyword\.keyword, pid, grade\);\s*\n\s*\}\);\s*\n\s*clearFilter\(\);/.test(bulkSrc));
assert('annotation/bulk.js calls refreshAfterMarking', /refreshAfterMarking\(\);/.test(bulkSrc));
assert('annotation/bulk.js no longer calls clearFilter', !/\bclearFilter\(\)/.test(bulkSrc));
assert('bulkApprove keeps the filter',
  /function bulkApprove\(\)[\s\S]{0,900}refreshAfterMarking\(\);/.test(appSrc));
assert('confirmBulkDisapproval keeps the filter',
  /function confirmBulkDisapproval\(\)[\s\S]{0,2000}refreshAfterMarking\(\);/.test(appSrc));
assert('refreshAfterMarking never touches activeFilters',
  !/activeFilters/.test(extractFn(appSrc, 'function refreshAfterMarking(', 'app.js')));
assert('the Clear button still calls clearFilter', /onclick="clearFilter\(\)"/.test(html));

//  4. OOS handled at load time, not in the progress bar
console.log('── issue 4: OOS policy applied when the index loads ──────');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T00:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

// oosDropReason: live products are never dropped, whatever the policy.
eq('live product kept under include', oosDropReason(true, daysAgo(200), 'include', NOW), null);
eq('live product kept under exclude', oosDropReason(true, daysAgo(200), 'exclude', NOW), null);

// exclude → every OOS product goes, however fresh.
eq('exclude drops a fresh OOS product', oosDropReason(false, daysAgo(1), 'exclude', NOW), 'oos_excluded');
eq('exclude drops a stale OOS product', oosDropReason(false, daysAgo(80), 'exclude', NOW), 'oos_excluded');

// include (default) → OOS kept only while updated_at is inside the 30-day window.
eq('include keeps OOS updated today',      oosDropReason(false, daysAgo(0),  'include', NOW), null);
eq('include keeps OOS updated 29 days ago',oosDropReason(false, daysAgo(29), 'include', NOW), null);
eq('include keeps OOS at the 30-day edge', oosDropReason(false, daysAgo(30), 'include', NOW), null);
eq('include drops OOS 31 days old',        oosDropReason(false, daysAgo(31), 'include', NOW), 'oos_stale');
eq('include drops OOS 80 days old',        oosDropReason(false, daysAgo(80), 'include', NOW), 'oos_stale');
eq('include drops an undated OOS product', oosDropReason(false, null, 'include', NOW), 'oos_stale');
eq('include drops an unparseable date',    oosDropReason(false, 'not a date', 'include', NOW), 'oos_stale');
eq('policy defaults to the session policy', oosDropReason(false, daysAgo(1), undefined, NOW), null);

// This is the high-turnover case the policy exists for: stock that went out
// yesterday is still worth judging, stock dead for months is not.
eq('high turnover: yesterday\'s OOS stays in scope',
  oosDropReason(false, daysAgo(1), 'include', NOW), null);

// pruneOosExcludedFromKeywords: excluded PIDs leave every list, review set and
// metric inputs alike, so nothing downstream can still count them.
const mkKw = () => ({
  keyword: 'jeans',
  product_ids:       ['live1', 'dead1', 'live2'],
  re_product_ids:    ['live1', 'dead1'],
  prev_re_ids:       ['dead1'],
  new_iteration_ids: ['live2', 'dead1'],
  staging_ids:       ['dead1'],
  tp_ids:            ['live1', 'dead1'],
  fp_ids:            ['dead1'],
  total: 3, tp_count: 2, fp_count: 1,
});

let kw = mkKw();
const removed = pruneOosExcludedFromKeywords([kw], ['dead1']);
eq('review set loses the excluded pid',   kw.product_ids, ['live1', 'live2']);
eq('re_product_ids loses it',             kw.re_product_ids, ['live1']);
eq('prev_re_ids loses it',                kw.prev_re_ids, []);
eq('metric input new_iteration_ids loses it', kw.new_iteration_ids, ['live2']);
eq('staging_ids loses it',                kw.staging_ids, []);
eq('tp_ids loses it',                     kw.tp_ids, ['live1']);
eq('fp_ids loses it',                     kw.fp_ids, []);
eq('every reference is counted',          removed, 7);
eq('total is recomputed from the review set', kw.total, 1);   // re_product_ids wins
eq('tp_count is recomputed',              kw.tp_count, 1);
eq('fp_count is recomputed',              kw.fp_count, 0);

kw = mkKw();
eq('nothing to exclude → no work', pruneOosExcludedFromKeywords([kw], []), 0);
eq('nothing to exclude → lists untouched', kw.product_ids, ['live1', 'dead1', 'live2']);
eq('a missing keyword list is tolerated', pruneOosExcludedFromKeywords(null, ['dead1']), 0);

// A keyword whose every product is excluded ends up empty rather than stuck:
// renderKeywordList hides the bar at total 0, so it can no longer sit at 99%.
const allDead = { keyword: 'clogs', product_ids: ['dead1', 'dead2'], re_product_ids: [] };
pruneOosExcludedFromKeywords([allDead], ['dead1', 'dead2']);
eq('all-excluded keyword has an empty review set', allDead.product_ids, []);
eq('all-excluded keyword reports total 0', allDead.total, 0);

// buildOosTrace: what lands in qa_metadata.json.
sandbox.oosPolicy = 'include';
sandbox.oosExcludedPids = ['b2', 'a1', 'b2', 'c3'];
let trace = buildOosTrace();
eq('trace records the active policy', trace.oos_policy, { mode: 'include', max_age_days: 30 });
eq('excluded ids are deduped and sorted', trace.oos_excluded_product_ids, ['a1', 'b2', 'c3']);
eq('count matches the id list', trace.oos_excluded_count, 3);

sandbox.oosPolicy = 'exclude';
sandbox.oosExcludedPids = [];
trace = buildOosTrace();
eq('exclude mode is recorded', trace.oos_policy.mode, 'exclude');
eq('an empty exclusion set is still reported', trace.oos_excluded_product_ids, []);
eq('empty count is 0', trace.oos_excluded_count, 0);
sandbox.oosPolicy = 'include';

// The two policies must not share an index cache entry.
const ck = mode => buildIndexCacheKey('gap', 'gap.jsonl', 100, 200, ['p1'], 19888, mode);
assert('include and exclude get different cache keys', ck('include') !== ck('exclude'));
assert('the same policy is stable',                    ck('include') === ck('include'));

// Source guards: the progress bar is back to plain totals, and the load paths
// carry the policy.
assert('progress helpers are gone from app.js',   !/function progressPids\(/.test(appSrc));
assert('renderKeywordList scores the base pids',
  /const total = basePids\.length;/.test(appSrc));
assert('annIsKeywordDone is back to its original form',
  !/progressPids/.test(dataSrc));
assert('the load prompt asks about OOS',          /Include out-of-stock products\?/.test(appSrc));
assert('include is the default policy',           /let oosPolicy\s*=\s*'include';/.test(appSrc));
assert('the freshness window is 30 days',         /const OOS_MAX_AGE_DAYS = 30;/.test(appSrc));
assert('the parser applies the policy',
  /const drop = oosDropReason\(isLive, updatedAt, policy\);/.test(appSrc));
assert('the pre-built index path applies the policy',
  /oosDropReason\(rec\.liveness !== false, pickUpdatedAt\(rawProduct\)\)/.test(appSrc));
assert('the catalog JSONL path applies the policy',
  /oosDropReason\(rec\.liveness !== false, pickUpdatedAt\(doc\)\)/.test(appSrc));
assert('both load modes prune the keywords',
  (appSrc.match(/pruneOosExcludedFromKeywords\(keywords, oosExcludedPids\)/g) || []).length >= 3);
assert('qa_metadata.json carries the trace',
  (appSrc.match(/\.\.\.buildOosTrace\(\),/g) || []).length === 2);
assert('a cache hit restores the excluded list',
  /oosExcludedPids = cached\.oosExcluded \|\| \[\];/.test(appSrc));
assert('Add Products stays live-only regardless of policy',
  /oosPolicy: 'exclude'/.test(addSrc));

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
console.log('═'.repeat(60));
if (failures.length) { console.log('\n' + failures.join('\n')); process.exit(1); }
