/**
 * Tests for the Add Products / review-flow fixes from the QA report.
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
  extractFn(appSrc,  'function resolveProductDump(', 'app.js'),
  extractFn(appSrc,  'function ensureDumpCache(',    'app.js'),
  extractFn(appSrc,  'function _pidMatchesFilter(',  'app.js'),
  extractFn(appSrc,  'function recomputeFilteredPids(', 'app.js'),
  extractFn(appSrc,  'function refreshAfterMarking(',  'app.js'),
  extractFn(addSrc,  'function productMatchesContentFilter(', 'add_products.js'),
  extractFn(dataSrc, 'function annGetGrade(',        'annotation/data.js'),
  extractFn(dataSrc, 'function annSetGrade(',        'annotation/data.js'),
  extractFn(dataSrc, 'function annCountGrades(',     'annotation/data.js'),
].join('\n\n');
vm.runInContext(bundle, sandbox);

const {
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
// Grade names read as "1 (Relevant)", matching annotation/bulk.js — no
// decorative em dash between the number and the name.
assert('add-dialog grade names use parentheses', /Grade 1 \(Relevant\)/.test(html));
assert('add-dialog grade 2 name uses parentheses', /Grade 2 \(Perfect\)/.test(html));
const renderSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'render.js'), 'utf-8');
[['html', html], ['app.js', appSrc], ['render.js', renderSrc]].forEach(([label, src]) => {
  assert(`no em-dash grade labels left in ${label}`,
    !/[012]\s+—\s+(Not relevant|Relevant|Perfect)/.test(src));
});
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

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
console.log('═'.repeat(60));
if (failures.length) { console.log('\n' + failures.join('\n')); process.exit(1); }
