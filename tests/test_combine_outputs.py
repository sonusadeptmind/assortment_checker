"""Functional pytest tests for combine_outputs.py.

Run with:  python -m pytest tests/test_combine_outputs.py -v
"""

import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from combine_outputs import (
    _deep_merge_dicts,
    _merge_csv,
    _merge_iteration_history_entries,
    _merge_json,
    _merge_labels_store,
    _merge_lists,
    _merge_qa_metadata,
    combine_output_folders,
)


def make_label(keyword, product_id, label, **extra):
    return {"keyword": keyword, "product_id": product_id, "label": label,
            "iteration": "iter_1", "user": "system", **extra}


@pytest.fixture
def tmp(tmp_path):
    yield tmp_path


@pytest.fixture
def folders(tmp_path):
    folder_a = tmp_path / "folder_a"
    folder_b = tmp_path / "folder_b"
    out_dir = tmp_path / "combined"
    folder_a.mkdir()
    folder_b.mkdir()
    yield folder_a, folder_b, out_dir


def _base_meta(kw_list, iteration_labels, ts):
    return {
        "disapprovals": [],
        "approvals": [],
        "qa_done_keywords": kw_list,
        "iteration_labels": iteration_labels,
        "label_changes": [],
        "current_iteration": "HASH",
        "exported_at": ts,
    }


def _entry(kw_eval=40, lp=0.8, sr=0.9, sp=0.75, sar=0.85,
           approved=100, disapproved=200, ts="2026-01-01T10:00:00"):
    return {
        "iteration": "HASH",
        "timestamp": ts,
        "labeled_precision": lp,
        "standard_recall": sr,
        "labeled_f1": round(2 * lp * sr / (lp + sr), 4) if lp and sr else None,
        "stock_adj_precision": sp,
        "stock_adj_recall": sar,
        "stock_adj_f1": round(2 * sp * sar / (sp + sar), 4) if sp and sar else None,
        "f1_score": None,
        "label_coverage": 1.0,
        "tp_retention_rate": sr,
        "fp_elimination_rate": 0.6,
        "keywords_evaluated": kw_eval,
        "total_pids_to_check": 1000,
        "approved_count": approved,
        "disapproved_count": disapproved,
    }


@pytest.mark.parametrize("a,b,expected_count,expected_conflicts", [
    pytest.param(
        [make_label("boots", "pid1", "TP"), make_label("boots", "pid2", "FP")],
        [make_label("sneakers", "pid3", "TP")],
        3, 0, id="no-overlap-combines-all",
    ),
    pytest.param(
        [make_label("boots", "pid1", "TP")],
        [make_label("boots", "pid1", "TP")],
        1, 0, id="agreed-label-kept-once",
    ),
    pytest.param(
        [make_label("boots", "pid1", "FP")],
        [make_label("boots", "pid1", "TP")],
        1, 1, id="conflict-nulls-label",
    ),
    pytest.param([make_label("boots", "pid1", "TP")], [], 1, 0, id="only-in-a-preserved"),
    pytest.param([], [make_label("boots", "pid1", "TP")], 1, 0, id="only-in-b-preserved"),
    pytest.param([], [], 0, 0, id="empty-both"),
])
def test_merge_labels_store_counts(a, b, expected_count, expected_conflicts):
    merged, conflicts = _merge_labels_store(a, b)
    assert len(merged) == expected_count
    assert len(conflicts) == expected_conflicts


def test_merge_labels_store_conflict_details():
    """When labels disagree the merged entry exposes both originals."""
    a = [make_label("boots", "pid1", "FP")]
    b = [make_label("boots", "pid1", "TP")]
    merged, conflicts = _merge_labels_store(a, b)
    assert merged[0]["label"] is None
    assert merged[0]["conflict"] is True
    assert merged[0]["conflict_details"]["a_label"] == "FP"
    assert merged[0]["conflict_details"]["b_label"] == "TP"
    assert conflicts[0]["keyword"] == "boots"
    assert conflicts[0]["product_id"] == "pid1"


def test_merge_labels_store_multiple_conflicts():
    a = [make_label("boots", "pid1", "FP"), make_label("boots", "pid2", "FP"),
         make_label("sneakers", "pid3", "TP")]
    b = [make_label("boots", "pid1", "TP"), make_label("boots", "pid2", "TP"),
         make_label("sandals", "pid4", "FP")]
    merged, conflicts = _merge_labels_store(a, b)
    assert len(conflicts) == 2
    assert sum(1 for e in merged if e.get("conflict")) == 2
    non_conflict_kw = {e["keyword"] for e in merged if not e.get("conflict")}
    assert "sneakers" in non_conflict_kw
    assert "sandals" in non_conflict_kw


def test_merge_labels_store_last_entry_per_key_used():
    """When the same key appears multiple times in one list, the last entry wins."""
    a = [make_label("boots", "pid1", "FP"), make_label("boots", "pid1", "TP")]
    b = [make_label("boots", "pid1", "TP")]
    merged, conflicts = _merge_labels_store(a, b)
    assert len(conflicts) == 0
    assert merged[0]["label"] == "TP"


def test_merge_qa_metadata_qa_done_keywords_union():
    a = _base_meta(["boots", "sneakers"], {}, "2026-01-01T10:00:00Z")
    b = _base_meta(["sandals", "sneakers"], {}, "2026-01-01T11:00:00Z")
    merged = _merge_qa_metadata(a, b)
    assert sorted(merged["qa_done_keywords"]) == ["boots", "sandals", "sneakers"]


def test_merge_qa_metadata_disapprovals_deduped_union():
    d1 = {"keyword": "boots", "product_id": "p1", "reason": "wrong_gender"}
    d2 = {"keyword": "sneakers", "product_id": "p2", "reason": "wrong_brand"}
    a = _base_meta([], {}, "T"); a["disapprovals"] = [d1]
    b = _base_meta([], {}, "T"); b["disapprovals"] = [d1, d2]
    merged = _merge_qa_metadata(a, b)
    assert len(merged["disapprovals"]) == 2


def test_merge_qa_metadata_iteration_labels_a_wins_on_conflict():
    a = _base_meta([], {"boots": {"p1": "TP"}}, "T")
    b = _base_meta([], {"boots": {"p1": "FP"}, "sandals": {"p2": "TP"}}, "T")
    merged = _merge_qa_metadata(a, b)
    assert merged["iteration_labels"]["boots"]["p1"] == "TP"
    assert "sandals" in merged["iteration_labels"]


@pytest.mark.parametrize("ts_a,ts_b,expected", [
    ("2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z", "2026-01-01T12:00:00Z"),
    ("2026-01-01T15:00:00Z", "2026-01-01T12:00:00Z", "2026-01-01T15:00:00Z"),
])
def test_merge_qa_metadata_exported_at_takes_later(ts_a, ts_b, expected):
    a = _base_meta([], {}, ts_a)
    b = _base_meta([], {}, ts_b)
    assert _merge_qa_metadata(a, b)["exported_at"] == expected


def test_merge_qa_metadata_label_changes_union():
    c1 = {"keyword": "boots", "product_id": "p1", "from": "FP", "to": "TP"}
    c2 = {"keyword": "sneakers", "product_id": "p2", "from": "TP", "to": "FP"}
    a = _base_meta([], {}, "T"); a["label_changes"] = []
    b = _base_meta([], {}, "T"); b["label_changes"] = [c1, c2]
    merged = _merge_qa_metadata(a, b)
    assert len(merged["label_changes"]) == 2


def test_merge_qa_metadata_b_only_key_included():
    a = _base_meta([], {}, "T")
    b = _base_meta([], {}, "T")
    b["new_field"] = "from_b"
    assert _merge_qa_metadata(a, b)["new_field"] == "from_b"


def test_merge_iteration_history_entries_weighted_average_equal_weights():
    a = _entry(kw_eval=40, lp=0.6, sr=0.8)
    b = _entry(kw_eval=40, lp=0.8, sr=0.9)
    merged = _merge_iteration_history_entries(a, b)
    assert merged["labeled_precision"] == pytest.approx(0.7, abs=1e-3)
    assert merged["standard_recall"] == pytest.approx(0.85, abs=1e-3)


def test_merge_iteration_history_entries_weighted_average_unequal_weights():
    a = _entry(kw_eval=60, lp=0.9, sr=0.9)
    b = _entry(kw_eval=20, lp=0.5, sr=0.5)
    merged = _merge_iteration_history_entries(a, b)
    # weighted: (0.9*60 + 0.5*20) / 80 = 0.8
    assert merged["labeled_precision"] == pytest.approx(0.8, abs=1e-3)


def test_merge_iteration_history_entries_count_fields_summed():
    a = _entry(kw_eval=40, approved=56, disapproved=161)
    b = _entry(kw_eval=40, approved=787, disapproved=1464)
    merged = _merge_iteration_history_entries(a, b)
    assert merged["keywords_evaluated"] == 80
    assert merged["approved_count"] == 843
    assert merged["disapproved_count"] == 1625


def test_merge_iteration_history_entries_later_timestamp_kept():
    a = _entry(ts="2026-01-01T10:00:00")
    b = _entry(ts="2026-01-01T12:00:00")
    assert _merge_iteration_history_entries(a, b)["timestamp"] == "2026-01-01T12:00:00"


def test_merge_iteration_history_entries_null_metric_in_a_uses_b():
    a = _entry(); a["stock_adj_precision"] = None
    b = _entry(sp=0.77)
    assert _merge_iteration_history_entries(a, b)["stock_adj_precision"] == 0.77


def test_merge_iteration_history_entries_both_null_stays_null():
    a = _entry(); a["labeled_f1"] = None
    b = _entry(); b["labeled_f1"] = None
    assert _merge_iteration_history_entries(a, b)["labeled_f1"] is None


def test_merge_iteration_history_entries_zero_keywords_no_division_error():
    a = _entry(kw_eval=0); a["labeled_precision"] = None
    b = _entry(kw_eval=0); b["labeled_precision"] = None
    merged = _merge_iteration_history_entries(a, b)
    assert merged["labeled_precision"] is None


def test_merge_lists_dedups_by_iteration_hash():
    a = [_entry(kw_eval=40, lp=0.6, sr=0.8, ts="2026-01-01T10:00:00")]
    b = [_entry(kw_eval=40, lp=0.8, sr=0.9, ts="2026-01-01T12:00:00")]
    result = _merge_lists(a, b)
    assert len(result) == 1
    assert result[0]["keywords_evaluated"] == 80
    assert result[0]["labeled_precision"] == pytest.approx(0.7, abs=1e-3)


def test_merge_lists_different_iterations_both_kept():
    a = [_entry(kw_eval=40, lp=0.6, sr=0.8, ts="T1")]; a[0]["iteration"] = "HASH_1"
    b = [_entry(kw_eval=40, lp=0.8, sr=0.9, ts="T2")]; b[0]["iteration"] = "HASH_2"
    assert len(_merge_lists(a, b)) == 2


def test_merge_lists_generic_string_dedup():
    assert sorted(_merge_lists(["boots", "sneakers"], ["sneakers", "sandals"])) \
        == ["boots", "sandals", "sneakers"]


def test_merge_lists_generic_dict_dedup():
    item = {"keyword": "boots", "reason": "wrong_gender"}
    assert len(_merge_lists([item], [item, {"keyword": "sneakers", "reason": "wrong_brand"}])) == 2


def test_merge_lists_empty():
    assert _merge_lists([], []) == []


def test_merge_lists_one_empty():
    a = [_entry(kw_eval=40, lp=0.7, sr=0.8, ts="T1")]; a[0]["iteration"] = "HASH_1"
    assert len(_merge_lists(a, [])) == 1


@pytest.mark.parametrize("base,overlay,expected_subset", [
    ({"a": 1}, {"b": 2}, {"a": 1, "b": 2}),
    ({"a": 1}, {"a": 99}, {"a": 1}),  # a wins on scalar conflict
    ({"a": None}, {"a": 42}, {"a": 42}),  # b fills null in a
    ({"x": {"a": 1}}, {"x": {"b": 2}}, {"x": {"a": 1, "b": 2}}),  # nested merge
])
def test_deep_merge_dicts(base, overlay, expected_subset):
    merged = _deep_merge_dicts(base, overlay)
    for k, v in expected_subset.items():
        assert merged[k] == v


def test_deep_merge_dicts_nested_conflict_a_wins():
    merged = _deep_merge_dicts({"x": {"a": 1}}, {"x": {"a": 99, "b": 2}})
    assert merged["x"]["a"] == 1
    assert merged["x"]["b"] == 2


def test_merge_json_labels_store_conflict_nulled(tmp):
    a = [make_label("boots", "p1", "FP")]
    b = [make_label("boots", "p1", "TP")]
    pa = tmp / "a" / "labels_store.json"
    pa.parent.mkdir()
    pa.write_text(json.dumps(a))
    pb = tmp / "b" / "labels_store.json"
    pb.parent.mkdir()
    pb.write_text(json.dumps(b))
    out = tmp / "out_labels_store.json"
    _, conflicts = _merge_json(pa, pb, out)
    result = json.loads(out.read_text())
    assert len(conflicts) == 1
    assert result[0]["label"] is None


def test_merge_json_qa_metadata_exported_at_takes_later(tmp):
    a = {"exported_at": "2026-01-01T10:00:00Z", "qa_done_keywords": ["boots"],
         "disapprovals": [], "approvals": [], "iteration_labels": {},
         "label_changes": [], "current_iteration": "H"}
    b = {"exported_at": "2026-01-01T12:00:00Z", "qa_done_keywords": ["sneakers"],
         "disapprovals": [], "approvals": [], "iteration_labels": {},
         "label_changes": [], "current_iteration": "H"}
    pa = tmp / "a" / "qa_metadata.json"
    pa.parent.mkdir()
    pa.write_text(json.dumps(a))
    pb = tmp / "b" / "qa_metadata.json"
    pb.parent.mkdir()
    pb.write_text(json.dumps(b))
    out = tmp / "out_qa_metadata.json"
    _merge_json(pa, pb, out)
    result = json.loads(out.read_text())
    assert result["exported_at"] == "2026-01-01T12:00:00Z"
    assert "boots" in result["qa_done_keywords"]
    assert "sneakers" in result["qa_done_keywords"]


def _write_csv(folder: Path, name: str, rows: list, headers: list) -> Path:
    import csv
    p = folder / name
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(rows)
    return p


def test_merge_csv_no_overlap_all_rows_kept(tmp):
    pa = _write_csv(tmp, "a.csv", [{"keyword": "boots", "precision": 0.8}], ["keyword", "precision"])
    pb = _write_csv(tmp, "b.csv", [{"keyword": "sneakers", "precision": 0.7}], ["keyword", "precision"])
    out = tmp / "out.csv"
    _merge_csv(pa, pb, out)
    import pandas as pd
    df = pd.read_csv(out)
    assert len(df) == 2
    assert "boots" in df["keyword"].values
    assert "sneakers" in df["keyword"].values


def test_merge_csv_duplicate_keyword_kept_once(tmp):
    pa = _write_csv(tmp, "a.csv", [{"keyword": "boots", "precision": 0.8}], ["keyword", "precision"])
    pb = _write_csv(tmp, "b.csv", [{"keyword": "boots", "precision": 0.9}], ["keyword", "precision"])
    out = tmp / "out.csv"
    _merge_csv(pa, pb, out)
    import pandas as pd
    df = pd.read_csv(out)
    assert len(df) == 1
    assert df.iloc[0]["precision"] == pytest.approx(0.8)


def test_merge_csv_extra_columns_in_b_added(tmp):
    pa = _write_csv(tmp, "a.csv", [{"keyword": "boots", "precision": 0.8}], ["keyword", "precision"])
    pb = _write_csv(tmp, "b.csv", [{"keyword": "sneakers", "recall": 0.9}], ["keyword", "recall"])
    out = tmp / "out.csv"
    _merge_csv(pa, pb, out)
    import pandas as pd
    df = pd.read_csv(out)
    assert "precision" in df.columns
    assert "recall" in df.columns


def _write_json(folder: Path, name: str, data) -> None:
    (folder / name).write_text(json.dumps(data))


def test_combine_output_folders_b_only_file_copied(folders):
    folder_a, folder_b, out_dir = folders
    _write_json(folder_b, "extra.json", {"note": "b only"})
    combine_output_folders(folder_a, folder_b, out_dir)
    assert (out_dir / "extra.json").exists()


def test_combine_output_folders_a_only_file_copied(folders):
    folder_a, folder_b, out_dir = folders
    _write_json(folder_a, "only_a.json", {"note": "a only"})
    combine_output_folders(folder_a, folder_b, out_dir)
    assert (out_dir / "only_a.json").exists()


def test_combine_output_folders_labels_store_conflicts_produce_report(folders):
    folder_a, folder_b, out_dir = folders
    _write_json(folder_a, "labels_store.json", [make_label("boots", "p1", "FP")])
    _write_json(folder_b, "labels_store.json", [make_label("boots", "p1", "TP")])
    combine_output_folders(folder_a, folder_b, out_dir)
    report = (out_dir / "_conflicts.txt").read_text()
    assert "LABEL CONFLICTS" in report
    assert "boots" in report
    assert "p1" in report


def test_combine_output_folders_no_conflict_produces_clean_report(folders):
    folder_a, folder_b, out_dir = folders
    _write_json(folder_a, "labels_store.json", [make_label("boots", "p1", "TP")])
    _write_json(folder_b, "labels_store.json", [make_label("sneakers", "p2", "FP")])
    combine_output_folders(folder_a, folder_b, out_dir)
    report = (out_dir / "_conflicts.txt").read_text()
    assert "No conflicts" in report


def test_combine_output_folders_output_dir_created_if_missing(folders, tmp_path):
    folder_a, folder_b, _ = folders
    out = tmp_path / "new_dir" / "nested"
    combine_output_folders(folder_a, folder_b, out)
    assert out.exists()
