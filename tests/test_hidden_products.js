/**
 * Tests for products that are filtered out of the index, and for products
 * added from the Add Products dialog.
 *
 * Run with:  node tests/test_hidden_products.js
 *
 * 1. A product dropped by the 90-day rule has no record to render and can never
 *    be graded, so it is left out of the grid AND of every count taken from it
 *    — the count chip, the sidebar badge, and the done/progress denominators.
 *    An id the index file has no record for at all still shows its card.
 *
 * 2. Regression: adding products while a filter pill was active left them
 *    invisible.  filteredPids is what the grid renders and it was computed
 *    before the additions existed, so the new cards never appeared — not even
 *    with "Show Labeled" on.
 *
 * The real renderGrid, getBasePids, recomputeFilteredPids and
 * confirmAddProducts are pulled out of the shipped files and run against a
 * stub DOM.
 */

"use strict";

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT   = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const addSrc = fs.readFileSync(path.join(ROOT, 'add_products.js'), 'utf-8');
const datSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf-8');
const rndSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'render.js'), 'utf-8');

function extractFn(src, signature, label) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature} in ${label}`);
  let i = src.indexOf('(', start), parens = 0;
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

//  Stub DOM — every element is a bag of properties the render code writes to.
const els = {};
const el  = id => (els[id] || (els[id] = {
  id, innerHTML: '', textContent: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, querySelectorAll: () => [],
}));

const sandbox = {
  console,
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [] },
  HISTORICAL_INDEX_MAX_AGE_DAYS: 90,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
  extractFn(datSrc, 'function visiblePids(',              'data.js'),
  extractFn(datSrc, 'function annGetGrade(',              'data.js'),
  extractFn(datSrc, 'function annSetGrade(',              'data.js'),
  extractFn(datSrc, 'function annCountGrades(',           'data.js'),
  extractFn(datSrc, 'function annIsKeywordDone(',         'data.js'),
  extractFn(rndSrc, 'function annRenderSidebarBadge(',    'render.js'),
  extractFn(rndSrc, 'function annRenderCardOverlay(',     'render.js'),
  extractFn(rndSrc, 'function annRenderGradeBadge(',      'render.js'),
  extractFn(appSrc, 'function toStr(',                    'app.js'),
  extractFn(appSrc, 'function escapeHtml(',               'app.js'),
  extractFn(appSrc, 'function strictContains(',           'app.js'),
  extractFn(appSrc, 'function getBasePids(',              'app.js'),
  extractFn(appSrc, 'function ensureDumpCache(',          'app.js'),
  extractFn(appSrc, 'function _pidMatchesFilter(',        'app.js'),
  extractFn(appSrc, 'function recomputeFilteredPids(',    'app.js'),
  extractFn(appSrc, 'function updateGridCount(',          'app.js'),
  extractFn(appSrc, 'function renderGrid(',               'app.js'),
  extractFn(appSrc, 'function countUnlabeledProducts(',   'app.js'),
  extractFn(addSrc, 'function productMatchesContentFilter(', 'add_products.js'),
  extractFn(addSrc, 'function getAddSourceIndex(',        'add_products.js'),
  extractFn(addSrc, 'function getAddSourceDumps(',        'add_products.js'),
  extractFn(addSrc, 'function confirmAddProducts(',       'add_products.js'),
  `
  const GRADE_CLASS = { 0: 'grade-pill-0', 1: 'grade-pill-1', 2: 'grade-pill-2' };
  let appMode = 'annotation', currentUser = 'alice', activeRetailer = 'gap';
  let productIndex = {}, productDumps = {}, staleFilteredPids = {}, gradedLabels = {};
  let activeKeyword = null, keywords = [], filteredPids = null, activeFilters = [];
  let selectedPids = new Set(), showLabelsActive = false, showPriorActive = false;
  let dumpFilterCache = {}, dumpFilterDirty = true;
  let approvals = {}, disapprovals = {}, qaDoneKeywords = new Set();
  let goldenHeaders = ['keyword', 'product_id', 'retailer'], goldenRows = [], goldenRowsByRetailer = {};
  let fullLiveIndex = {}, fullLiveDumps = {};
  let addDialogSelected = new Set(), addDialogGrade = 1;

  // Collaborators the two entry points call but this test does not assert on.
  function requireUser() { return true; }
  function showToast() {}
  function closeAddProductsModal() {}
  function renderKeywordList() {}
  function updateMetrics() {}
  function updateQaDoneUI() {}
  function annUpdateBulkRow() {}
  function scheduleAutoSave() {}
  function buildAddedGoldenRow(h, r, kw, pid) { return { keyword: kw, product_id: pid, retailer: r }; }

  const product = title => ({ title, brand: 'Levi', color: 'blue', image_url: 'x', liveness: true });

  globalThis.reset = function () {
    productIndex = { live1: product('Live one'), live2: product('Live two') };
    productDumps = {};
    // stale1 is in the file but 182 days old; absent1 is in no file at all.
    staleFilteredPids = { stale1: '2026-03-11 00:00:00' };
    activeKeyword = {
      keyword: 'blue jeans',
      product_ids:    ['live1', 'live2', 'stale1', 'absent1'],
      re_product_ids: ['live1', 'live2', 'stale1', 'absent1'],
      total: 4,
    };
    keywords = [activeKeyword];
    gradedLabels = {}; filteredPids = null; activeFilters = [];
    showLabelsActive = false; showPriorActive = false;
    dumpFilterCache = {}; dumpFilterDirty = true;
    goldenRows = []; goldenRowsByRetailer = {};
    fullLiveIndex = { NEW1: product('Added jeans') };
    fullLiveDumps = { NEW1: { product_id: 'NEW1' } };
    addDialogSelected = new Set(); addDialogGrade = 1;
  };

  globalThis.gridHtml   = function () { renderGrid(); return document.getElementById('productGrid').innerHTML; };
  globalThis.cardCount  = function (html) { return (html.match(/class="product-card/g) || []).length; };
  globalThis.countChip  = function () { updateGridCount(); return document.getElementById('gridProductCount').textContent; };
  globalThis.state      = { get basePids() { return getBasePids(); } };
  globalThis.setGrade   = (pid, g) => annSetGrade(currentUser, 'blue jeans', pid, g);
  globalThis.isDone     = () => annIsKeywordDone(activeKeyword, currentUser);
  globalThis.badge      = () => annRenderSidebarBadge(activeKeyword, currentUser);
  globalThis.showLabels = on => { showLabelsActive = on; };
  globalThis.addFilter  = (field, value) => {
    activeFilters = [{ field, operator: 'contains', value, label: field + ':' + value }];
    recomputeFilteredPids();
  };
  globalThis.addProducts = pids => { addDialogSelected = new Set(pids); confirmAddProducts(); };
  globalThis.unlabeled   = () => countUnlabeledProducts();
  globalThis.setMode     = m => { appMode = m; };
  globalThis.approve     = pid => { approvals['blue jeans::' + pid] = { pid }; };
  globalThis.showPrior   = (on, tpIds) => {
    if (tpIds) activeKeyword.tp_ids = tpIds;
    showPriorActive = on;
  };
  `,
].join('\n\n'), sandbox);

const { reset, gridHtml, cardCount, countChip, state, setGrade, isDone, badge,
        showLabels, addFilter, addProducts, showPrior, unlabeled, setMode, approve } = sandbox;

//  Tiny runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) { if (cond) passed++; else { failed++; failures.push(`FAIL  ${label}`); } }
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

//  visiblePids
console.log('\n── visiblePids ───────────────────────────────────────────');
reset();
eq('drops the filtered-out id, keeps the rest',
  sandbox.visiblePids(['live1', 'stale1', 'live2']), ['live1', 'live2']);
eq('an absent id is not a filtered id — it stays',
  sandbox.visiblePids(['live1', 'absent1']), ['live1', 'absent1']);
eq('an empty list is fine', sandbox.visiblePids([]), []);
eq('a missing list is fine', sandbox.visiblePids(undefined), []);

//  The grid
console.log('── the grid leaves filtered products out ─────────────────');
reset();
let html = gridHtml();
assert('the filtered product has no card', !html.includes('stale1'));
assert('the two live products render',     html.includes('Live one') && html.includes('Live two'));
assert('the absent id still gets its card', html.includes('absent1'));
assert('and that card says it is not in the file', html.includes('Not in the index file'));
assert('no card claims the 90-day rule any more', !html.includes('90-day rule'));
eq('three cards, not four', cardCount(html), 3);

console.log('── every count follows the grid ──────────────────────────');
reset();
eq('getBasePids drops it', state.basePids, ['live1', 'live2', 'absent1']);
eq('the count chip counts what is shown', countChip(), '3 products');
eq('the sidebar badge counts what is shown', badge(), '3');

console.log('── a keyword can finish ──────────────────────────────────');
reset();
setGrade('live1', 1); setGrade('live2', 0); setGrade('absent1', 0);
assert('done once every product you can see is graded', isDone());
reset();
setGrade('live1', 1); setGrade('live2', 0);
assert('not done while a visible product is ungraded', !isDone());

console.log('── prior-iteration pids get the same treatment ───────────');
reset();
showPrior(true, ['stale1', 'priorOnly']);
html = gridHtml();
assert('a filtered prior-iteration pid stays out too', !html.includes('stale1'));
assert('an unfiltered prior-iteration pid still surfaces', html.includes('priorOnly'));
showPrior(false);

//  Add Products
console.log('── added products show up ────────────────────────────────');
reset();
addProducts(['NEW1']);
showLabels(true);
html = gridHtml();
assert('the added product renders with no filter active', html.includes('Added jeans'));

reset();
addFilter('title', 'Live');            // a filter pill written for the old set
addProducts(['NEW1']);                 // add something it does not match
showLabels(true);
html = gridHtml();
assert('the added product renders with a filter pill active', html.includes('Added jeans'));
assert('the filter still hides what it always hid', !html.includes('absent1'));

reset();
addFilter('title', 'Live');
addProducts(['NEW1']);
showLabels(false);                     // grading it hides it again until Show Labeled
html = gridHtml();
assert('with Show Labeled off the graded addition is hidden', !html.includes('Added jeans'));
showLabels(true);
assert('and Show Labeled brings it back', gridHtml().includes('Added jeans'));

//  The export confirmation
console.log('── the export prompt counts what is still unlabelled ──────');
reset();
// live1, live2 and absent1 are shown and ungraded; stale1 is not shown at all.
eq('counts every visible product at the start', unlabeled(), 3);
setGrade('live1', 1);
eq('grading one drops the count', unlabeled(), 2);
setGrade('live2', 0); setGrade('absent1', 0);
eq('nothing left once every visible product is graded', unlabeled(), 0);
assert('a filtered-out product never inflates the count', !gridHtml().includes('stale1'));

reset();
setMode('iteration');
eq('iteration mode counts unlabelled the same way', unlabeled(), 3);
approve('live1');
eq('an approval counts as labelled', unlabeled(), 2);
setMode('annotation');

assert('export asks before writing anything',
  /const unlabeled = countUnlabeledProducts\(\);[\s\S]{0,200}confirm\(/.test(appSrc));
assert('and only when something is unlabelled',
  /unlabeled > 0 && !confirm\(/.test(appSrc));

//  Report
console.log('\n──────────────────────────────────────────────────────────');
failures.forEach(f => console.log(f));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
