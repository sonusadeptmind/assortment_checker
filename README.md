# Search Assortment QA Framework

A browser-based QA dashboard for reviewing search assortments, paired with an evaluation script for tracking model performance across iterations.

The dashboard supports two modes — **iteration QA** (default) and **annotation** (golden-dataset relevance grading) — auto-detected from the CSV filename in the data folder you load.

---

## Quick Start

```bash
pip install -r requirements.txt
bash run_app.sh
```

Serves the dashboard at `http://localhost:8000/assortment_checker.html`.

Click **Load Data Folder** in the sidebar and select your input folder. The mode is determined by the CSV that's in the folder:

| CSV filename | Mode |
|---|---|
| `dataset.csv` | Iteration QA |
| `golden_dataset_labelled_desc*.csv` | Annotation |

---

## Historical-index recency filter (both modes)

Every JSONL historical-index file (`catalog.jsonl`, `historical_index.jsonl`, `{retailer}_historical_index.jsonl`) is filtered at load time:

> **Only records whose `updated_at` is within the last 90 days are ingested.** Records that are older or have no `updated_at` are dropped, and the count of skipped records is shown in the load notification.

`updated_at` is read from the top of each JSON record first, then from `product_dump.updated_at` as a fallback. Values can be ISO-8601 strings, `YYYY-MM-DD HH:MM:SS` strings (treated as UTC), epoch seconds, epoch milliseconds, or single-element lists wrapping any of those.

To tune or disable the filter for `build_index.py` / `evaluate_iteration.py`, pass `--max_age_days <N>` (use `0` to disable).

---

# What We're Measuring

Four metrics evaluate landing-page quality, and the QA grades you assign in this dashboard are the input signal for all of them.

| Metric | Question it answers | Target |
|---|---|---|
| **Precision** | Of the products we show, what fraction are actually relevant? | Monitored |
| **Recall** | Of the products we should show, how many did we include? | Monitored |
| **F1** | Is the relevance classifier balancing precision and recall well? | ≥ 80% |
| **nDCG@8** | Are the best (grade-2) products at the top of the first 8 positions? | ≥ 80% |

- **Precision** and **Recall** use binary relevance — grade **1 or 2** counts as relevant, grade **0** does not. **F1** is the harmonic mean of the two.
- **nDCG@8** uses the full 0 / 1 / 2 graded scale across the first 8 ranking positions, so placing a grade-2 product at position 7 is penalised even if it's "on the page."
- Every evaluation must report **per-retailer breakdowns** as well as the aggregate — a strong overall score can hide a single retailer that's underperforming.

> Full definitions, worked examples, target rationale, and evaluation rules (golden-dataset holdout, no relabelling, etc.) live in **OKR1 — Canonical Metrics Definition Document** (DLP ML team). This README intentionally keeps metric definitions short — defer to the OKR doc for anything ambiguous.

---

# Relevance Grades (0 / 1 / 2)

Both Iteration Mode and Annotation Mode use the **same graded relevance scale**. A grade captures how relevant a product is for a given keyword — think of it as a relevance quality score, not a pass/fail flag.

| Grade | Label | Definition | Aligns with |
|------:|---|---|---|
| **0** | Not relevant | The product does not match the keyword in any meaningful way. | `relevance = False` |
| **1** | Relevant | The product is related to the keyword and is a reasonable result, but it's not the best possible match. May be a related category, a partial match, or a substitute. | `relevance = True` |
| **2** | Perfect | The product is an exact or near-exact match for the keyword. A user searching this term would be very satisfied with this result. | `relevance = True` |

## Why grades matter — model training signal

These grades are the supervised signal used to train the ranking model. They don't just say "include / exclude" — they also encode **ordering**:

- Grade **2** products are pushed to the **top** of the result list (the model learns to rank them highest).
- Grade **1** products come **after** the grade-2 set (relevant, but ranked below the perfect matches).
- Grade **0** products are penalised away from the result set.

In other words, the grades tell the model not just *which* products belong, but in *what order* they should appear. Spending the extra second to choose between 1 and 2 directly improves ranking quality — a card you grade 2 will outrank a card you grade 1 in production.

> **Default state:** Unlabeled. QA only acts on cards that need a grade. Cards left unlabeled at export are treated as approved-by-default in iteration mode and as ungraded in annotation mode.

---

# Iteration Mode

## Input Folder

For a first iteration, your folder should contain:

| File | Required | Description |
|---|---|---|
| `dataset.csv` | ✅ | Keywords and product IDs |
| `catalog.jsonl` | ✅ | Raw vendor catalog (one JSON object per line) |
| `new_iteration.xlsx` | ✅ | New model output to QA against |

For subsequent iterations, `product_index.json` + `product_dumps.json` (generated by `build_index.py`) can replace `catalog.jsonl` for faster load times.

> If any file fails to load, detailed diagnostics are printed to the **browser console** (DevTools → Console).

## dataset.csv Format

| Column | Required | Description |
|---|---|---|
| `keyword` | ✅ | Search query |
| `prod_ids` | ✅ | Current live product IDs |
| `results_editor_re` | ✅ | New candidate product IDs being QA'd |
| `staging_ids` | optional | Staging baseline product IDs |
| `pids_to_include` | optional | Known true positives from prior iterations |
| `pids_to_remove` | optional | Known false positives from prior iterations |
| `manual_qa_status` | optional | `TRUE` / `FALSE` |

PID lists accept `pid1|pid2|pid3`, `pid1,pid2,pid3`, or `['pid1','pid2']` format.

## catalog.jsonl Format

One JSON object per line. Required fields: `product_id` (or `id`) and `updated_at` (top level or inside `product_dump`).

| Field | Description |
|---|---|
| `product_id` / `id` | Product identifier (required) |
| `updated_at` | Last update timestamp; required for the 90-day filter |
| `product_liveness` | `true` = in-stock, `false` = out of stock (required by evaluation script) |
| `title` | Product title |
| `brand` | Brand name |
| `images` / `image_url` | Image URLs |
| `colors` / `COLOR` | Color values |
| `MATERIAL` | Material / fabric |
| `product_type` | Product type |
| `PRICE` | Price |
| `OCCASION` | Occasion tags |
| `product_dump` | Full raw vendor data (shown in detail view) |

## new_iteration.xlsx Format

Excel workbook with two required sheets:

**"Hash key" sheet** — identifies this iteration uniquely:

| Column | Description |
|---|---|
| `hash_key` | A UUID string (e.g. `550e8400-e29b-41d4-a716-446655440000`) that uniquely identifies this iteration. Generated once per iteration by the ML engineer. |

**Sheet whose name contains "combined"** — the new model output:

| Column | Description |
|---|---|
| `original_keyword` | Search keyword (must match `dataset.csv`) |
| `product_ids` | New model output product IDs (pipe-separated) |

When the file is loaded, the dashboard reads the `hash_key` value and sets it as the active **Iteration ID**, shown as a truncated badge in the top-right (hover to see the full UUID). The iteration ID is persisted in `qa_metadata.json` so it survives page reloads. If the "Hash key" sheet is missing or empty, a warning notification is shown and the iteration ID displays as `—`.

> **Successive iterations:** update both `dataset.csv` and `new_iteration.xlsx` (with a new UUID in the Hash key sheet), then reload the folder. The dashboard picks up the new hash automatically.

## Reviewing Products

Iteration mode now uses the same **0 / 1 / 2 grading scale** as annotation mode (see [Relevance Grades](#relevance-grades-0--1--2) above). Each card gets a graded relevance label rather than a binary approve/disapprove.

- **Grade a card** — hover a card to see the quick-grade pills `[ 0 ] [ 1 ] [ 2 ]`, or open the detail view for the full grade buttons.
- **Grade 0** opens the reason form — a reason is required (Wrong Category / Gender / Brand / Ambiguous / Attribute Mismatch / Other).
- **Grade 1** and **Grade 2** apply immediately. Use 2 for exact / near-exact matches and 1 for reasonable-but-not-best matches.
- **Bulk actions** — use Select All or checkboxes, then **Bulk 0 / Bulk 1 / Bulk 2** in the toolbar. Bulk-0 opens the shared reason modal; Bulk-1 and Bulk-2 apply immediately.
- Filters and the Prior Iterations toggle are automatically cleared after every bulk action.

**Grade-0 reasons:** Wrong Product Category · Wrong Gender · Wrong Brand · Ambiguous product data · Attribute mismatch (Material / Occasion / Other) · Other (free-text)

**Detail view** — click any card to open. Includes full product dump JSON with searchable fields and ↑ ↓ navigation across matches.

> Cards left ungraded at export are treated as approved-by-default for backwards compatibility with the previous Approve/Disapprove workflow.

### Filtering

The toolbar has a single unified filter bar: **Filter By** → **Operator** → **Value**.

| Filter By | Value input | Notes |
|---|---|---|
| Product Dump *(default)* | Debounced text box | Searches full raw JSON of the product |
| Title | Debounced text box | Searches product title |
| Description | Debounced text box | Searches description / body_html |
| Brand, Color, Product Type, Material, Occasion | Auto-populated dropdown | Exact token match on comma-separated field values |
| Grade | Dropdown: 0 / 1 / 2 / Unlabeled | Filters by graded relevance (both iteration and annotation mode) |

**Operator:** `contains` or `does not contain` — applies to all field types.

Selecting a new field clears the previous filter. Clear button resets to the default state (Product Dump / contains).

### Toolbar Toggles

| Toggle | Default | Description |
|---|---|---|
| 👁 Show Labeled | Off | Shows products in the current review set that have already been graded (any of 0, 1, or 2) |
| 🕑 Prior Iterations | Off | (Iteration mode only) Shows products from previous iterations (`tp_ids` / `fp_ids` in `dataset.csv`) that are not in the current review set. These appear with a dashed border and a **PRIOR** badge. Resets when switching keywords or clearing filters. |

> **Metrics (Total / Approved / Disapproved / Hit Rate) always reflect the current review set only**, even when the Prior Iterations toggle is on. Prior cards are for human reference and do not affect metric computation — this keeps evaluation signal clean and consistent across iterations.

### User Selection

On first load a banner appears at the bottom of the screen prompting you to select your name. The selection is saved to browser `localStorage` and restored automatically on subsequent visits — no need to re-select after reloading the page or loading a new data folder.

## Saving & Exporting

| Button | Output | Description |
|---|---|---|
| 📥 Export CSV | `outputs/dataset.csv` | Updated dataset with graded labels |
| 💾 Save | `outputs/qa_metadata.json`, `labels_store.json`, `iteration_history.json` | Full session state |
| 📤 Import | — | Restore a saved `qa_metadata.json` |

**Export CSV columns** (graded labels are bucketed for backwards-compatible TP / FP semantics):

- `pids_to_include` — all PIDs graded **1** or **2** for the keyword (relevant)
- `pids_to_remove` — all PIDs graded **0** for the keyword (not relevant)
- `pids_grade_2` — PIDs graded **2** (perfect / near-exact match) — used by the ranker to learn top-of-list ordering
- `pids_grade_1` — PIDs graded **1** (relevant but not best) — ranked below grade-2 PIDs
- `manual_qa_status` — TRUE if Mark QA Done was clicked

---

# Tranche QA

A lightweight, day-to-day operational workflow for grading model output to monitor ongoing model health. Use this when QA'ing a regular tranche (daily / weekly) of keywords — there's no `new_iteration.xlsx`, no hash key, no prior-iteration history. Just the model's current candidates for a set of keywords.

Tranche QA runs under iteration mode (the file is still `dataset.csv`), but only the two columns below need to be populated.

## When to use

- Routine cadence checks against the live model (sanity / regression watch).
- Spot-checking a slice of keywords before a full iteration cycle is run.
- Operational QA where the goal is "is the model healthy today?" rather than "is iteration N better than N-1?".

## Input Folder

| File | Required | Description |
|---|---|---|
| `dataset.csv` | ✅ | Tranche keywords + candidate product IDs |
| `catalog.jsonl` | ✅ | Vendor catalog (subject to the 90-day `updated_at` filter) |

No `new_iteration.xlsx` is needed. The Iteration ID badge will show `—`.

## dataset.csv Format (Tranche)

Only the two columns below are required. All other iteration-mode columns may be empty or omitted.

| Column | Required | Description |
|---|---|---|
| `keyword` | ✅ | Search query |
| `results_editor_re` | ✅ | Candidate product IDs returned by the model for that keyword |

PID lists accept `pid1|pid2|pid3`, `pid1,pid2,pid3`, or `['pid1','pid2']` format (same as iteration mode).

> Same column as iteration mode — Tranche QA is a different *usage* of `results_editor_re`, not a different schema. No code changes are needed to switch between the two flows.

### Sample

| keyword | results_editor_re |
|---|---|
| running shoes | 1001\|1002\|1003\|1004 |
| black t-shirt | 2010,2011,2012 |
| winter coat | ['3050','3051','3052'] |
| leather wallet | 4400\|4401 |

## Workflow

```
1. Drop the day's dataset.csv + catalog.jsonl into a folder
2. Load the folder in the dashboard
3. Per keyword: grade each card 0 / 1 / 2 → Mark QA Done
     - 0 = not relevant (reason required)
     - 1 = relevant, not best
     - 2 = perfect / near-exact match
4. 💾 Save → 📥 Export CSV
5. Hand the exported dataset.csv back to ML/Ops
   - pids_to_remove = grade-0 PIDs (FP feedback)
   - pids_grade_1 / pids_grade_2 = ranking signal for the next training run
   - manual_qa_status = TRUE for keywords you finished
```

Tranche owners are tracked via the active user (selected in the bottom banner on first load) and the timestamp in `qa_metadata.json`.

---

# Annotation Mode

Lets reviewers assign a graded relevance label per `(keyword, product_id)` row in a shared golden-dataset CSV. Each reviewer's labels live in `{user}_*` columns so the QA team can collaborate on a single shared file without overwriting each other.

Annotation mode uses the shared **0 / 1 / 2 grading scale** — see [Relevance Grades](#relevance-grades-0--1--2) for definitions and how grades drive model training.

## Input Folder

```
qa_data/
├── golden_dataset_labelled_desc.csv          ← all retailers, all (kw, pid) pairs in one file
├── gap_historical_index.jsonl                ← one per retailer
├── oldnavy_historical_index.jsonl
├── revzilla_historical_index.jsonl
└── ...
```

Each `{retailer}_historical_index.jsonl` is the same shape as iteration-mode `catalog.jsonl` (see above) and is subject to the same 90-day `updated_at` filter.

## Golden-dataset CSV Format

### Input columns

| Column | Required | Notes |
|---|---|---|
| `keyword` | ✅ | Search query |
| `product_id` | ✅ | Single product ID (one row per pair) |
| `retailer` | ✅ | Used to pick the right `{retailer}_historical_index.jsonl` and to scope the keyword list |
| `{user}_graded_relevance` | optional | Existing labels per reviewer — seeded into memory on load, editable by that reviewer when active |
| `{user}_reason` / `{user}_reason_other_text` / `{user}_attribute` / `{user}_attribute_other_text` | optional | Reason fields for that reviewer's grade-0 rows |
| `{user}_qa_done` | optional | TRUE / FALSE — that reviewer's QA-done state per row |
| `{user}_timestamp` | optional | ISO timestamp of that reviewer's most recent label change |
| Any other columns | optional | Passed through unchanged on export |

The `retailer` column is lowercased and trimmed before matching against `{retailer}_historical_index.jsonl` filenames. Empty values fall into a bucket called `_unknown` and trigger a warning rather than dropping the row.

### Output (export)

`📥 Export CSV` writes back to `outputs/golden_dataset_labelled_desc.csv` (input filename preserved). Behavior:

1. Every input column is preserved verbatim.
2. The active user's `{user}_*` columns are written from the in-memory store.
3. New `{user}_*` columns are auto-added when the active user labels a row that didn't have a column for them yet.
4. Other reviewers' columns pass through byte-for-byte unchanged.

## Reviewing Products

The detail modal replaces 🚫 Disapprove / ✅ Approve with three grade buttons:

```
[ 0 — Not relevant ]   [ 1 — Relevant ]   [ 2 — Perfect ]
```

- Clicking **1** or **2** records the grade immediately under the active user.
- Clicking **0** opens the existing reason form (Wrong Category / Gender / Brand / Ambiguous / Attribute Mismatch / Other) — same as iteration-mode disapproval.

Hovering a card shows three grade pills `[ 0 ] [ 1 ] [ 2 ]` for quick grading. A graded card displays a colored chip with the grade — clicking the chip re-opens the selector to relabel.

## Retailer Dropdown

The topbar exposes a **Retailer:** dropdown populated from the unique `retailer` values in the loaded CSV (alphabetic order, first one selected by default). Switching the retailer:

1. Re-slices golden rows by retailer → rebuilds `keywords[]`.
2. Reads `{retailer}_historical_index.jsonl` → builds a filtered product index containing only PIDs in the active retailer's slice.
3. Re-renders the keyword list and grid.

Reviewer label data lives in memory keyed by user (not retailer), so switching retailers doesn't lose work and switching the User dropdown doesn't require a save first.

If `{retailer}_historical_index.jsonl` is not in the folder, a warning notification is shown and cards render with "Product not in catalog" placeholders — graders can still label by `keyword + pid`.

## Sidebar Counters & Metrics

Per-keyword counts in the sidebar show as `12 · 4/6/2` (total · 0-count / 1-count / 2-count for the active user).

Topbar metrics in annotation mode:

| Pill | Meaning |
|---|---|
| Total | Total `(keyword, pid)` pairs in the active retailer's slice |
| Grade 0 / 1 / 2 | Count of each grade for the active user |
| Labeled % | Fraction of rows the active user has graded |

## Bulk Grading

Three bulk buttons in place of two:

```
[ Bulk grade 0 ]   [ Bulk grade 1 ]   [ Bulk grade 2 ]
```

- **Bulk-0** opens the existing bulk reason modal.
- **Bulk-1 / Bulk-2** apply immediately.
- Filters reset after every bulk action (same behavior as iteration mode).

## Add Products

The **➕ Add Products** dialog lets you pull *still-live* products from the retailer's historical index into the active keyword (defaulting to **grade 1 / Relevant** in annotation mode, **Approved** in iteration mode) — useful when a relevant product was missing from the original assortment.

- **Search** matches a curated field set (title, brand, type, color, material, occasion, category). For a deep search across the full product JSON, switch the filter field to **Product Dump**.
- Only live products are shown; anything already tied to the keyword is excluded.
- Added products are written back on CSV export (a golden row is appended so the addition survives a round-trip).

See [Performance → Annotation-mode index loading & Add Products](#annotation-mode-index-loading--add-products) for the single-pass build, IndexedDB cache, and progress loaders behind this.

## Save / Import / Merge

Same buttons as iteration mode; payloads differ:

| File | Annotation-mode contents |
|---|---|
| `qa_metadata.json` | `appMode`, `activeRetailer`, `gradedLabels[user]`, `qaDone[user]` |
| `labels_store.json` | one record per `(user, keyword, product_id)` with grade + reason fields |
| `iteration_history.json` | append-only log of save events |
| `keyword_metrics.json` | per-keyword 0/1/2 counts and labeled % for the active user |

The 2-person merge panel works on `gradedLabels` for the active retailer with the same conflict rule (different grades from A/B → null + flagged in the conflict table). With shared-file workflow, merge becomes a less-needed escape hatch but stays for compatibility.

---

# Pre-building the Product Index (optional, for faster loads)

```bash
python scripts/build_index.py \
  --catalog        /path/to/catalog.jsonl    \
  --dataset        /path/to/dataset.csv      \
  --output_dir     /path/to/input_folder/    \
  [--field_config  /path/to/fields.json]     \
  [--max_age_days  90]
```

Writes `product_index.json` and `product_dumps.json` into the output dir. On subsequent runs, load this folder instead of `catalog.jsonl` — it loads significantly faster.

`--field_config` accepts a JSON file selecting which doc fields to project into the index:

```json
{
  "additional_fields": ["AGE", "GENDER", "tags"],
  "variants_fields":   ["sku", "barcode", "price"]
}
```

`additional_fields` are extra top-level keys to pass through verbatim. `variants_fields` are pulled from `doc.variants[0]` (if present) and prefixed with `variant_`. When the flag is omitted, every top-level key passes through (`additional_fields: ["*"]`).

`--max_age_days` overrides the 90-day recency filter (use `0` to disable).

---

# Evaluation Script

```bash
python scripts/evaluate_iteration.py \
  --dataset       /path/to/dataset.csv        \
  --new_iteration /path/to/new_iteration.xlsx \
  --catalog       /path/to/catalog.jsonl      \
  --iteration_num 2                           \
  --output_dir    /path/to/outputs/           \
  --label_store   /path/to/outputs/labels_store.json
```

`--catalog` is required. The script reads `product_liveness` from the catalog to determine stock status for each product — `true` = in-stock, `false` = out of stock. Products not present in the catalog are assumed in-stock. Catalog ingestion uses the same 90-day `updated_at` filter as the dashboard.

Outputs `iteration_N_report.xlsx` with two tabs:

- **Summary** — per-keyword Precision, Recall, F1, label coverage, TP retention, FP elimination, regression flags, and `manual_qa_status`. Aggregate metrics (F1, Precision, Recall) are averaged only over keywords where `manual_qa_status = TRUE` — the aggregate row shows how many keywords contributed (e.g. `5 of 12 QA'd`).
- **Dataset** — Updated `dataset.csv` ready for the next iteration, with `pids_to_check` highlighted

---

# Iteration Workflow

```
1. Receive new_iteration.xlsx from ML engineer
2. Load your input folder in the dashboard
3. Review each keyword — grade cards 0 / 1 / 2, click Mark QA Done
4. 💾 Save → 📥 Export CSV
5. Run scripts/evaluate_iteration.py
6. Share Summary tab metrics with ML engineer
```

---

# Architecture

## Design Principles

1. **Work on small working sets** — only load products relevant to a keyword; never load the entire catalog.
2. **Default = Approved (iteration) / Unlabeled (annotation)** — QA only acts on cards that need attention.
3. **Structured disapproval / grade-0** — every disapproval / grade-0 must have a reason.
4. **Index + Lazy Load** — lightweight `ProductIndex` data for UI rendering and filtering; full `ProductDump` fetched only on product click and cached in memory.

## Data Flow

```
Keyword selected
    ↓
Fetch ProductIndex using product_ids
    ↓
Store in frontend memory (all filtering happens locally)
    ↓
On product click → lazy-load ProductDump (cached after first fetch)
```

## Performance

A typical session loads 50–500 products (~100–200 KB in memory). Key rules: fetch only relevant `product_ids`, filter on `ProductIndex` fields only, never filter on raw JSON dumps, and cache `ProductDump` objects after first fetch.

The 90-day historical-index filter typically drops a meaningful chunk of stale records (often a third or more of a multi-month catalog), shrinking what the browser holds in memory.

### Annotation-mode index loading & Add Products

The `{retailer}_historical_index.jsonl` files can be large, and the **Add Products** dialog needs the *whole* live catalog (not just golden-set PIDs). To keep loads fast and the UI responsive:

- **Single-pass index build** — one stream of the file builds *both* the golden-set index (the review grid, any liveness) and the full live pool (Add Products). Opening Add Products triggers **no second file read**.
- **IndexedDB cache** — the parsed index is cached (DB `qa_assortment_cache`); a repeat load of the same retailer skips the parse entirely and loads near-instantly. The cache key combines file identity (name + size + last-modified), a day-stamp (so the date-relative 90-day filter can't serve stale data across days), and a hash of the golden-PID set (editing the CSV re-parses). It's best-effort — private mode, quota limits, or no IndexedDB silently fall back to parsing — and keeps at most one entry per retailer.
- **Precomputed `searchText`** — each record carries a short, lowercased search string (title, brand, type, color, material, occasion, category). The Add Products free-text box searches that, not multi-KB raw dumps. For deep dump search, set the filter field to **Product Dump**, which scans the full dump JSON lazily (only for candidates that already passed the search/attribute filters).
- **Progress loaders** — the loading overlay shows a live count while the index is being built (`Building <retailer> index… N live products`) and `Loading cached index…` on a cache hit; the Add Products dialog shows a `Searching…` indicator while a search/filter recomputes.

---

# File Structure

```
assortment_checker/
├── assortment_checker.html   # Dashboard UI
├── app.js                    # Dashboard logic
├── merge.js                  # Two-person merge panel
├── styles.css                # Styles
├── run_app.sh                # Server launcher
├── requirements.txt          # Python dependencies
├── annotation/               # Annotation-mode modules (loaded before app.js)
│   ├── data.js               # gradedLabels store, recency helpers
│   ├── csv.js                # Parse/emit {user}_* columns, retailer slicing
│   ├── render.js             # Grade pills, badge chips, sidebar counter
│   └── bulk.js               # Bulk grade-0/1/2 handlers
├── vendor/
│   └── xlsx.full.min.js      # SheetJS 0.18.5 (vendored, version comment in file header)
├── scripts/
│   ├── utils.py              # parse_pid_list, safe_round, iter_catalog_records (90-day filter)
│   ├── build_index.py        # catalog.jsonl → product_index.json + product_dumps.json
│   └── evaluate_iteration.py # Precision / Recall / F1 reporting
└── tests/
    ├── test_combine_outputs.py
    ├── test_scripts.py
    ├── test_filters.js
    ├── test_metrics.js
    └── annotation/
        ├── test_annotation.js
        ├── test_recency_filter.js
        ├── golden_dataset_labelled_desc_test.csv
        ├── gap_historical_index.jsonl
        └── oldnavy_historical_index.jsonl
```

The Inter font is loaded from Google Fonts; SheetJS is the only vendored asset.
