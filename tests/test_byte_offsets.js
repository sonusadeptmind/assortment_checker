/**
 * Tests for byte-offset recording and on-demand product dumps.
 *
 * Run with:  node tests/test_byte_offsets.js
 *
 * Add Products searches the whole live catalog, but the pool holds records
 * only -- a dump is ~20x the size of the record it belongs to and retaining
 * one per product exhausts the tab (see test_live_pool_memory.js).  So a
 * reviewer who wants to see a candidate's raw payload needs it fetched on
 * demand, for the ~32 products on the current page alone.
 *
 * The mechanism: during the single parse the app already performs, record each
 * record's [byteOffset, byteLength] within the file.  Fetching a dump is then
 * `indexFile.slice(off, off + len).text()` -- no rescan, nothing retained.
 *
 * That only works if the parse stays in the byte domain.  Piping through
 * TextDecoderStream and accumulating a string remainder discards byte
 * positions entirely, and character offsets are NOT byte offsets the moment a
 * single accented character appears.  These tests pin the byte domain:
 *
 *   - offsets address bytes, not characters
 *   - chunk boundaries (mid-character, mid-line) never corrupt them
 *   - offsets are withheld when they cannot be trusted (gzip -> trackOffsets
 *     false), so the feature reports unavailable rather than slicing garbage
 *
 * and the fetch/caching behaviour built on top:
 *
 *   - fetchDumpsForPids returns only what was asked for
 *   - a slow page's fetch cannot overwrite a newer page's cache
 *   - products added from the dialog keep their dump in productDumps
 */

"use strict";

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT    = path.join(__dirname, '..');
const appSrc  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8');
const addSrc  = fs.readFileSync(path.join(ROOT, 'add_products.js'), 'utf-8');
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

//  Sandbox

const sandbox = {
  console, ReadableStream, TextDecoder, TextDecoderStream, TextEncoder, Promise,
  HISTORICAL_INDEX_MAX_AGE_DAYS: 90,
  appMode: 'annotation',
  activeRetailer: 'gap',
  clientFolderHandle: null,
  productDumps: {},
  productIndex: {},
  fullLiveIndex: null,
  fullLiveDumps: null,
  dumpFilterDirty: false,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
  extractFn(appSrc,  'function toStr(',                             'app.js'),
  extractFn(appSrc,  'function toStrTrim(',                         'app.js'),
  extractFn(appSrc,  'function toStrList(',                         'app.js'),
  extractFn(appSrc,  'function firstStr(',                          'app.js'),
  extractFn(appSrc,  'function firstNonEmpty(',                     'app.js'),
  extractFn(appSrc,  'function toBool(',                            'app.js'),
  extractFn(appSrc,  'function normalizeProductRecord(',            'app.js'),
  extractFn(appSrc,  'function docPid(',                            'app.js'),
  extractFn(appSrc,  'function buildIndexCacheKey(',                'app.js'),
  extractFn(appSrc,  'function findHistoricalIndexFile(',           'app.js'),
  extractFn(appSrc,  'async function _parseAnnotationJsonlStream(', 'app.js'),
  extractFn(appSrc,  'function resolveProductDump(',                'app.js'),
  extractFn(appSrc,  'function refreshModalDump(',                  'app.js'),
  extractFn(addSrc,  'function getAddSourceIndex(',                 'add_products.js'),
  extractFn(addSrc,  'function getAddSourceDumps(',                 'add_products.js'),
  extractFn(addSrc,  'async function _resolveAnnotationIndexFile(', 'add_products.js'),
  extractFn(addSrc,  'async function fetchDumpsForPids(',           'add_products.js'),
  extractFn(addSrc,  'function loadPageDumps(',                     'add_products.js'),
  extractFn(addSrc,  'function getAddPageDump(',                    'add_products.js'),
  extractFn(addSrc,  'function addPageDumpsPending(',               'add_products.js'),
  extractFn(addSrc,  'function persistAddedDumps(',                 'add_products.js'),
  extractFn(dataSrc, 'function parseUpdatedAt(',                    'annotation/data.js'),
  extractFn(dataSrc, 'function pickUpdatedAt(',                     'annotation/data.js'),
  extractFn(dataSrc, 'function isRecentUpdate(',                    'annotation/data.js'),
  `
  let addPageDumps = {};
  let _addDumpToken = 0;
  let _addDumpsPending = false;
  let _annIndexFile = null, _annIndexFileRetailer = null;
  globalThis.setPageDumps = d => { addPageDumps = d; };
  globalThis.getPageDumps = () => addPageDumps;
  globalThis.setIndexFileCache = () => { _annIndexFile = null; _annIndexFileRetailer = null; };
  `,
].join('\n\n'), sandbox);

// The modal is DOM-bound; stub just the two elements refreshModalDump touches.
// searchProductDump is a stub so the delegation can be observed without
// dragging the whole highlight machinery in.
const modalEls = {};
const modalEl = id => (modalEls[id] = modalEls[id] || { textContent: '', innerHTML: '', value: '' });
sandbox.document = { getElementById: modalEl, querySelector: () => null, querySelectorAll: () => [] };
const jsonPre   = modalEl('modalJsonDump');
const searchBox = modalEl('modalDumpSearch');
sandbox.modalPid = null;
sandbox.searchCalls = 0;
sandbox.searchProductDump = () => { sandbox.searchCalls++; };

const {
  _parseAnnotationJsonlStream, buildIndexCacheKey, resolveProductDump,
  fetchDumpsForPids, loadPageDumps, getAddPageDump, persistAddedDumps,
  refreshModalDump, addPageDumpsPending,
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

//  Fixtures

const enc   = new TextEncoder();
const dec   = new TextDecoder('utf-8');
const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

/** One JSONL line for a product, optionally padded with extra dump fields. */
const line = (pid, dumpExtra = {}) => JSON.stringify({
  product_id: pid,
  title: `Product ${pid}`,
  brand: 'Acme',
  updated_at: FRESH,
  product_liveness: true,
  product_dump: { product_id: pid, updated_at: FRESH, ...dumpExtra },
});

/** Assemble lines into the raw bytes of a file. */
function fileBytes(lines, { trailingNewline = true } = {}) {
  return enc.encode(lines.join('\n') + (trailingNewline ? '\n' : ''));
}

/** Feed raw bytes to the parser in fixed-size chunks, so a test can put a
 *  chunk boundary anywhere -- mid-line or mid-character. */
function streamOfBytes(bytes, chunkSize) {
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
}

const parse = (bytes, chunkSize, opts) =>
  _parseAnnotationJsonlStream(streamOfBytes(bytes, chunkSize), null, opts);

/** A Blob/File stand-in exposing the one method fetchDumpsForPids uses. */
function fakeIndexFile(bytes, name = 'gap_historical_index.jsonl') {
  const f = {
    name, size: bytes.length, lastModified: 1,
    slice(a, b) {
      f.slices++;
      const sub = bytes.subarray(a, b);
      return { text: async () => dec.decode(sub) };
    },
    slices: 0,
  };
  return f;
}

/** A FileSystemDirectoryHandle stand-in holding exactly one file. */
function fakeFolder(file) {
  return { async *entries() { yield ['f', { kind: 'file', getFile: async () => file }]; } };
}

(async () => {

  //  Offsets: the round trip

  {
    console.log('\n── ascii offsets round-trip ─────────────────────────────');
    const lines = ['A', 'B', 'C', 'D'].map(p => line(p));
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: true });

    assert('every live record carries an offset',
      ['A', 'B', 'C', 'D'].every(p => typeof r.fullIndex[p].off === 'number'));
    assert('every live record carries a length',
      ['A', 'B', 'C', 'D'].every(p => typeof r.fullIndex[p].len === 'number'));
    assert('slice(off, off+len) is the exact original line',
      ['A', 'B', 'C', 'D'].every((p, i) => {
        const rec = r.fullIndex[p];
        return dec.decode(bytes.subarray(rec.off, rec.off + rec.len)) === lines[i];
      }));
    assert('the sliced text parses back to the same product',
      ['A', 'B', 'C', 'D'].every(p => {
        const rec = r.fullIndex[p];
        return JSON.parse(dec.decode(bytes.subarray(rec.off, rec.off + rec.len))).product_id === p;
      }));
    assert('the first record starts at byte 0', r.fullIndex.A.off === 0);
    assert('offsets never include the newline',
      ['A', 'B', 'C', 'D'].every(p => bytes[r.fullIndex[p].off + r.fullIndex[p].len] === 0x0A));
  }

  //  Offsets are BYTES, not characters

  {
    console.log('\n── multi-byte characters shift offsets by bytes ─────────');
    // café (1 two-byte char), ☕ (three bytes), 🎿 (four bytes, a surrogate
    // pair in JS) all sit in the record BEFORE the one under test.
    const lines = [line('A', { note: 'café ☕ 🎿 piste' }), line('B')];
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: true });

    const byteLen = enc.encode(lines[0]).length;
    assert('the fixture really does contain multi-byte characters',
      byteLen > lines[0].length);
    assert('the next record starts one byte past the previous newline',
      r.fullIndex.B.off === byteLen + 1);
    assert('offset is NOT the character index (the bug this guards)',
      r.fullIndex.B.off !== lines[0].length + 1);
    assert('length counts bytes, not characters',
      r.fullIndex.A.len === byteLen && r.fullIndex.A.len > lines[0].length);
    assert('the multi-byte record still round-trips exactly',
      dec.decode(bytes.subarray(r.fullIndex.A.off, r.fullIndex.A.off + r.fullIndex.A.len)) === lines[0]);
  }

  //  Chunk boundaries

  {
    console.log('\n── chunk boundaries ─────────────────────────────────────');
    const lines = [line('A', { note: '🎿🎿🎿' }), line('B', { note: 'ünïcøde' }), line('C')];
    const bytes = fileBytes(lines);

    // A 1-byte chunk size puts a boundary inside every multi-byte character
    // and inside every line -- the harshest case there is.
    const byteAtATime = await parse(bytes, 1, { buildFullLive: true, trackOffsets: true });
    assert('every record survives a 1-byte chunk size',
      Object.keys(byteAtATime.fullIndex).sort().join() === 'A,B,C');
    assert('offsets survive a boundary inside a multi-byte character',
      ['A', 'B', 'C'].every((p, i) => {
        const rec = byteAtATime.fullIndex[p];
        return dec.decode(bytes.subarray(rec.off, rec.off + rec.len)) === lines[i];
      }));

    // A boundary landing exactly on a newline, and one just past it.
    const nl = bytes.indexOf(0x0A);
    for (const size of [nl, nl + 1, nl + 2]) {
      const r = await parse(bytes, size, { buildFullLive: true, trackOffsets: true });
      assert(`offsets survive a chunk boundary at byte ${size} (line edge)`,
        ['A', 'B', 'C'].every((p, i) => {
          const rec = r.fullIndex[p];
          return dec.decode(bytes.subarray(rec.off, rec.off + rec.len)) === lines[i];
        }));
    }
  }

  //  Awkward files

  {
    console.log('\n── trailing line with no newline ────────────────────────');
    const lines = [line('A'), line('B')];
    const bytes = fileBytes(lines, { trailingNewline: false });
    const r = await parse(bytes, 7, { buildFullLive: true, trackOffsets: true });

    assert('the final unterminated line is still parsed', 'B' in r.fullIndex);
    assert('the final line round-trips to end-of-file',
      dec.decode(bytes.subarray(r.fullIndex.B.off, r.fullIndex.B.off + r.fullIndex.B.len)) === lines[1]);
    assert('the final record ends exactly at the end of the file',
      r.fullIndex.B.off + r.fullIndex.B.len === bytes.length);
  }

  {
    console.log('\n── blank and whitespace-only lines ──────────────────────');
    const a = line('A'), b = line('B'), c = line('C');
    const bytes = enc.encode(['', a, '   ', '', b, '\t', c, ''].join('\n') + '\n');
    const r = await parse(bytes, 5, { buildFullLive: true, trackOffsets: true });

    assert('blank lines do not become records',
      Object.keys(r.fullIndex).sort().join() === 'A,B,C');
    assert('records after blank lines keep correct offsets',
      [['A', a], ['B', b], ['C', c]].every(([p, src]) => {
        const rec = r.fullIndex[p];
        return dec.decode(bytes.subarray(rec.off, rec.off + rec.len)) === src;
      }));
  }

  //  Property test

  {
    console.log('\n── property: every record round-trips ───────────────────');
    // A synthetic file mixing ascii, accents, CJK and emoji at varying widths,
    // parsed at a spread of chunk sizes including prime ones that guarantee
    // boundaries land mid-character.
    const FILLERS = ['plain', 'café', '日本語のテキスト', '🎿⛷️🏂', 'mixed café 日本 🎿', ''];
    const lines = [];
    for (let i = 0; i < 60; i++) {
      lines.push(line(`P${i}`, { note: FILLERS[i % FILLERS.length].repeat((i % 5) + 1) }));
    }
    const bytes = fileBytes(lines);

    let allOk = true, checked = 0;
    for (const chunkSize of [1, 2, 3, 7, 13, 17, 64, 251, 1024, bytes.length, bytes.length * 2]) {
      const r = await parse(bytes, chunkSize, { buildFullLive: true, trackOffsets: true });
      if (Object.keys(r.fullIndex).length !== lines.length) { allOk = false; break; }
      for (let i = 0; i < lines.length; i++) {
        const rec = r.fullIndex[`P${i}`];
        if (!rec) { allOk = false; break; }
        if (dec.decode(bytes.subarray(rec.off, rec.off + rec.len)) !== lines[i]) { allOk = false; break; }
        checked++;
      }
      if (!allOk) break;
    }
    assert('every record round-trips at every chunk size', allOk);
    assert('the property test actually exercised every record', checked === 60 * 11);
  }

  //  Offsets are withheld when they cannot be trusted

  {
    console.log('\n── trackOffsets opt-in ──────────────────────────────────');
    const bytes = fileBytes([line('A'), line('B')]);

    const off = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: false });
    assert('trackOffsets:false records carry no offset',
      off.fullIndex.A.off === undefined && off.fullIndex.A.len === undefined);

    const omitted = await parse(bytes, 64 * 1024, { buildFullLive: true });
    assert('offsets are opt-in, not the default',
      omitted.fullIndex.A.off === undefined && omitted.fullIndex.A.len === undefined);

    assert('golden-set records get offsets too',
      (await _parseAnnotationJsonlStream(streamOfBytes(bytes, 64), ['A'], { trackOffsets: true }))
        .newIndex.A.len > 0);

    // Gzip is the reason the gate exists: the parser sees the decompressed
    // stream, so its positions do not address the file.  Both callers must
    // therefore tie trackOffsets to the gzip sniff they already perform.
    assert('the annotation loader gates offsets on the gzip sniff',
      /trackOffsets:\s*!isGzip/.test(appSrc));
    assert('the Add Products loader gates offsets on the gzip sniff',
      /trackOffsets:\s*!isGzip/.test(addSrc));
    assert('the parse loop no longer pipes through TextDecoderStream',
      !/TextDecoderStream/.test(extractFn(appSrc, 'async function _parseAnnotationJsonlStream(')));
  }

  //  Cached pools written before offsets existed must not be reused

  {
    console.log('\n── cache invalidation ───────────────────────────────────');
    const key = buildIndexCacheKey('gap', 'gap_historical_index.jsonl',
                                   12345, 1700000000000, ['p1'], 19888);
    assert('cache key carries the offsets pool-shape version', /(^|::)v4(::|$)/.test(key));
    assert('the pre-offsets version is gone', !/(^|::)v3(::|$)/.test(key));
  }

  //  fetchDumpsForPids

  {
    console.log('\n── fetchDumpsForPids ────────────────────────────────────');
    const lines = ['A', 'B', 'C'].map(p => line(p, { blob: `dump-of-${p}` }));
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 9, { buildFullLive: true, trackOffsets: true });

    const file = fakeIndexFile(bytes);
    sandbox.fullLiveIndex = r.fullIndex;
    sandbox.fullLiveDumps = {};
    sandbox.clientFolderHandle = fakeFolder(file);
    sandbox.setIndexFileCache();

    const got = await fetchDumpsForPids(['A', 'C']);
    eq('returns exactly the requested pids', Object.keys(got).sort(), ['A', 'C']);
    eq('returns the product_dump, not the whole record', got.A, {
      product_id: 'A', updated_at: FRESH, blob: 'dump-of-A',
    });
    assert('a pid that was not asked for is absent', !('B' in got));

    const mixed = await fetchDumpsForPids(['A', 'NOPE']);
    eq('an unknown pid is omitted without throwing', Object.keys(mixed), ['A']);
    eq('an empty request is an empty result', await fetchDumpsForPids([]), {});

    // A pool built without offsets cannot be sliced -- the feature is
    // unavailable, and must say so by returning nothing rather than reading
    // the wrong bytes.
    const noOff = await parse(bytes, 64, { buildFullLive: true, trackOffsets: false });
    sandbox.fullLiveIndex = noOff.fullIndex;
    eq('a pool with no offsets yields no dumps', await fetchDumpsForPids(['A', 'B', 'C']), {});
    assert('and no bytes were read from the file', file.slices === 3);   // the 3 successful slices above
  }

  //  Page-scoped cache and the staleness token

  {
    console.log('\n── page-scoped cache + token ────────────────────────────');
    const lines = ['A', 'B', 'C', 'D'].map(p => line(p, { blob: `dump-of-${p}` }));
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: true });

    sandbox.fullLiveIndex = r.fullIndex;
    sandbox.fullLiveDumps = {};
    sandbox.clientFolderHandle = fakeFolder(fakeIndexFile(bytes));
    sandbox.setIndexFileCache();
    sandbox.setPageDumps({});

    await loadPageDumps(['A', 'B']);
    eq('a page load fills the cache with that page', Object.keys(sandbox.getPageDumps()).sort(), ['A', 'B']);
    eq('resolveProductDump reads the page cache', resolveProductDump('A').blob, 'dump-of-A');
    eq('a pid off the page is not resolvable', resolveProductDump('C'), {});

    // Page 2 renders while page 1's fetch is still in flight.  Page 1 must
    // lose: it is no longer on screen, and its dumps would shadow page 2's.
    const slow = loadPageDumps(['A', 'B']);
    const fast = loadPageDumps(['C', 'D']);
    await Promise.all([slow, fast]);
    eq('the newest page wins', Object.keys(sandbox.getPageDumps()).sort(), ['C', 'D']);
    eq('a stale page cannot overwrite the newer cache', resolveProductDump('D').blob, 'dump-of-D');
    assert('the stale page left nothing behind', !('A' in sandbox.getPageDumps()));

    eq('a superseded load reports that it was dropped', await slow, false);
    eq('the winning load reports that it landed', await fast, true);

    assert('renderAddProductsGrid kicks off the page fetch',
      /function renderAddProductsGrid\(\)[\s\S]{0,2500}loadPageDumps\(/.test(addSrc));
    assert('resolveProductDump consults the page cache',
      /getAddPageDump/.test(extractFn(appSrc, 'function resolveProductDump(')));
  }

  //  A dump that lands after the modal opened

  {
    console.log('\n── late-arriving dump repaints the modal ────────────────');
    const lines = ['A', 'B'].map(p => line(p, { blob: `dump-of-${p}` }));
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: true });

    sandbox.fullLiveIndex = r.fullIndex;
    sandbox.fullLiveDumps = {};
    sandbox.productDumps  = {};
    sandbox.clientFolderHandle = fakeFolder(fakeIndexFile(bytes));
    sandbox.setIndexFileCache();
    sandbox.setPageDumps({});

    // The gap this closes: cards paint synchronously, dumps arrive later.  A
    // reviewer who clicks straight away used to be stuck on "{}" for good.
    const pending = loadPageDumps(['A', 'B']);
    assert('a fetch in flight reports itself pending', addPageDumpsPending() === true);

    sandbox.modalPid = 'A';
    jsonPre.textContent = 'Loading raw payload…';
    searchBox.value = '';
    sandbox.searchCalls = 0;

    await pending;
    assert('the fetch is no longer pending once it lands', addPageDumpsPending() === false);
    assert('the open modal is repainted with the dump that arrived',
      JSON.parse(jsonPre.textContent).blob === 'dump-of-A');
    assert('the placeholder is gone',
      !jsonPre.textContent.includes('Loading'));

    // Re-running against an unchanged payload must not disturb the viewer.
    jsonPre.innerHTML = '<span>highlighted</span>';
    refreshModalDump();
    eq('an unchanged payload is not repainted', jsonPre.innerHTML, '<span>highlighted</span>');

    // A reviewer mid-search must keep their highlights, not get a bare repaint.
    sandbox.modalPid = 'B';
    jsonPre.textContent = '{}';
    searchBox.value = 'dump-of';
    sandbox.searchCalls = 0;
    refreshModalDump();
    eq('an active search is re-run rather than clobbered', sandbox.searchCalls, 1);

    // No modal open, and a product with no dump at all: both are no-ops.
    sandbox.modalPid = null;
    refreshModalDump();
    assert('no open modal is a no-op', true);
    sandbox.modalPid = 'NOPE';
    jsonPre.textContent = '{}';
    searchBox.value = '';
    refreshModalDump();
    eq('an unavailable payload stays empty rather than stuck loading',
      jsonPre.textContent, '{}');

    assert('loadPageDumps repaints the modal when dumps land',
      /function loadPageDumps\([\s\S]{0,900}refreshModalDump\(\)/.test(addSrc));
    assert('openModal shows a placeholder while the payload is in flight',
      /function openModal\([\s\S]{0,3000}addPageDumpsPending\(\)/.test(appSrc));
  }

  //  Added products keep their dump

  {
    console.log('\n── added products retain their dump ─────────────────────');
    const lines = ['A', 'B', 'C', 'D'].map(p => line(p, { blob: `dump-of-${p}` }));
    const bytes = fileBytes(lines);
    const r = await parse(bytes, 64 * 1024, { buildFullLive: true, trackOffsets: true });

    sandbox.fullLiveIndex = r.fullIndex;
    sandbox.fullLiveDumps = {};
    sandbox.clientFolderHandle = fakeFolder(fakeIndexFile(bytes));
    sandbox.setIndexFileCache();
    sandbox.productDumps = {};
    sandbox.setPageDumps({});

    // The page the reviewer is looking at.
    await loadPageDumps(['A', 'B']);
    await persistAddedDumps(['A']);
    eq('a product added from the current page keeps its dump',
      sandbox.productDumps.A.blob, 'dump-of-A');
    eq('only the added product is persisted', Object.keys(sandbox.productDumps), ['A']);

    // Selection survives paging, so a confirm can include pids the page cache
    // no longer holds.  Without the top-up their payload view is empty.
    await loadPageDumps(['C', 'D']);
    await persistAddedDumps(['A', 'C']);
    eq('a product added from an earlier page is re-fetched',
      sandbox.productDumps.A.blob, 'dump-of-A');
    eq('and the current page product is kept too',
      sandbox.productDumps.C.blob, 'dump-of-C');

    // Nothing to fetch and nothing to break.
    sandbox.productDumps = { A: { blob: 'already-here' } };
    await persistAddedDumps(['A']);
    eq('an existing dump is never overwritten', sandbox.productDumps.A.blob, 'already-here');
    await persistAddedDumps(['NOPE']);
    assert('an unknown pid is skipped without throwing', !('NOPE' in sandbox.productDumps));

    assert('confirmAddProducts persists the dumps it added',
      /function confirmAddProducts\([\s\S]{0,3500}persistAddedDumps\(pids\)/.test(addSrc));
  }

  //  Cache-busting -- a stale app.js already cost one debugging cycle

  {
    console.log('\n── cache busting ────────────────────────────────────────');
    const html = fs.readFileSync(path.join(ROOT, 'assortment_checker.html'), 'utf-8');
    assert('app.js is served at v5',          /app\.js\?v=5/.test(html));
    assert('add_products.js is served at v5', /add_products\.js\?v=5/.test(html));
    assert('no v4 script tag left behind',    !/\.js\?v=4/.test(html));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  failures.forEach(f => console.log('  ' + f));
  process.exit(failed ? 1 : 0);
})();
