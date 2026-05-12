"""Shared utilities for assortment checker scripts.

Centralises:
  - PID list parsing across the various dataset.csv cell formats
  - Numeric rounding with safe handling of None/non-numeric values
  - Catalog JSONL iteration with the project-wide 90-day updated_at filter
  - Small list/scalar normalisers used by index builders

The 90-day filter is applied at ingest time so that downstream callers
(build_index, evaluate_iteration, the in-browser loader) all share one
recency policy: products whose `updated_at` is older than 90 days, or
missing, are treated as stale and skipped.
"""

from __future__ import annotations

import ast
import json
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator, Optional, Union

DEFAULT_MAX_AGE_DAYS = 90


def parse_pid_list(value: Any) -> set[str]:
    """Parse product ID lists from various formats found in CSV/Excel data.

    Handles:
      - None / NaN / empty strings → empty set
      - Single int/float → {"<int>"}
      - Python list strings: "['pid1', 'pid2']"
      - Comma-separated: "pid1, pid2"
      - Pipe-separated: "pid1|pid2"
      - Newline-separated or semicolon-separated
      - Single bare value

    Args:
        value: Raw cell value (str, int, float, None, or NaN).

    Returns:
        A set of string product IDs, possibly empty.
    """
    if value is None:
        return set()

    try:
        import pandas as pd
        if pd.isna(value):
            return set()
    except (ImportError, TypeError, ValueError):
        pass

    if isinstance(value, float) and value != value:
        return set()

    s = str(value).strip()
    if not s or s in ("nan", ""):
        return set()
    if isinstance(value, (int, float)):
        return {str(int(value))}

    if s.startswith("["):
        try:
            items = ast.literal_eval(s)
            if isinstance(items, list):
                return {str(i).strip() for i in items if str(i).strip()}
        except Exception as e:
            print(
                f"Warning: could not parse list literal, falling back to "
                f"delimiter split: {e}",
                file=sys.stderr,
            )
            s = s.strip("[]")

    s = s.replace("'", "").replace('"', "")

    for sep in ["|", ",", "\n", ";"]:
        if sep in s:
            return {p.strip() for p in s.split(sep) if p.strip()}

    return {s} if s else set()


def safe_round(value: Optional[Union[int, float]], digits: int = 4) -> Optional[float]:
    """Safely round a numeric value, returning None on non-numeric input.

    Args:
        value: The value to round.
        digits: Number of decimal places.

    Returns:
        Rounded float or None if value is not numeric.
    """
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def safe_first(lst: Any, default: Any = "") -> Any:
    """Return the first element of a list, the value itself, or a default.

    Args:
        lst: A list or scalar value.
        default: Fallback when ``lst`` is falsy.

    Returns:
        First element of ``lst`` if it is a non-empty list; ``lst`` itself
        if truthy; otherwise ``default``.
    """
    if isinstance(lst, list) and lst:
        return lst[0]
    return lst if lst else default


def safe_list(val: Any) -> list[str]:
    """Normalise a value to a list of strings, dropping empties.

    Args:
        val: A list, scalar, or None.

    Returns:
        List of string representations, filtering out falsy items.
    """
    if val is None:
        return []
    if isinstance(val, list):
        return [str(v) for v in val if v]
    return [str(val)] if val else []


def parse_updated_at(value: Any) -> Optional[datetime]:
    """Parse an ``updated_at`` value into a timezone-aware UTC datetime.

    Accepts:
      - ISO-8601 strings (with or without ``Z``/offset)
      - "YYYY-MM-DD HH:MM:SS" strings (space separator, treated as UTC)
      - Numeric strings interpreted the same way as bare numbers
      - Numbers as epoch seconds, or epoch milliseconds when > 1e11
      - ``datetime`` instances (made tz-aware as UTC if naive)
      - **Single-element lists** wrapping any of the above; some retailers
        ship ``updated_at`` as ``["2026-05-01 09:39:30"]`` at the top level
        even though ``product_dump.updated_at`` carries the same value as
        a bare string.  We unwrap and recurse.

    Returns ``None`` when the value cannot be parsed.
    """
    if value is None:
        return None
    if isinstance(value, list):
        return parse_updated_at(value[0]) if value else None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        secs = n / 1000.0 if n > 1e11 else n
        try:
            return datetime.fromtimestamp(secs, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            n = float(s)
            secs = n / 1000.0 if n > 1e11 else n
            return datetime.fromtimestamp(secs, tz=timezone.utc)
        except ValueError:
            pass
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def is_recent_update(
    value: Any,
    *,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    now: Optional[datetime] = None,
) -> bool:
    """Return True when ``value`` parses to a datetime within ``max_age_days`` of ``now``.

    Missing / unparseable values return False so callers can choose to
    skip records without a usable ``updated_at``.
    """
    dt = parse_updated_at(value)
    if dt is None:
        return False
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now - dt) <= timedelta(days=max_age_days)


def _doc_updated_at(doc: dict) -> Any:
    """Pull ``updated_at`` from the top level of a JSONL doc, falling back to product_dump."""
    if not isinstance(doc, dict):
        return None
    if "updated_at" in doc:
        return doc.get("updated_at")
    dump = doc.get("product_dump")
    if isinstance(dump, dict) and "updated_at" in dump:
        return dump.get("updated_at")
    return None


def iter_catalog_records(
    path: str,
    *,
    max_age_days: Optional[int] = DEFAULT_MAX_AGE_DAYS,
    now: Optional[datetime] = None,
    on_warning: Optional[Callable[[str], None]] = None,
) -> Iterator[tuple[int, dict]]:
    """Yield ``(line_num, doc)`` pairs from a JSONL catalog, applying the recency filter.

    Records whose ``updated_at`` is missing or older than ``max_age_days``
    are skipped.  Pass ``max_age_days=None`` to disable the filter.

    Counts of malformed / stale / undated lines are printed to stderr at
    end-of-iteration unless ``on_warning`` is supplied (in which case the
    summary line is passed there instead, useful for routing into a UI).
    """
    skipped_malformed = 0
    skipped_stale = 0
    skipped_undated = 0
    yielded = 0
    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError as e:
                skipped_malformed += 1
                if skipped_malformed <= 3:
                    print(
                        f"Warning: malformed JSON on line {line_num} of {path}: {e}",
                        file=sys.stderr,
                    )
                continue
            if max_age_days is not None:
                ts = _doc_updated_at(doc)
                if ts is None:
                    skipped_undated += 1
                    continue
                if not is_recent_update(ts, max_age_days=max_age_days, now=now):
                    skipped_stale += 1
                    continue
            yielded += 1
            yield line_num, doc

    summary = (
        f"iter_catalog_records({path}): kept={yielded} "
        f"skipped_malformed={skipped_malformed} "
        f"skipped_stale={skipped_stale} "
        f"skipped_undated={skipped_undated}"
    )
    if on_warning is not None:
        on_warning(summary)
    else:
        print(summary, file=sys.stderr)
