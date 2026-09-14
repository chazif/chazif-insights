#!/usr/bin/env python3
"""M0-A4: generated client bundles never live in git.

The 20 MB Mavis demo fixture (data/clients/mavis/2026-03/bundle.json) was committed
despite .gitignore, and nothing reads data/clients at request time any more (M0-A3).
This guards both halves: no bundle.json under data/clients is tracked, and .gitignore
still covers them. Skips when git isn't available (e.g. an exported tarball).
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None or not (ROOT / ".git").exists(),
    reason="needs a git checkout")


def _git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def test_no_client_bundle_is_tracked():
    tracked = [p for p in _git("ls-files", "data/clients").stdout.splitlines() if p.endswith("bundle.json")]
    assert tracked == [], f"generated bundles must not be committed: {tracked}"


def test_gitignore_covers_client_bundles():
    r = _git("check-ignore", "--no-index", "-q", "data/clients/example/2026-01/bundle.json")
    assert r.returncode == 0, ".gitignore no longer ignores data/clients/**/bundle.json"


def test_fixture_generator_is_retired():
    assert not (ROOT / "tools" / "split_dashboard.py").exists()
