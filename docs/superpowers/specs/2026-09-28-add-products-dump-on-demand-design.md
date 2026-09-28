# On-demand product dumps for the Add Products page

**Date:** 2026-09-28
**Status:** Approved, not yet implemented
**Repo:** `assortment_checker`

## Problem

Add Products searches the whole live catalog, but a reviewer cannot tell whether a
retrieved product is genuinely relevant to the keyword without seeing its raw
`product_dump` — the attributes, taxonomy and variant data that never make it into
the normalized record.

The pool cannot hold those dumps. That is what this work already fixed (see
"Background"), so dumps must be fetched **on demand, for the ~32 products visible on
the current page only**.

## Background: what already shipped

Two changes landed before this spec. Do not undo them.

1. **The live pool holds records only.** `_parseAnnotationJsonlStream` used to store
   `fullDumps[pid] = docDump` for every live product. On a real catalog that was
   ~9.7 GB of heap and killed the tab. It now stores records alone. A `withDumps`
   option covers the second build path in `ensureFullLiveIndex`.
2. **`record.searchText` was widened** to fold in `tags`, `bullets`, `collections`,
   `product_texts`, `topologies_text`, `HIERARCHY_NAME`, `Sport`, `Activity`,
   `description` and more, deduplicated by whole value (never tokenised — token
   dedup would sort multi-word phrases apart). The Add Products `product_dump`
   filter now matches this blob and is labelled **Any Text**. The main grid's
   `Product Dump` filter is unchanged: it searches real dumps over the bounded
   loaded set via `ensureDumpCache(getBasePids())`.

## Measured facts (real catalog: DSG, `~/Downloads/dsg`)

Do not re-measure these.

| Fact | Value |
|---|---|
| File | `dickssportinggoods_dickssportinggoods.jsonl.gz`, 9.9 GB |
| **Actually gzipped?** | **No** — plain JSON text despite the `.gz` name |
| Total records | 355,114 |
| Live + recent (enter the pool) | 157,110 |
| Pool heap today | ~380 MB (~2,420 bytes/record) |
| `product_dump` size | ~24.2 KB/record |
| Largest single line | 2,749,698 bytes (2.6 MB) |
| A page of 32 dumps | ~775 KB |

A zero-byte `*.jsonl` stub sits beside the real file; `findHistoricalIndexFile`
already skips it via its `f.size > 0` guard.

## Goal

After a search returns results, the ~32 products rendered on the current page have
their full `product_dump` available for inspection, fetched without rescanning the
file and without retaining anything beyond the current page.

## Approach: byte-offset index + `File.slice()`

During the single parse the app already performs, record each product's
`[byteOffset, byteLength]` within the file. Fetching a dump then becomes:

```js
const text = await indexFile.slice(rec.off, rec.off + rec.len).text();
const doc  = JSON.parse(text);
```

Instant, no rescan, nothing retained beyond the visible page.

**Cost:** two numbers per record on top of the existing ~380 MB — roughly 10 MB.

**Constraint:** offsets address the *file*, so they are only usable when the stream
is not decompressed. `_loadAnnotationIndex` already sniffs gzip from a 4-byte peek.
When the source really is gzipped, offsets must be withheld and the feature
reported unavailable rather than silently returning wrong slices.

### Why splitting on `\n` in the byte domain is safe

UTF-8 is self-synchronizing: every continuation byte has the high bit set, so the
byte `0x0A` can only ever be a real ASCII newline and never part of a multi-byte
character. Splitting the raw `Uint8Array` on `0x0A` therefore never splits a
character, and each complete line can be decoded independently with a single
reused `TextDecoder`. This is what makes the rewrite tractable.

### Parse loop change

`_parseAnnotationJsonlStream` currently pipes through `TextDecoderStream` and
accumulates a `remainder` string, which discards byte positions. Replace with
byte-domain chunking:

- read raw `Uint8Array` chunks from the reader (no `TextDecoderStream`)
- keep `carry` (bytes of a partial line) and `absOffset` (file offset of `carry[0]`)
- scan each chunk for `0x0A`; for every complete line decode `bytes[s..e)` and pass
  `(line, absOffset + s, e - s)` to `processLine`
- leftover bytes become the new `carry`; advance `absOffset`
- at stream end, flush a trailing line with no newline

Gate offset recording behind a `trackOffsets` option so callers that cannot use it
(gzip) pay nothing.

### Storage

Store on the record: `record.off`, `record.len`. This avoids a second structure and
rides the existing IndexedDB cache for free — the cache key already includes file
name, size and `lastModified`, so cached offsets cannot outlive the file they
describe. **Bump the cache key to `v4`** as part of this change; `v3` entries have
no offsets and would leave the feature silently dead on a cache hit.

### Fetch API

```js
async function fetchDumpsForPids(pids) // -> { pid: dumpObject }
```

- Resolve the index `File` once via `clientFolderHandle` + `findHistoricalIndexFile`
  (mirroring `ensureFullLiveIndex`) and memoize it.
- Skip any pid whose record has no `len` (gzip source, or not in the pool).
- Run with a small concurrency cap (4–8) rather than 32 parallel slices.

### Wiring

- `renderAddProductsGrid` renders a page, then kicks off `fetchDumpsForPids` for the
  visible pids into a **page-scoped** cache. Guard with a monotonically increasing
  token so a slow fetch for page 3 cannot overwrite page 4's results.
- `resolveProductDump` consults that page cache.
- `confirmAddProducts` currently copies from `getAddSourceDumps()`, which is now `{}`
  in annotation mode — it must persist the fetched dump into `productDumps` for the
  products actually added, or re-fetch them on confirm. **Without this the payload
  view is empty for every newly added product.**

## Files

| File | Change |
|---|---|
| `app.js` | byte-domain loop in `_parseAnnotationJsonlStream`; `trackOffsets` option; `off`/`len` on records; cache key `v4` |
| `add_products.js` | `fetchDumpsForPids`; page-scoped dump cache + token; render wiring; `confirmAddProducts` persistence |
| `assortment_checker.html` | bump `?v=4` → `?v=5` on `app.js` and `add_products.js` |
| `tests/test_byte_offsets.js` | new |

**Cache-busting is not optional.** `app.js` originally had no version param, and a
stale copy already cost one full debugging cycle in which a fix appeared to make
things worse. Bump it in the same commit as the code change.

## Test plan (TDD — write failing first)

Offsets:
- ASCII-only file: `slice(off, off+len)` round-trips to the exact original line
- a multi-byte character (accents, emoji) earlier in the file shifts later offsets by
  **bytes, not characters**
- a chunk boundary that splits a multi-byte character
- a chunk boundary that splits a line
- final line with no trailing newline
- blank and whitespace-only lines do not corrupt subsequent offsets
- property test: synthetic file, every record round-trips

Behaviour:
- `trackOffsets: false` (and gzip) → records carry no `off`/`len`; feature reports
  unavailable rather than slicing wrongly
- `fetchDumpsForPids` returns only requested pids; unknown pid omitted, no throw
- stale page fetch cannot overwrite a newer page's cache
- added products retain their dump in `productDumps` after confirm
- existing suites stay green: 10 JS files, 190 Python tests

## Non-goals

- Restoring bulk dump *search* across the catalog. **Any Text** covers that.
- Random access into genuinely gzipped catalogs.
- Changing the main grid's `Product Dump` filter.

## Verification

1. Hard reload; confirm `?v=5` is served.
2. Load raw `~/Downloads/dsg`; counter should reach ~157,000 and complete.
3. Search in Add Products, open a product, confirm the raw payload is populated.
4. Page forward quickly; confirm no cross-page contamination.
5. Add a product; confirm its payload view still works in the main grid.
