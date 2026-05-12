/**
 * Smoke tests for annotation mode — pure functions only (no DOM).
 *
 * Run with:  node tests/annotation/test_annotation.js
 *
 * Tests cover:
 *   - annParseGoldenCSV: retailer grouping, header detection, _unknown fallback
 *   - annLoadFromCSVRows: seeding gradedLabels from {user}_* columns
 *   - annBuildKeywordsFromRows: one keyword per unique keyword value, PIDs deduped
 *   - buildFilteredIndex: keeps only allowed PIDs, skips non-matching + malformed lines
 *   - annBuildExportCSV: passthrough of other-user columns, active-user column update,
 *                        new column addition, row order preserved
 *   - annCountGrades: grade 0/1/2 + labeled counts
 *   - annBuildLabelsStore: flat list, all users
 */

"use strict";

const fs = require('fs');
const path = require('path');

// Inline the pure functions from the annotation modules

/* ---- annotation/data.js (state + accessors) ---- */
let appMode     = 'annotation';
let gradedLabels = {};
let activeRetailer = '';
let goldenHeaders = [], goldenRows = [], goldenRowsByRetailer = {};

function annGetGrade(user, keyword, pid) {
  if (!user) return null;
  const store = gradedLabels[user];
  if (!store) return null;
  const entry = store[`${keyword}::${pid}`];
  return entry !== undefined ? entry.grade : null;
}
function annSetGrade(user, keyword, pid, grade, opts = {}) {
  if (!gradedLabels[user]) gradedLabels[user] = {};
  gradedLabels[user][`${keyword}::${pid}`] = {
    grade,
    reason:               opts.reason               || null,
    reason_other_text:    opts.reasonOtherText       || null,
    attribute:            opts.attribute             || null,
    attribute_other_text: opts.attributeOtherText    || null,
    timestamp:            new Date().toISOString(),
  };
}
function annCountGrades(user, keyword, pids) {
  const counts = { 0: 0, 1: 0, 2: 0, total: pids.length, labeled: 0 };
  const store  = gradedLabels[user] || {};
  pids.forEach(pid => {
    const entry = store[`${keyword}::${pid}`];
    if (entry !== undefined && entry.grade !== null && entry.grade !== undefined) {
      counts[entry.grade] = (counts[entry.grade] || 0) + 1;
      counts.labeled++;
    }
  });
  return counts;
}
function annLoadFromCSVRows(headers, rows) {
  const userCols = headers.filter(h => h.endsWith('_graded_relevance'));
  const users    = userCols.map(h => h.replace('_graded_relevance', ''));
  users.forEach(user => {
    if (!gradedLabels[user]) gradedLabels[user] = {};
    rows.forEach(row => {
      const kw  = (row.keyword    || '').trim();
      const pid = (row.product_id || '').trim();
      if (!kw || !pid) return;
      const gradeRaw = row[`${user}_graded_relevance`];
      if (gradeRaw === '' || gradeRaw === undefined || gradeRaw === null) return;
      const grade = parseInt(gradeRaw, 10);
      if (isNaN(grade) || grade < 0 || grade > 2) return;
      gradedLabels[user][`${kw}::${pid}`] = {
        grade,
        reason:               row[`${user}_reason`]               || null,
        reason_other_text:    row[`${user}_reason_other_text`]    || null,
        attribute:            row[`${user}_attribute`]            || null,
        attribute_other_text: row[`${user}_attribute_other_text`] || null,
        timestamp:            row[`${user}_timestamp`]            || null,
      };
    });
  });
  return users;
}
function annBuildLabelsStore() {
  const store = [];
  Object.entries(gradedLabels).forEach(([user, userStore]) => {
    Object.entries(userStore).forEach(([key, entry]) => {
      const sep = key.indexOf('::');
      if (sep === -1) return;
      store.push({ keyword: key.substring(0, sep), product_id: key.substring(sep + 2), user, graded_relevance: entry.grade, reason: entry.reason, timestamp: entry.timestamp });
    });
  });
  return store;
}

/* ---- annotation/csv.js (CSV parse, filtered index, export) ---- */
function parseCSV(text) {
  const parseRow = (line) => {
    const result = []; let inQuote = false, cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuote && line[i+1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
      else cur += ch;
    }
    result.push(cur); return result;
  };
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseRow(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = lines.slice(1).map(line => {
    const vals = parseRow(line); const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  });
  return { headers, rows };
}

function annParseGoldenCSV(text) {
  const { headers, rows } = parseCSV(text);
  const normalize = r => (r || '').toLowerCase().trim() || '_unknown';
  const byRetailer = {}; const retailerSet = new Set();
  rows.forEach(row => {
    const slug = normalize(row.retailer);
    retailerSet.add(slug);
    if (!byRetailer[slug]) byRetailer[slug] = [];
    byRetailer[slug].push(row);
  });
  return { headers, rows, goldenRowsByRetailer: byRetailer, retailers: [...retailerSet].sort() };
}

function annBuildKeywordsFromRows(rows) {
  const kwMap = {};
  rows.forEach(row => {
    const kw = (row.keyword || '').trim(); const pid = (row.product_id || '').trim();
    if (!kw) return;
    if (!kwMap[kw]) kwMap[kw] = { keyword: kw, product_ids: [], re_product_ids: [], total: 0 };
    if (pid && !kwMap[kw].product_ids.includes(pid)) {
      kwMap[kw].product_ids.push(pid); kwMap[kw].re_product_ids.push(pid);
    }
  });
  return Object.values(kwMap).map(kw => { kw.total = kw.product_ids.length; return kw; });
}

function buildFilteredIndex(jsonlText, allowedPids) {
  const allowed = new Set(allowedPids); const newIndex = {}; const newDumps = {};
  let parsed = 0, skipped = 0;
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim(); if (!trimmed) continue;
    let doc; try { doc = JSON.parse(trimmed); } catch (_) { skipped++; continue; }
    // Prefer nested product_dump when present (golden-dataset JSONL format)
    const src = (doc.product_dump && typeof doc.product_dump === 'object') ? doc.product_dump : doc;
    const rawPid = src.product_id || src.id || src._id || doc.product_id || doc.id || doc._id;
    if (!rawPid) { skipped++; continue; }
    const pid = String(rawPid);
    if (!allowed.has(pid)) continue;
    newIndex[pid] = { product_id: pid, title: src.title || '', brand: src.brand || '',
      liveness: src.product_liveness !== undefined ? Boolean(src.product_liveness) : true };
    newDumps[pid] = src;
    parsed++;
  }
  return { newIndex, newDumps, parsed, skipped };
}

const ANN_USER_COL_SUFFIXES = ['graded_relevance','reason','reason_other_text','attribute','attribute_other_text','qa_done','timestamp'];
function _csvVal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function annBuildExportCSV(goldenHeaders, goldenRows, activeUser) {
  const outputHeaders = [...goldenHeaders];
  ANN_USER_COL_SUFFIXES.forEach(suf => { const col = `${activeUser}_${suf}`; if (!outputHeaders.includes(col)) outputHeaders.push(col); });
  const userStore = gradedLabels[activeUser] || {};
  const lines = [outputHeaders.map(_csvVal).join(',')];
  goldenRows.forEach(row => {
    const kw = (row.keyword || '').trim(), pid = (row.product_id || '').trim();
    const key = `${kw}::${pid}`; const entry = userStore[key];
    const outRow = outputHeaders.map(col => {
      if (col === `${activeUser}_graded_relevance`) return entry !== undefined && entry.grade !== null ? _csvVal(entry.grade) : '';
      if (col === `${activeUser}_reason`) return entry ? _csvVal(entry.reason) : '';
      if (col === `${activeUser}_reason_other_text`) return entry ? _csvVal(entry.reason_other_text) : '';
      if (col === `${activeUser}_attribute`) return entry ? _csvVal(entry.attribute) : '';
      if (col === `${activeUser}_attribute_other_text`) return entry ? _csvVal(entry.attribute_other_text) : '';
      if (col === `${activeUser}_qa_done`) { if (entry !== undefined && entry.grade !== null) return 'TRUE'; return _csvVal(row[col] || ''); }
      if (col === `${activeUser}_timestamp`) return entry && entry.timestamp ? _csvVal(entry.timestamp) : _csvVal(row[col] || '');
      return _csvVal(row[col] !== undefined ? row[col] : '');
    });
    lines.push(outRow.join(','));
  });
  return lines.join('\n');
}

//  Tiny test runner

let passed = 0, failed = 0;
const failures = [];

function assert(label, condition) {
  if (condition) { passed++; }
  else { failed++; failures.push(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  assert(label, JSON.stringify(actual) === JSON.stringify(expected));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures[failures.length - 1] += `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
  }
}

//  Load fixtures

const FIXTURE_DIR = path.join(__dirname);
const csvText     = fs.readFileSync(path.join(FIXTURE_DIR, 'golden_dataset_labelled_desc_test.csv'), 'utf8');
const gapJsonl    = fs.readFileSync(path.join(FIXTURE_DIR, 'gap_historical_index.jsonl'), 'utf8');
const onJsonl     = fs.readFileSync(path.join(FIXTURE_DIR, 'oldnavy_historical_index.jsonl'), 'utf8');

//  Tests: annParseGoldenCSV

console.log('\n── annParseGoldenCSV ────────────────────────────────────');

const parsed = annParseGoldenCSV(csvText);

eq('retailers sorted alphabetically', parsed.retailers, ['gap', 'oldnavy']);
assert('gap rows exist', Array.isArray(parsed.goldenRowsByRetailer['gap']));
eq('gap row count', parsed.goldenRowsByRetailer['gap'].length, 5);
eq('oldnavy row count', parsed.goldenRowsByRetailer['oldnavy'].length, 4);
assert('headers include keyword', parsed.headers.includes('keyword'));
assert('headers include product_id', parsed.headers.includes('product_id'));
assert('headers include retailer', parsed.headers.includes('retailer'));
assert('headers include sonus_graded_relevance', parsed.headers.includes('sonus_graded_relevance'));
assert('headers include lisha_graded_relevance', parsed.headers.includes('lisha_graded_relevance'));

//  Tests: annLoadFromCSVRows

console.log('── annLoadFromCSVRows ────────────────────────────────────');

// Reset and reload
gradedLabels = {};
const detectedUsers = annLoadFromCSVRows(parsed.headers, parsed.rows);

assert('detected sonus', detectedUsers.includes('sonus'));
assert('detected lisha', detectedUsers.includes('lisha'));

// sonus: pid_001 → grade 2, pid_002 → grade 1, pid_003 → grade 0
eq('sonus pid_001 grade', annGetGrade('sonus', 'running shoes', 'pid_001'), 2);
eq('sonus pid_002 grade', annGetGrade('sonus', 'running shoes', 'pid_002'), 1);
eq('sonus pid_003 grade', annGetGrade('sonus', 'running shoes', 'pid_003'), 0);
eq('sonus pid_003 reason', gradedLabels['sonus']['running shoes::pid_003'].reason, 'wrong_product_category');

// pid_004 has no grade for sonus
eq('sonus pid_004 unlabeled', annGetGrade('sonus', 'blue jeans', 'pid_004'), null);

// lisha: pid_002 → grade 2, pid_003 → grade 0
eq('lisha pid_002 grade', annGetGrade('lisha', 'running shoes', 'pid_002'), 2);
eq('lisha pid_003 grade', annGetGrade('lisha', 'running shoes', 'pid_003'), 0);

// oldnavy pid_007 → sonus grade 0 (from sonus_graded_relevance)
eq('sonus oldnavy pid_007 grade', annGetGrade('sonus', 'denim jacket', 'pid_007'), 0);

//  Tests: annBuildKeywordsFromRows

console.log('── annBuildKeywordsFromRows ──────────────────────────────');

const gapKws = annBuildKeywordsFromRows(parsed.goldenRowsByRetailer['gap']);
assert('gap has 2 keywords', gapKws.length === 2);

const runningKw = gapKws.find(k => k.keyword === 'running shoes');
assert('running shoes keyword found', !!runningKw);
eq('running shoes has 3 pids', runningKw.product_ids.length, 3);
assert('pids deduped (no repeats)', new Set(runningKw.product_ids).size === runningKw.product_ids.length);

const blueJeansKw = gapKws.find(k => k.keyword === 'blue jeans');
eq('blue jeans has 2 pids', blueJeansKw.product_ids.length, 2);

const onKws = annBuildKeywordsFromRows(parsed.goldenRowsByRetailer['oldnavy']);
assert('oldnavy has 2 keywords', onKws.length === 2);

//  Tests: buildFilteredIndex

console.log('── buildFilteredIndex ────────────────────────────────────');

// Gap: allowed = all gap pids (pid_001..pid_005).  pid_999 is in jsonl but not allowed.
const gapAllowedPids = ['pid_001', 'pid_002', 'pid_003', 'pid_004', 'pid_005'];
const gapIdx = buildFilteredIndex(gapJsonl, gapAllowedPids);

eq('gap index: 5 products parsed', gapIdx.parsed, 5);
assert('pid_001 in index', !!gapIdx.newIndex['pid_001']);
assert('pid_999 NOT in index (filtered)', !gapIdx.newIndex['pid_999']);
eq('pid_001 title', gapIdx.newIndex['pid_001'].title, 'Classic Running Shoe');
eq('pid_003 liveness false', gapIdx.newIndex['pid_003'].liveness, false);
eq('pid_001 liveness true', gapIdx.newIndex['pid_001'].liveness, true);

// Old Navy: allowed = oldnavy pids
const onAllowedPids = ['pid_006', 'pid_007', 'pid_008', 'pid_009'];
const onIdx = buildFilteredIndex(onJsonl, onAllowedPids);
eq('oldnavy index: 4 products parsed', onIdx.parsed, 4);

// Empty allowed list → 0 products
const emptyIdx = buildFilteredIndex(gapJsonl, []);
eq('empty allowed → 0 products', emptyIdx.parsed, 0);

// Malformed JSONL line is skipped
const malformedJsonl = 'not-json\n{"product_id":"p1","title":"Good"}\n';
const mIdx = buildFilteredIndex(malformedJsonl, ['p1']);
eq('malformed line skipped', mIdx.parsed, 1);
eq('malformed line counted in skipped', mIdx.skipped, 1);

//  Tests: annCountGrades

console.log('── annCountGrades ────────────────────────────────────────');

// sonus on 'running shoes': pid_001(2), pid_002(1), pid_003(0)
const gc = annCountGrades('sonus', 'running shoes', ['pid_001', 'pid_002', 'pid_003']);
eq('counts.total = 3', gc.total, 3);
eq('counts.labeled = 3', gc.labeled, 3);
eq('grade 0 count = 1', gc[0], 1);
eq('grade 1 count = 1', gc[1], 1);
eq('grade 2 count = 1', gc[2], 1);

// pid_004, pid_005 unlabeled for sonus
const gcPartial = annCountGrades('sonus', 'blue jeans', ['pid_004', 'pid_005']);
eq('partial: total = 2', gcPartial.total, 2);
eq('partial: labeled = 0', gcPartial.labeled, 0);

// Unknown user → all zero
const gcUnknown = annCountGrades('nobody', 'running shoes', ['pid_001']);
eq('unknown user: labeled = 0', gcUnknown.labeled, 0);

//  Tests: annBuildExportCSV

console.log('── annBuildExportCSV ─────────────────────────────────────');

// Add a fresh grade for shweta (new user, no existing columns)
if (!gradedLabels['shweta']) gradedLabels['shweta'] = {};
annSetGrade('shweta', 'running shoes', 'pid_001', 2);
annSetGrade('shweta', 'blue jeans', 'pid_004', 1);

const exportCsv = annBuildExportCSV(parsed.headers, parsed.rows, 'shweta');
const exportLines = exportCsv.split('\n');
const exportHeaders = exportLines[0].split(',');

// shweta's columns must be appended when not originally present
assert('export has shweta_graded_relevance col', exportHeaders.includes('shweta_graded_relevance'));
assert('export has shweta_timestamp col', exportHeaders.includes('shweta_timestamp'));

// Original user columns must still be present (passthrough)
assert('sonus_graded_relevance still present', exportHeaders.includes('sonus_graded_relevance'));
assert('lisha_graded_relevance still present', exportHeaders.includes('lisha_graded_relevance'));

// Row count: header + 9 data rows
eq('export row count', exportLines.length, 10);

// Parse the export back and verify shweta's grades
function parseExportLine(line, headers) {
  const vals = line.split(',');
  const obj = {};
  headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
  return obj;
}

const exportRow0 = parseExportLine(exportLines[1], exportHeaders); // running shoes, pid_001
eq('shweta pid_001 grade in export', exportRow0['shweta_graded_relevance'], '2');
eq('shweta pid_001 qa_done in export', exportRow0['shweta_qa_done'], 'TRUE');

// sonus data must be passthrough-unchanged
eq('sonus pid_001 grade passthrough', exportRow0['sonus_graded_relevance'], '2');

// A row that shweta has not labeled must have empty grade (pid_003 = 3rd data row = exportLines[3])
const exportRow3 = parseExportLine(exportLines[3], exportHeaders); // running shoes, pid_003
eq('shweta pid_003 unlabeled → empty', exportRow3['shweta_graded_relevance'], '');

//  Tests: annBuildLabelsStore

console.log('── annBuildLabelsStore ───────────────────────────────────');

const labelsStore = annBuildLabelsStore();
assert('labels store is an array', Array.isArray(labelsStore));

// sonus has 4 grades (pid_001,002,003 for running_shoes + pid_007 for denim jacket)
const sonusEntries = labelsStore.filter(e => e.user === 'sonus');
assert('sonus has ≥4 entries', sonusEntries.length >= 4);

const shwetaEntries = labelsStore.filter(e => e.user === 'shweta');
assert('shweta has 2 entries', shwetaEntries.length === 2);

const sonusPid001 = sonusEntries.find(e => e.keyword === 'running shoes' && e.product_id === 'pid_001');
assert('sonus pid_001 in labels store', !!sonusPid001);
eq('sonus pid_001 grade = 2', sonusPid001.graded_relevance, 2);

//  Summary

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  ' + f));
}
console.log('═'.repeat(60));

process.exit(failed > 0 ? 1 : 0);
