#!/usr/bin/env python3
"""Preprocess a JSONL catalog + dataset.csv into lightweight JSON files
for the QA Assortment Checker dashboard.

Usage:
  python build_index.py \
    --dataset  dataset.csv \
    --output_dir qa_data/

  By default the catalog is read from historical_index.jsonl in the same
  directory as dataset.csv.  Override with --catalog if needed:

  python build_index.py \
    --catalog  /other/path/catalog.jsonl \
    --dataset  dataset.csv \
    --output_dir qa_data/

Field selection is driven by --field_config (a small JSON file).  When no
config is supplied the script copies every key from each catalog record
into product_index, mirroring the behaviour of feeding the raw catalog
straight to the browser.  Image extraction happens unconditionally.

Recency:
  Records whose `updated_at` is missing or older than 90 days are
  filtered out by `iter_catalog_records()` in scripts/utils.py.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
from typing import Any, Iterable, Optional

from utils import (
    DEFAULT_MAX_AGE_DAYS,
    iter_catalog_records,
    parse_pid_list,
    safe_first,
    safe_list,
)


DEFAULT_INDEX_FIELDS: dict[str, list[str]] = {
    "title": ["title"],
    "brand": ["brand"],
    "color": ["colors", "COLOR"],
    "sizes": ["sizes", "RAW_SIZE"],
    "material": ["MATERIAL"],
    "product_type": ["product_type"],
    "heel_type": ["HEELTYPE"],
    "price": ["PRICE"],
    "category": ["CATEGORY"],
    "occasion": ["OCCASION"],
}

LIST_JOIN_FIELDS = {"color", "sizes", "material", "heel_type", "category", "occasion"}
SCALAR_FIELDS = {"title", "brand", "product_type"}
FIRST_OF_LIST_FIELDS = {"price"}


def load_field_config(path: Optional[str]) -> dict[str, Any]:
    """Load the field configuration that drives index extraction.

    The config supports two top-level keys:

      additional_fields : list[str]
          Extra top-level keys to pass through verbatim into product_index.
      variants_fields : list[str]
          Per-variant keys flattened from `doc["variants"][0]` if present.

    Both default to empty.  When the config file path is None or missing,
    `additional_fields` falls back to `*` (all keys), so first-time runs
    still produce a complete index without surprising users.
    """
    if not path:
        return {"additional_fields": ["*"], "variants_fields": []}
    if not os.path.exists(path):
        print(f"  ⚠ field config not found at {path}; defaulting to all fields")
        return {"additional_fields": ["*"], "variants_fields": []}
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("additional_fields", [])
    cfg.setdefault("variants_fields", [])
    return cfg


def _extract_images(doc: dict, dump: dict) -> list[str]:
    """Collect image URLs from the legacy fields used across retailers."""
    sources = (
        list(safe_list(doc.get("images") or dump.get("images") or [])),
        list(safe_list(doc.get("image_urls") or dump.get("image_urls") or [])),
    )
    images: list[str] = []
    for src in sources:
        for v in src:
            if isinstance(v, str) and v and v not in images:
                images.append(v)
    for key in ("image_url", "image"):
        v = doc.get(key) or dump.get(key)
        if isinstance(v, str) and v and v not in images:
            images.append(v)
    return images


def _build_index_entry(pid: str, doc: dict, cfg: dict[str, Any]) -> dict[str, Any]:
    """Build one product_index entry from a raw catalog record + config."""
    dump = doc.get("product_dump") if isinstance(doc.get("product_dump"), dict) else {}
    images = _extract_images(doc, dump)

    entry: dict[str, Any] = {"product_id": pid}

    for index_key, source_keys in DEFAULT_INDEX_FIELDS.items():
        raw = next((doc.get(k) for k in source_keys if doc.get(k) not in (None, "", [])), None)
        if index_key in LIST_JOIN_FIELDS:
            entry[index_key] = ", ".join(safe_list(raw))
        elif index_key in FIRST_OF_LIST_FIELDS:
            entry[index_key] = safe_first(raw, "")
        elif index_key in SCALAR_FIELDS:
            entry[index_key] = raw or ""
        else:
            entry[index_key] = raw

    additional = cfg.get("additional_fields", []) or []
    if "*" in additional:
        for k, v in doc.items():
            if k == "product_dump":
                continue
            entry.setdefault(k, v)
    else:
        for k in additional:
            if k in doc:
                entry.setdefault(k, doc[k])

    variants_fields = cfg.get("variants_fields", []) or []
    if variants_fields:
        variants = doc.get("variants")
        first_variant = variants[0] if isinstance(variants, list) and variants else {}
        if isinstance(first_variant, dict):
            for k in variants_fields:
                if k in first_variant:
                    entry.setdefault(f"variant_{k}", first_variant[k])

    entry["image_url"] = images[0] if images else ""
    entry["image_count"] = len(images)
    entry["all_images"] = images[:6]
    if "updated_at" in doc:
        entry.setdefault("updated_at", doc["updated_at"])
    return entry


def load_catalog(
    path: str,
    cfg: Optional[dict[str, Any]] = None,
    *,
    max_age_days: Optional[int] = DEFAULT_MAX_AGE_DAYS,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Load a JSONL catalog into two dicts.

    Returns:
        product_index : pid -> light-weight dict for UI rendering / filtering
        product_dumps : pid -> full product_dump (or full doc) for the modal

    Records with stale or missing ``updated_at`` are skipped via the
    shared :func:`iter_catalog_records` generator.
    """
    cfg = cfg or load_field_config(None)
    product_index: dict[str, dict] = {}
    product_dumps: dict[str, dict] = {}

    for _line_num, doc in iter_catalog_records(path, max_age_days=max_age_days):
        pid = doc.get("product_id") or doc.get("id") or doc.get("_id")
        if not pid:
            continue
        pid = str(pid)
        product_index[pid] = _build_index_entry(pid, doc, cfg)
        product_dumps[pid] = doc.get("product_dump") if isinstance(doc.get("product_dump"), dict) else doc

    return product_index, product_dumps


def load_dataset(path: str) -> list[dict[str, Any]]:
    """Load dataset.csv and build a keyword → product mapping list."""
    keywords: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            kw = (row.get("keyword") or "").strip()
            if not kw:
                continue
            prod_ids = sorted(parse_pid_list(row.get("prod_ids", "")))
            tps = parse_pid_list(row.get("pids_to_include", ""))
            fps = parse_pid_list(row.get("pids_to_remove", ""))
            re_pids = sorted(parse_pid_list(row.get("results_editor_re", "")))
            staging_ids = sorted(parse_pid_list(row.get("staging_ids", "")))
            keywords.append({
                "keyword": kw,
                "product_ids": prod_ids,
                "re_product_ids": re_pids,
                "staging_ids": staging_ids,
                "tp_ids": sorted(tps),
                "fp_ids": sorted(fps),
                "total": len(prod_ids),
                "tp_count": len(tps),
                "fp_count": len(fps),
            })
    return keywords


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build lightweight JSON index for QA Assortment Checker"
    )
    parser.add_argument("--catalog", default=None,
                        help="Path to JSONL catalog file (default: historical_index.jsonl "
                             "in the same directory as --dataset)")
    parser.add_argument("--dataset", required=True, help="Path to dataset.csv")
    parser.add_argument("--output_dir", default="qa_data",
                        help="Output directory for JSON files")
    parser.add_argument("--field_config", default=None,
                        help="Optional JSON config selecting which doc fields to project "
                             "(keys: additional_fields, variants_fields). "
                             "When omitted, every top-level key is passed through.")
    parser.add_argument("--max_age_days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                        help=f"Drop records whose updated_at is older than this many days "
                             f"(default: {DEFAULT_MAX_AGE_DAYS}). Use 0 to disable.")
    args = parser.parse_args()

    if args.catalog is None:
        dataset_dir = os.path.dirname(os.path.abspath(args.dataset))
        args.catalog = os.path.join(dataset_dir, "historical_index.jsonl")

    os.makedirs(args.output_dir, exist_ok=True)

    cfg = load_field_config(args.field_config)
    max_age = None if args.max_age_days <= 0 else args.max_age_days

    print(f"→ Loading catalog: {args.catalog}")
    product_index, product_dumps = load_catalog(args.catalog, cfg, max_age_days=max_age)
    print(f"  ✓ {len(product_index)} products indexed")

    print(f"→ Loading dataset: {args.dataset}")
    keywords = load_dataset(args.dataset)
    print(f"  ✓ {len(keywords)} keywords loaded")

    all_pids_needed: set[str] = set()
    for kw in keywords:
        all_pids_needed.update(kw["product_ids"])
        all_pids_needed.update(kw["re_product_ids"])

    missing = all_pids_needed - set(product_index.keys())
    if missing:
        print(f"  ⚠ {len(missing)} product IDs in dataset not found in catalog "
              f"(may be filtered by 90-day recency rule or absent)")
        if len(missing) <= 10:
            for m in sorted(missing):
                print(f"    - {m}")

    found = all_pids_needed & set(product_index.keys())
    print(f"  ✓ {len(found)}/{len(all_pids_needed)} product IDs matched")

    idx_path = os.path.join(args.output_dir, "product_index.json")
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(product_index, f)
    print(f"✅ {idx_path} ({len(product_index)} products)")

    dump_path = os.path.join(args.output_dir, "product_dumps.json")
    with open(dump_path, "w", encoding="utf-8") as f:
        json.dump(product_dumps, f)
    print(f"✅ {dump_path} ({len(product_dumps)} dumps)")

    for p in [idx_path, dump_path]:
        size_kb = os.path.getsize(p) / 1024
        print(f"   {os.path.basename(p)}: {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
