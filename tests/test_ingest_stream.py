#!/usr/bin/env python3
"""Streaming header/row readers (engine/ingest/parser.read_csv_header + iter_csv_rows).

These back the MCC-preview path so a large export (70 MB+) is counted in constant
memory instead of being materialized into a list of dicts — which OOM-killed the
Railway worker and surfaced to the user as an HTTP 502 on "Preview accounts".

The contract: the streaming readers must produce byte-identical columns / report_type
/ window / rows to parse_csv, and peak memory must not scale with row count.
"""
import tracemalloc

import pytest

from engine.ingest.parser import parse_csv, read_csv_header, iter_csv_rows


def write_google_csv(path, header_cols, rows):
    """Emit a Google Ads Report-Editor style CSV: 3-line preamble (title, date range,
    column header), data rows, trailing Total row."""
    lines = ['"Search terms report"',
             '"Aug 1, 2026-Aug 31, 2026"',
             ",".join(header_cols)]
    lines += [",".join(str(c) for c in r) for r in rows]
    lines.append("Total," + ",".join("0" for _ in header_cols[1:]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


COLS = ["Search term", "Campaign", "Clicks", "Impr.", "Cost"]


def make_rows(n):
    return [[f"term {i}", "Brand - NYC", i % 7, i % 50, f"{i % 90}.12"] for i in range(n)]


@pytest.mark.parametrize("n", [0, 1, 5, 5000])
def test_streaming_matches_parse_csv(tmp_path, n):
    p = tmp_path / "terms.csv"
    write_google_csv(p, COLS, make_rows(n))

    full = parse_csv(p)
    head = read_csv_header(p)
    streamed = list(iter_csv_rows(p, head["columns"]))

    assert head["columns"] == full["columns"]
    assert head["report_type"] == full["report_type"]
    assert (head["window_start"], head["window_end"]) == (full["window_start"], full["window_end"])
    assert streamed == full["rows"]
    assert len(streamed) == n            # Total + preamble excluded


def test_read_header_returns_none_when_too_short(tmp_path):
    p = tmp_path / "stub.csv"
    p.write_text('"title"\n"range"\n', encoding="utf-8")   # no column line
    assert read_csv_header(p) is None


def test_streaming_is_constant_memory(tmp_path):
    """Peak allocation for the 50k-row file must stay far below a full materialization —
    the whole point of the fix. parse_csv on this file peaks in the tens of MB; the
    streamed count should stay under a couple of MB and NOT grow with row count."""
    p = tmp_path / "big.csv"
    write_google_csv(p, COLS, make_rows(50_000))

    head = read_csv_header(p)
    tracemalloc.start()
    n = sum(1 for _ in iter_csv_rows(p, head["columns"]))
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    assert n == 50_000
    assert peak < 2_000_000, f"streamed peak {peak} bytes — should be constant, not O(rows)"
