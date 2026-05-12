"""Functional pytest tests for scripts/utils.py and scripts/evaluate_iteration.py.

Run with:  python -m pytest tests/test_scripts.py -v
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from utils import (
    is_recent_update,
    iter_catalog_records,
    parse_pid_list,
    parse_updated_at,
    safe_first,
    safe_list,
    safe_round,
)


@pytest.mark.parametrize("value,expected", [
    pytest.param(None, set(), id="none"),
    pytest.param(float("nan"), set(), id="nan-float"),
    pytest.param("", set(), id="empty-string"),
    pytest.param("   ", set(), id="whitespace-only"),
    pytest.param("nan", set(), id="nan-string"),
    pytest.param(42, {"42"}, id="single-int"),
    pytest.param(42.0, {"42"}, id="single-float"),
    pytest.param("abc123", {"abc123"}, id="single-string"),
    pytest.param("['pid1', 'pid2', 'pid3']", {"pid1", "pid2", "pid3"}, id="single-quoted-list"),
    pytest.param('["a", "b"]', {"a", "b"}, id="double-quoted-list"),
    pytest.param("[1, 2, 3]", {"1", "2", "3"}, id="ints-in-list"),
    pytest.param("pid1, pid2, pid3", {"pid1", "pid2", "pid3"}, id="comma-separated"),
    pytest.param("pid1|pid2|pid3", {"pid1", "pid2", "pid3"}, id="pipe-separated"),
    pytest.param("pid1;pid2;pid3", {"pid1", "pid2", "pid3"}, id="semicolon-separated"),
    pytest.param("pid1\npid2\npid3", {"pid1", "pid2", "pid3"}, id="newline-separated"),
    pytest.param("  pid1 , pid2 , pid3 ", {"pid1", "pid2", "pid3"}, id="strips-whitespace"),
    pytest.param("pid1,,pid2,", {"pid1", "pid2"}, id="filters-empty-items"),
    pytest.param("'pid1','pid2'", {"pid1", "pid2"}, id="strips-quotes"),
    pytest.param("  abc  ", {"abc"}, id="single-string-with-spaces"),
    pytest.param("[]", set(), id="empty-list-string"),
])
def test_parse_pid_list(value, expected):
    assert parse_pid_list(value) == expected


def test_parse_pid_list_malformed_list_falls_back_to_split():
    """A bracket-wrapped string that isn't valid Python falls back to delimiter split."""
    result = parse_pid_list("[pid1, pid2")
    assert "pid1" in result
    assert "pid2" in result


def test_parse_pid_list_pandas_nan():
    pd = pytest.importorskip("pandas")
    assert parse_pid_list(pd.NA) == set()


@pytest.mark.parametrize("value,digits,expected", [
    (0.123456, 4, 0.1235),
    (3, 2, 3.0),
    (None, 4, None),
    ("abc", 4, None),
    ("3.14159", 2, 3.14),
    (0, 4, 0.0),
    (-0.6789, 2, -0.68),
])
def test_safe_round(value, digits, expected):
    assert safe_round(value, digits) == expected


def test_safe_round_default_digits():
    assert safe_round(0.123456789) == 0.1235


@pytest.mark.parametrize("value,expected", [
    (None, ""),
    ([], ""),
    ([1, 2, 3], 1),
    (["a"], "a"),
    ("standalone", "standalone"),
    (0, ""),
])
def test_safe_first_default(value, expected):
    assert safe_first(value) == expected


def test_safe_first_custom_default():
    assert safe_first(None, default="x") == "x"
    assert safe_first([], default="x") == "x"


@pytest.mark.parametrize("value,expected", [
    (None, []),
    ([], []),
    (["a", "b"], ["a", "b"]),
    ([1, 2], ["1", "2"]),
    ("scalar", ["scalar"]),
    ([None, "a", "", "b"], ["a", "b"]),
])
def test_safe_list(value, expected):
    assert safe_list(value) == expected


@pytest.mark.parametrize("value", [None, "", "   ", "not a date", float("nan"), True, False, []])
def test_parse_updated_at_unparseable(value):
    assert parse_updated_at(value) is None


@pytest.mark.parametrize("value", [
    ["2026-04-15T12:00:00Z"],
    ["2026-04-15 12:00:00"],
    ["2026-04-15"],
])
def test_parse_updated_at_unwraps_single_element_list(value):
    """Some retailers ship updated_at as a list at the top level (e.g.
    ['2026-05-01 09:39:30']) — unwrap and parse the first element."""
    dt = parse_updated_at(value)
    assert dt is not None
    assert dt.year == 2026 and dt.month == 4 and dt.day == 15


def test_parse_updated_at_space_separator_no_timezone():
    """Production format from the real catalog: 'YYYY-MM-DD HH:MM:SS'."""
    dt = parse_updated_at("2026-05-01 09:39:30")
    assert dt is not None
    assert dt.year == 2026 and dt.month == 5 and dt.day == 1
    assert dt.hour == 9 and dt.minute == 39 and dt.second == 30


def test_iter_catalog_records_handles_real_world_shape(tmp_path):
    """Replicates the live gap_historical_index.jsonl layout: top-level
    `updated_at` is a list, while `product_dump.updated_at` is the bare
    string.  Either path should let the record survive the filter."""
    path = tmp_path / "catalog.jsonl"
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    fresh_str = (now - timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S")
    line = json.dumps({
        "product_id": "p1",
        "updated_at": [fresh_str],
        "product_dump": {"product_id": "p1", "updated_at": fresh_str},
    })
    path.write_text(line + "\n", encoding="utf-8")
    kept = [doc for _, doc in iter_catalog_records(str(path), now=now)]
    assert [d["product_id"] for d in kept] == ["p1"]


def test_iter_catalog_records_drops_stale_in_real_world_shape(tmp_path):
    """Real-world shape but with a stale (>90 day old) timestamp."""
    path = tmp_path / "catalog.jsonl"
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    stale_str = (now - timedelta(days=200)).strftime("%Y-%m-%d %H:%M:%S")
    line = json.dumps({
        "product_id": "p1",
        "updated_at": [stale_str],
        "product_dump": {"product_id": "p1", "updated_at": stale_str},
    })
    path.write_text(line + "\n", encoding="utf-8")
    kept = [doc for _, doc in iter_catalog_records(str(path), now=now)]
    assert kept == []


@pytest.mark.parametrize("value", [
    "2026-04-15T12:00:00Z",
    "2026-04-15T12:00:00+00:00",
    "2026-04-15",
])
def test_parse_updated_at_iso_strings(value):
    dt = parse_updated_at(value)
    assert dt is not None
    assert dt.year == 2026
    assert dt.month == 4
    assert dt.day == 15


def test_parse_updated_at_epoch_seconds():
    target = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    dt = parse_updated_at(int(target.timestamp()))
    assert dt == target


def test_parse_updated_at_epoch_milliseconds():
    target = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    dt = parse_updated_at(int(target.timestamp() * 1000))
    assert dt == target


def test_parse_updated_at_numeric_string():
    target = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    dt = parse_updated_at(str(int(target.timestamp())))
    assert dt is not None
    assert dt.year == 2026 and dt.month == 4 and dt.day == 15


def test_is_recent_update_within_window():
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    recent = (now - timedelta(days=30)).isoformat()
    assert is_recent_update(recent, max_age_days=90, now=now) is True


def test_is_recent_update_outside_window():
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    stale = (now - timedelta(days=120)).isoformat()
    assert is_recent_update(stale, max_age_days=90, now=now) is False


def test_is_recent_update_missing_returns_false():
    assert is_recent_update(None) is False
    assert is_recent_update("") is False


def test_is_recent_update_at_boundary_inclusive():
    """Exactly 90 days old is still considered recent."""
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    boundary = (now - timedelta(days=90)).isoformat()
    assert is_recent_update(boundary, max_age_days=90, now=now) is True


def test_iter_catalog_records_filters_stale(tmp_path):
    """Records older than max_age_days are dropped; recent ones are kept."""
    path = tmp_path / "catalog.jsonl"
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    fresh = (now - timedelta(days=30)).isoformat()
    stale = (now - timedelta(days=180)).isoformat()
    lines = [
        json.dumps({"product_id": "fresh1", "updated_at": fresh}),
        json.dumps({"product_id": "stale1", "updated_at": stale}),
        json.dumps({"product_id": "fresh2", "updated_at": fresh}),
        json.dumps({"product_id": "undated"}),
    ]
    path.write_text("\n".join(lines), encoding="utf-8")

    kept = [doc for _, doc in iter_catalog_records(str(path), now=now)]
    pids = [d["product_id"] for d in kept]
    assert pids == ["fresh1", "fresh2"]


def test_iter_catalog_records_filter_disabled(tmp_path):
    """Passing max_age_days=None bypasses the recency filter."""
    path = tmp_path / "catalog.jsonl"
    lines = [
        json.dumps({"product_id": "p1"}),
        json.dumps({"product_id": "p2", "updated_at": "1990-01-01T00:00:00Z"}),
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    kept = [doc for _, doc in iter_catalog_records(str(path), max_age_days=None)]
    assert [d["product_id"] for d in kept] == ["p1", "p2"]


def test_iter_catalog_records_picks_up_nested_updated_at(tmp_path):
    """When updated_at lives only inside product_dump it is still honoured."""
    path = tmp_path / "catalog.jsonl"
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    fresh = (now - timedelta(days=10)).isoformat()
    line = json.dumps({"product_id": "p1", "product_dump": {"updated_at": fresh}})
    path.write_text(line + "\n", encoding="utf-8")
    kept = [doc for _, doc in iter_catalog_records(str(path), now=now)]
    assert len(kept) == 1


def test_iter_catalog_records_skips_malformed(tmp_path, capsys):
    """Malformed lines do not abort iteration; they are counted and skipped."""
    path = tmp_path / "catalog.jsonl"
    now = datetime(2026, 5, 7, tzinfo=timezone.utc)
    fresh = (now - timedelta(days=10)).isoformat()
    path.write_text(
        "\n".join([
            "{not valid json",
            json.dumps({"product_id": "p1", "updated_at": fresh}),
        ]) + "\n",
        encoding="utf-8",
    )
    kept = [doc for _, doc in iter_catalog_records(str(path), now=now)]
    assert [d["product_id"] for d in kept] == ["p1"]


@pytest.fixture
def evaluate_keyword_fn():
    pytest.importorskip("pandas")
    pytest.importorskip("openpyxl")
    from evaluate_iteration import evaluate_keyword
    return evaluate_keyword


def _make_label_store(keyword, tps, fps):
    store = {keyword: {}}
    for pid in tps:
        store[keyword][pid] = {"label": "TP", "iteration_first_seen": 1, "source": "manual_qa"}
    for pid in fps:
        store[keyword][pid] = {"label": "FP", "iteration_first_seen": 1, "source": "manual_qa"}
    return store


def test_evaluate_keyword_perfect_precision_and_recall(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1", "p2"}, {"p3"})
    catalog = {"p1": True, "p2": True, "p3": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2", "p3"},
        current_pids_to_include={"p1", "p2"},
        current_pids_to_remove={"p3"},
        current_re={"p1", "p2", "p3"},
        new_product_ids={"p1", "p2"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["labeled_precision"] == 1.0
    assert result["standard_recall"] == 1.0
    assert result["labeled_f1"] == 1.0


def test_evaluate_keyword_zero_recall_when_no_tps_returned(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1", "p2"}, set())
    catalog = {"p1": True, "p2": True, "p4": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2"},
        current_pids_to_include={"p1", "p2"},
        current_pids_to_remove=set(),
        current_re={"p1", "p2"},
        new_product_ids={"p4"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["standard_recall"] == 0.0


def test_evaluate_keyword_precision_with_mixed_results(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1", "p2"}, {"p3"})
    catalog = {"p1": True, "p2": True, "p3": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2", "p3"},
        current_pids_to_include={"p1", "p2"},
        current_pids_to_remove={"p3"},
        current_re={"p1", "p2", "p3"},
        new_product_ids={"p1", "p2", "p3"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["labeled_precision"] == safe_round(2 / 3)
    assert result["standard_recall"] == 1.0


def test_evaluate_keyword_f1_harmonic_mean(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1", "p2"}, {"p3"})
    catalog = {"p1": True, "p2": True, "p3": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2", "p3"},
        current_pids_to_include={"p1", "p2"},
        current_pids_to_remove={"p3"},
        current_re={"p1", "p2", "p3"},
        new_product_ids={"p1", "p3"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    precision = 1 / 2
    recall = 1 / 2
    expected_f1 = 2 * precision * recall / (precision + recall)
    assert result["labeled_f1"] == safe_round(expected_f1)


def test_evaluate_keyword_empty_results_with_available_tps_scores_zero(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1"}, set())
    catalog = {"p1": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1"},
        current_pids_to_include={"p1"},
        current_pids_to_remove=set(),
        current_re={"p1"},
        new_product_ids=set(),
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["labeled_precision"] == 0.0
    assert result["standard_recall"] == 0.0
    assert result["labeled_f1"] == 0.0


def test_evaluate_keyword_no_labels_returns_none_metrics(evaluate_keyword_fn):
    label_store = {"shoes": {}}
    catalog = {"p1": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids=set(),
        current_pids_to_include=set(),
        current_pids_to_remove=set(),
        current_re=set(),
        new_product_ids={"p1"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["labeled_precision"] is None
    assert result["standard_recall"] is None
    assert result["labeled_f1"] is None


def test_evaluate_keyword_fp_elimination_rate(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1"}, {"p2", "p3"})
    catalog = {"p1": True, "p2": True, "p3": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2", "p3"},
        current_pids_to_include={"p1"},
        current_pids_to_remove={"p2", "p3"},
        current_re={"p1", "p2", "p3"},
        new_product_ids={"p1"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert result["fp_elimination_rate"] == 1.0


def test_evaluate_keyword_tp_dropped_in_stock_tracked(evaluate_keyword_fn):
    label_store = _make_label_store("shoes", {"p1", "p2"}, set())
    catalog = {"p1": True, "p2": True}
    result = evaluate_keyword_fn(
        keyword="shoes",
        current_prod_ids={"p1", "p2"},
        current_pids_to_include={"p1", "p2"},
        current_pids_to_remove=set(),
        current_re={"p1", "p2"},
        new_product_ids={"p1"},
        label_store=label_store,
        iteration_num=2,
        catalog=catalog,
    )
    assert "p2" in result["tp_dropped_in_stock"]
