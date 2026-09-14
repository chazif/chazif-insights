#!/usr/bin/env python3
"""M0-A7: every environment variable the Ads app reads is documented in .env.example.

Scans backend/, engine/ and scripts/ (AST: os.getenv("X"), os.environ.get("X"),
os.environ["X"]), the Google Ads credential table the client reads indirectly
(engine.adsapi.client.CRED_ENV), the build-time VITE_* keys used by the React console, and
PORT (Dockerfile). It fails for any name without a `NAME=` line (commented or not). It also
fails on a NEW computed-name environment read, so one can't slip past the scan. Set
ENV_EXAMPLE_PATH to check another copy of the file.
"""
import ast
import os
import re
from pathlib import Path

from engine.adsapi.client import CRED_ENV

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = Path(os.environ.get("ENV_EXAMPLE_PATH") or ROOT / ".env.example")
SCAN_DIRS = ("backend", "engine", "scripts")
NON_PYTHON = {"PORT": "Dockerfile CMD"}
# Computed-name reads whose names are covered elsewhere (CRED_ENV).
ALLOWED_DYNAMIC = {"engine/adsapi/client.py"}


def _is_os_environ(n):
    return (isinstance(n, ast.Attribute) and n.attr == "environ"
            and isinstance(n.value, ast.Name) and n.value.id == "os")


def _python_reads():
    found, dynamic = {}, []
    for d in SCAN_DIRS:
        for path in sorted((ROOT / d).rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            for n in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                node = None
                if isinstance(n, ast.Call) and n.args:
                    fn = n.func
                    if isinstance(fn, ast.Attribute) and (
                            (fn.attr == "getenv" and isinstance(fn.value, ast.Name) and fn.value.id == "os")
                            or (fn.attr == "get" and _is_os_environ(fn.value))):
                        node = n.args[0]
                elif isinstance(n, ast.Subscript) and _is_os_environ(n.value):
                    node = n.slice
                if node is None:
                    continue
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    found.setdefault(node.value, rel)
                else:
                    dynamic.append(f"{rel}:{n.lineno}")
    return found, dynamic


def _vite_keys():
    keys = {}
    for path in sorted((ROOT / "frontend-next" / "src").rglob("*.ts*")):
        for k in re.findall(r"\bVITE_[A-Z0-9_]+\b", path.read_text(encoding="utf-8")):
            keys.setdefault(k, path.relative_to(ROOT).as_posix())
    return keys


def _documented():
    return set(re.findall(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=", ENV_EXAMPLE.read_text(encoding="utf-8"), re.M))


def test_scan_finds_the_apps_env_reads():
    found, _ = _python_reads()
    assert len(found) >= 10, sorted(found)
    assert {"DATABASE_URL", "ANTHROPIC_API_KEY", "ADSAPI_CRON_SECRET"} <= set(found)


def test_no_unreviewed_computed_name_env_reads():
    _, dynamic = _python_reads()
    unexpected = [d for d in dynamic if d.split(":")[0] not in ALLOWED_DYNAMIC]
    assert unexpected == [], ("new computed-name env read(s): document the names in .env.example "
                              f"and add the file to ALLOWED_DYNAMIC: {unexpected}")


def test_every_env_var_is_documented():
    found, _ = _python_reads()
    wanted = {**found,
              **{v: "engine/adsapi/client.py CRED_ENV" for v in CRED_ENV.values()},
              **_vite_keys(), **NON_PYTHON}
    missing = {k: v for k, v in sorted(wanted.items()) if k not in _documented()}
    assert missing == {}, f"add these to {ENV_EXAMPLE.name}: {missing}"


def test_env_example_holds_no_secret_values():
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    for line in text.splitlines():
        m = re.match(r"^\s*([A-Z][A-Z0-9_]*(KEY|SECRET|TOKEN))=(\S+)", line)
        assert m is None, f"uncommented secret value in .env.example: {line!r}"
