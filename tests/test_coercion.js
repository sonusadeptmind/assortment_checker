/**
 * Coercion / robustness smoke tests for catalog parsing.
 *
 * Loads the actual helpers from app.js into a Node sandbox and feeds them
 * the kinds of malformed values that real client catalogs throw at us:
 * numeric titles, boolean liveness, array brand fields, null prices, objects.
 *
 * The goal is simple: NEVER throw "str.replace is not a function" (or
 * .trim/.split/.toLowerCase variants) regardless of input shape.
 *
 * Run with:  node tests/test_coercion.js
 */

"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Build a sandbox that mirrors what the browser exposes to app.js ──
const sandbox = {
  console,
  document: { getElementById: () => null, createElement: () => ({}) },
  window:   {},
  XLSX:     { read: () => ({ SheetNames: [] }), utils: { sheet_to_json: () => [] } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Pull the helper definitions out of app.js without executing the entire file
// (the module-level code references DOM globals we don't stub).
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf-8');

function extractFn(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature}`);
  // Walk forward and balance braces.
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const fnsToExtract = [
  'function toStr(',
  'function toStrTrim(',
  'function toStrList(',
  'function firstStr(',
  'function firstNonEmpty(',
  'function toBool(',
  'function normalizeProductRecord(',
  'function escapeHtml(',
  'function parsePidList(',
  'function strictContains(',
];

let bundle = '';
for (const sig of fnsToExtract) bundle += extractFn(appSrc, sig) + '\n\n';
vm.runInContext(bundle, sandbox);

// ── Test harness ──
let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log(`  ✅  ${label}`); }
  else      { fail++; console.log(`  ❌  ${label}`); }
}
function noThrow(label, fn) {
  try { fn(); pass++; console.log(`  ✅  ${label}`); }
  catch (e) { fail++; console.log(`  ❌  ${label} — threw: ${e.message}`); }
}

// ── toStr ──
console.log('\n── toStr handles every JSON shape ──');
ok('toStr(null) === ""',         sandbox.toStr(null) === '');
ok('toStr(undefined) === ""',    sandbox.toStr(undefined) === '');
ok('toStr(0) === "0"',           sandbox.toStr(0) === '0');
ok('toStr(123) === "123"',       sandbox.toStr(123) === '123');
ok('toStr(NaN) === ""',          sandbox.toStr(NaN) === '');
ok('toStr(Infinity) === ""',     sandbox.toStr(Infinity) === '');
ok('toStr(true) === "true"',     sandbox.toStr(true) === 'true');
ok('toStr("x") === "x"',         sandbox.toStr('x') === 'x');
ok('toStr([1,2,3]) joins',       sandbox.toStr([1,2,3]) === '1, 2, 3');
ok('toStr({a:1}) is JSON',       sandbox.toStr({a:1}) === '{"a":1}');
ok('toStr(Date) is ISO',         /^\d{4}-/.test(sandbox.toStr(new Date('2024-01-01'))));
ok('toStr(BigInt(7)) === "7"',   sandbox.toStr(7n) === '7');

// ── escapeHtml: the bug that started this whole thread ──
console.log('\n── escapeHtml — the str.replace crash ──');
noThrow('escapeHtml(123)              ', () => sandbox.escapeHtml(123));
noThrow('escapeHtml(true)             ', () => sandbox.escapeHtml(true));
noThrow('escapeHtml(null)             ', () => sandbox.escapeHtml(null));
noThrow('escapeHtml(undefined)        ', () => sandbox.escapeHtml(undefined));
noThrow('escapeHtml([1,"<b>",2])      ', () => sandbox.escapeHtml([1, '<b>', 2]));
noThrow('escapeHtml({brand:5})        ', () => sandbox.escapeHtml({brand: 5}));
ok('escapeHtml(123) === "123"',         sandbox.escapeHtml(123) === '123');
ok('escapeHtml("<x>") escapes',         sandbox.escapeHtml('<x>') === '&lt;x&gt;');
ok('escapeHtml("a&b") escapes amp',     sandbox.escapeHtml('a&b') === 'a&amp;b');
ok("escapeHtml(\"o'k\") escapes apos",  sandbox.escapeHtml("o'k") === 'o&#39;k');

// ── parsePidList — common XLSX/JSON corner cases ──
console.log('\n── parsePidList — every input shape ──');
ok('parsePidList(null) === []',                    JSON.stringify(sandbox.parsePidList(null)) === '[]');
ok('parsePidList(undefined) === []',               JSON.stringify(sandbox.parsePidList(undefined)) === '[]');
ok('parsePidList("") === []',                      JSON.stringify(sandbox.parsePidList('')) === '[]');
ok('parsePidList("nan") === []',                   JSON.stringify(sandbox.parsePidList('nan')) === '[]');
ok('parsePidList("NaN") === []',                   JSON.stringify(sandbox.parsePidList('NaN')) === '[]');
ok('parsePidList("null") === []',                  JSON.stringify(sandbox.parsePidList('null')) === '[]');
ok('parsePidList(12345) === ["12345"]',            JSON.stringify(sandbox.parsePidList(12345)) === '["12345"]');
ok('parsePidList([1,"2",3]) coerces',              JSON.stringify(sandbox.parsePidList([1,'2',3])) === '["1","2","3"]');
ok("parsePidList(\"['a','b']\") splits",           JSON.stringify(sandbox.parsePidList("['a','b']")) === '["a","b"]');
ok('parsePidList("a|b|c") splits',                 JSON.stringify(sandbox.parsePidList('a|b|c')) === '["a","b","c"]');
ok('parsePidList("a, b, c") trims',                JSON.stringify(sandbox.parsePidList('a, b, c')) === '["a","b","c"]');
noThrow('parsePidList({weird:1})    ',             () => sandbox.parsePidList({weird: 1}));
noThrow('parsePidList(true)         ',             () => sandbox.parsePidList(true));

// ── strictContains — also burned by numeric haystacks before ──
console.log('\n── strictContains tolerates non-strings ──');
noThrow('strictContains(123, "12")  ',  () => sandbox.strictContains(123, '12'));
noThrow('strictContains(null, "x")  ',  () => sandbox.strictContains(null, 'x'));
noThrow('strictContains([], "x")    ',  () => sandbox.strictContains([], 'x'));
noThrow('strictContains("x", 123)   ',  () => sandbox.strictContains('x', 123));
ok('strictContains(123,"123") true',   sandbox.strictContains(123, '123') === true);

// ── normalizeProductRecord — the heart of the catalog hardening ──
console.log('\n── normalizeProductRecord catches every catalog variant ──');
const variants = [
  ['null',          null],
  ['undefined',     undefined],
  ['empty obj',     {}],
  ['numeric title', { title: 12345, brand: 678 }],
  ['boolean',       { title: true, brand: false, product_liveness: 0 }],
  ['arrays',        { title: ['fancy','shoe'], brand: ['nike'], colors: ['red','blue'] }],
  ['nested dump',   { product_dump: { title: 'wrapped', brand: 'guess', images: ['https://a/img.jpg'] } }],
  ['liveness "1"',  { product_liveness: '1' }],
  ['liveness "no"', { product_liveness: 'no' }],
  ['object brand',  { brand: { id: 1, name: 'X' } }],
];
for (const [label, raw] of variants) {
  noThrow(`normalize(${label})`.padEnd(34), () => {
    const r = sandbox.normalizeProductRecord(raw, 'pid-1');
    if (typeof r.title    !== 'string') throw new Error('title not string');
    if (typeof r.brand    !== 'string') throw new Error('brand not string');
    if (typeof r.color    !== 'string') throw new Error('color not string');
    if (typeof r.liveness !== 'boolean') throw new Error('liveness not bool');
    if (!Array.isArray(r.all_images))   throw new Error('all_images not array');
    // Crucially: feed the result through escapeHtml — that's the whole reason
    // we did this work, and it must never throw.
    sandbox.escapeHtml(r.title);
    sandbox.escapeHtml(r.brand);
    sandbox.escapeHtml(r.color);
  });
}

// Specific value checks
console.log('\n── normalizeProductRecord field semantics ──');
let r;
r = sandbox.normalizeProductRecord({ title: 12345, brand: 678 }, 'p1');
ok('numeric title coerced',     r.title === '12345');
ok('numeric brand coerced',     r.brand === '678');
ok('liveness defaults true',    r.liveness === true);

r = sandbox.normalizeProductRecord({ product_liveness: 0 }, 'p1');
ok('liveness 0 → false',        r.liveness === false);

r = sandbox.normalizeProductRecord({ product_liveness: '1' }, 'p1');
ok('liveness "1" → true',       r.liveness === true);

r = sandbox.normalizeProductRecord({ product_liveness: 'no' }, 'p1');
ok('liveness "no" → false',     r.liveness === false);

r = sandbox.normalizeProductRecord({ colors: ['red', null, 'blue', 7] }, 'p1');
ok('color array joins safely',  r.color === 'red, blue, 7');

r = sandbox.normalizeProductRecord({ product_dump: { title: 'wrapped', images: ['https://a/x.jpg', 'not-a-url'] } }, 'p1');
ok('dump fallback for title',   r.title === 'wrapped');
ok('image_url picks valid url', r.image_url === 'https://a/x.jpg');

// ── Final tally ──
console.log('\n════════════════════════════════════════════════════════════');
console.log(`  Tests passed: ${pass}`);
console.log(`  Tests failed: ${fail}`);
console.log('════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
