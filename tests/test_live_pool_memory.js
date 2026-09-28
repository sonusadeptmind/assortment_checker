/**
 * Tests for the Add Products live pool's memory shape.
 *
 * Run with:  node tests/test_live_pool_memory.js
 *
 * The full-live pool exists so Add Products can search the whole catalog
 * without a second file read.  Searching only ever touches rec.searchText and
 * the curated record fields -- it never needs product_dump.  Retaining a dump
 * per product made the pool ~20x larger than the records and killed the tab on
 * a large catalog (measured on a real 355k-record index: 1.3 KB of record
 * against 24.2 KB of dump per product).
 *
 * These tests pin the pool to records only, on BOTH paths that build it:
 *   - the initial annotation parse            (buildFullLive: true)
 *   - the lazy Add Products loader            (withDumps: false)
 *
 * The golden-set dumps (newDumps) must survive -- those products are loaded
 * into the grid and their raw payload is shown in the detail modal.
 */

"use strict";

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT    = path.join(__dirname, '..');
const appSrc  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf-8');

function extractFn(src, signature, label = 'source') {
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
  console, ReadableStream, TextDecoder, TextEncoder,
  HISTORICAL_INDEX_MAX_AGE_DAYS: 90,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
  extractFn(appSrc,  'function toStr(',                           'app.js'),
  extractFn(appSrc,  'function toStrTrim(',                       'app.js'),
  extractFn(appSrc,  'function toStrList(',                       'app.js'),
  extractFn(appSrc,  'function firstStr(',                        'app.js'),
  extractFn(appSrc,  'function firstNonEmpty(',                   'app.js'),
  extractFn(appSrc,  'function toBool(',                          'app.js'),
  extractFn(appSrc,  'function normalizeProductRecord(',          'app.js'),
  extractFn(appSrc,  'function docPid(',                          'app.js'),
  extractFn(appSrc,  'function buildIndexCacheKey(',              'app.js'),
  extractFn(appSrc,  'async function _parseAnnotationJsonlStream(', 'app.js'),
  extractFn(dataSrc, 'function parseUpdatedAt(',                  'annotation/data.js'),
  extractFn(dataSrc, 'function pickUpdatedAt(',                   'annotation/data.js'),
  extractFn(dataSrc, 'function isRecentUpdate(',                  'annotation/data.js'),
].join('\n\n'), sandbox);

const { _parseAnnotationJsonlStream, buildIndexCacheKey } = sandbox;

//  Tiny runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) { if (cond) passed++; else { failed++; failures.push(`FAIL  ${label}`); } }

const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

function streamOf(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { lines.forEach(l => c.enqueue(enc.encode(l + '\n'))); c.close(); },
  });
}

/** A record whose product_dump dwarfs its curated fields, like a real catalog. */
function bigRecord(pid, dumpPadKB = 20) {
  return JSON.stringify({
    product_id: pid,
    title: `Product ${pid}`,
    brand: 'Acme',
    product_type: 'bat',
    updated_at: FRESH,
    product_liveness: true,
    product_dump: {
      product_id: pid,
      updated_at: FRESH,
      title: `Product ${pid}`,
      blob: 'x'.repeat(dumpPadKB * 1024),
    },
  });
}

const bytes = obj => JSON.stringify(obj || {}).length;

(async () => {
  const LINES = ['A', 'B', 'C', 'D'].map(pid => bigRecord(pid));

  // The full-live pool: records only

  {
    const r = await _parseAnnotationJsonlStream(streamOf(LINES), ['A'], { buildFullLive: true });

    console.log('\n── full-live pool (buildFullLive: true) ──────────────────');
    assert('pool holds every live product',
      Object.keys(r.fullIndex).length === 4);
    assert('pool records carry the searchable fields',
      (r.fullIndex.C.searchText || '').includes('product c'));
    assert('pool records carry curated display fields',
      r.fullIndex.C.brand === 'Acme' && r.fullIndex.C.title === 'Product C');

    const poolDumps = r.fullDumps || {};
    assert('pool retains NO product dumps',
      Object.keys(poolDumps).length === 0);

    // The regression guard: pool size must track records, not dumps.  Four
    // 20 KB dumps are ~80 KB; the records are well under 1 KB each.
    assert('pool stays record-sized, not dump-sized',
      bytes(r.fullIndex) < 4 * 1024);
    assert('pool is far smaller than the raw input it came from',
      bytes(r.fullIndex) < LINES.join('').length / 20);
  }

  // The golden set keeps its dumps

  {
    const r = await _parseAnnotationJsonlStream(streamOf(LINES), ['A', 'B'], { buildFullLive: true });

    console.log('\n── golden set (unchanged) ───────────────────────────────');
    assert('golden records loaded',
      Object.keys(r.newIndex).sort().join() === 'A,B');
    assert('golden dumps still retained (detail modal needs them)',
      Object.keys(r.newDumps).sort().join() === 'A,B');
    assert('golden dump content preserved in full',
      r.newDumps.A.blob.length === 20 * 1024);
    assert('parsed count counts only the golden set', r.parsed === 2);
  }

  // The lazy Add Products loader: withDumps opt-out

  {
    const r = await _parseAnnotationJsonlStream(streamOf(LINES), null, { withDumps: false });

    console.log('\n── lazy loader (withDumps: false) ───────────────────────');
    assert('every product is indexed',
      Object.keys(r.newIndex).length === 4);
    assert('no dumps retained',
      Object.keys(r.newDumps).length === 0);
    assert('index stays record-sized',
      bytes(r.newIndex) < 4 * 1024);
  }

  // Default behaviour is unchanged for existing callers

  {
    const r = await _parseAnnotationJsonlStream(streamOf(LINES), null, {});

    console.log('\n── default (withDumps omitted) ──────────────────────────');
    assert('dumps retained by default',
      Object.keys(r.newDumps).length === 4);
    assert('records retained by default',
      Object.keys(r.newIndex).length === 4);
  }

  // Stale records still never enter the pool

  {
    const STALE_DATE = new Date(Date.now() - 400 * 24 * 3600 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const stale = JSON.stringify({
      product_id: 'OLD', updated_at: STALE_DATE, product_liveness: true,
      product_dump: { product_id: 'OLD', updated_at: STALE_DATE },
    });
    const r = await _parseAnnotationJsonlStream(streamOf([...LINES, stale]), ['OLD'],
                                                { buildFullLive: true });

    console.log('\n── recency filter (unchanged) ───────────────────────────');
    assert('stale product kept out of the pool', !('OLD' in r.fullIndex));
    assert('stale product still reported as stale', 'OLD' in r.stalePids);
  }

  // Dead stock still excluded from the pool

  {
    const dead = JSON.stringify({
      product_id: 'DEAD', updated_at: FRESH, product_liveness: false,
      product_dump: { product_id: 'DEAD', updated_at: FRESH },
    });
    const r = await _parseAnnotationJsonlStream(streamOf([...LINES, dead]), ['A'],
                                                { buildFullLive: true });

    console.log('\n── liveness filter (unchanged) ──────────────────────────');
    assert('dead product kept out of the live pool', !('DEAD' in r.fullIndex));
  }

  // Cached pools written before this change must not be reused

  {
    console.log('\n── cache invalidation ───────────────────────────────────');
    const key = buildIndexCacheKey('gap', 'gap_historical_index.jsonl',
                                   12345, 1700000000000, ['p1'], 19888);
    assert('cache key carries a pool-shape version token',
      /(^|::)v4(::|$)/.test(key));
  }

  // The search blob: one haystack covering every text field

  {
    const addSrc = fs.readFileSync(path.join(ROOT, 'add_products.js'), 'utf-8');
    const box = { console };
    box.globalThis = box;
    vm.createContext(box);
    vm.runInContext([
      extractFn(appSrc, 'function toStr('),
      extractFn(appSrc, 'function strictContains('),
      extractFn(addSrc, 'function productMatchesContentFilter('),
      extractFn(addSrc, 'function computeAddCandidates('),
    ].join('\n\n'), box);

    const RAW = {
      product_id: 'P1',
      title: 'Youth Baseball Glove',
      brand: 'Acme',
      product_type: 'glove',
      description: 'A soft leather mitt for junior players.',
      tags: ['infield', 'leather-mitt'],
      collections: ['Spring Training 2026'],
      product_texts: ['Youth Baseball Glove'],     // duplicates the title
      topologies_text: 'baseball gloves',
      HIERARCHY_NAME: 'Team Sports',
      Sport: 'Baseball',
      Activity: 'Fielding',
      product_dump: { product_id: 'P1', blob: 'q'.repeat(20 * 1024) },
    };
    const rec = sandbox.normalizeProductRecord(RAW, 'P1');
    const st  = rec.searchText;

    console.log('\n── search blob coverage ─────────────────────────────────');
    assert('includes tags',                st.includes('infield'));
    assert('includes collections',         st.includes('spring training 2026'));
    assert('includes category hierarchy',  st.includes('team sports'));
    assert('includes taxonomy attributes', st.includes('fielding'));
    assert('includes description text',    st.includes('soft leather mitt'));

    console.log('\n── search blob shape ────────────────────────────────────');
    // The load-bearing one: token-level dedup would sort words apart and
    // silently kill every multi-word query.
    assert('multi-word phrases stay contiguous',
      st.includes('youth baseball glove'));
    assert('phrase from the description stays contiguous',
      st.includes('for junior players'));
    assert('duplicated field values collapse',
      st.split('youth baseball glove').length - 1 === 1);
    assert('blob never absorbs the raw dump',
      !st.includes('qqqq'));
    assert('blob stays bounded beside a 20 KB dump',
      st.length < 2048);
    assert('blob is lowercased', st === st.toLowerCase());

    console.log('\n── "Any text" filter searches the blob ──────────────────');
    const index = { P1: rec };
    const find = (filters, term) => box.computeAddCandidates(index, [], filters, term || '');

    assert('matches a tag that appears nowhere in the title',
      find([{ field: 'product_dump', operator: 'contains', value: 'infield' }]).join() === 'P1');
    assert('matches a collection name',
      find([{ field: 'product_dump', operator: 'contains', value: 'Spring' }]).join() === 'P1');
    assert('not_contains still inverts',
      find([{ field: 'product_dump', operator: 'not_contains', value: 'infield' }]).length === 0);
    assert('free-text box finds a product by collection',
      find([], 'spring training').join() === 'P1');
    assert('free-text box finds a product by description phrase',
      find([], 'leather mitt').join() === 'P1');
    assert('a term present nowhere matches nothing',
      find([], 'snowboard').length === 0);
    assert('dead stock still excluded',
      box.computeAddCandidates({ P1: { ...rec, liveness: false } }, [], [], 'spring').length === 0);
    assert('already-present pids still excluded',
      box.computeAddCandidates(index, ['P1'], [], 'spring').length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  failures.forEach(f => console.log('  ' + f));
  process.exit(failed ? 1 : 0);
})();
