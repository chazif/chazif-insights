#!/usr/bin/env python3
"""Stable identity for a recommendation across bundle rebuilds.

A recommendation is recomputed every build, so its lifecycle row must attach to
a content-derived key that survives rebuilds as long as the underlying *issue* is
the same. The analyzer declares a short, deterministic `key` scoping the issue
(identity lives where the semantics are); we hash it with the client id. When an
analyzer hasn't declared one yet, fall back to module:title — already effectively
unique per build, since analyzers emit one finding per (module, title). See
docs/DECISION_SYSTEM_DESIGN.md §2.
"""
import hashlib

_SEP = "\x1f"


def action_key(client_id: str, finding: dict) -> str:
    """16-hex-char stable key for a finding/recommendation dict.

    `finding` is either an analyzer finding (has `module`/`title`/optional `key`)
    or a bundle recommendation that already carries `action_key` — in which case
    the caller should read that field directly rather than re-deriving.
    """
    scope = finding.get("key") or f'{finding.get("module", "?")}:{finding.get("title", "")}'
    return hashlib.sha1(f"{client_id}{_SEP}{scope}".encode("utf-8")).hexdigest()[:16]
