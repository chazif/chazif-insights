#!/usr/bin/env python3
"""M0-A5: search-term relevance routes Anthropic-first; DeepSeek only by explicit opt-in.

Client search terms can contain PII. Covers provider selection, the path actually taken
(with its log line), that a failing Anthropic call falls back to the heuristic and NEVER
to DeepSeek, and that logs never carry term text or keys. No network; the LLM calls are
replaced by stubs.
"""
import logging

import pytest

from engine.llm import relevance as rel

LOGGER = "engine.llm.relevance"
TERMS = ["private customer phone 555 0100", "tire shop near me"]
CONTEXT = {"product_categories": ["Tires"], "brand_terms": [], "competitors_conquest": []}
ANTHROPIC_KEY = "sk-ant-TEST-never-log-me"
DEEPSEEK_KEY = "sk-ds-TEST-never-log-me"


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)


def _keys(monkeypatch, anthropic, deepseek):
    if anthropic:
        monkeypatch.setenv("ANTHROPIC_API_KEY", ANTHROPIC_KEY)
    if deepseek:
        monkeypatch.setenv("DEEPSEEK_API_KEY", DEEPSEEK_KEY)


def _stub(source):
    return lambda terms, context: {t: {"relevant": True, "category": "product", "reason": "stub", "source": source}
                                   for t in terms}


def _forbidden(name):
    def boom(terms, context):
        raise AssertionError(f"{name} must not be called")
    return boom


@pytest.mark.parametrize("anthropic,deepseek,expected", [
    (True, True, "anthropic"),
    (True, False, "anthropic"),
    (False, True, "deepseek"),
    (False, False, None),
])
def test_provider_order_is_anthropic_then_deepseek(monkeypatch, anthropic, deepseek, expected):
    _keys(monkeypatch, anthropic, deepseek)
    assert rel._provider() == expected


def test_both_keys_take_the_anthropic_path(monkeypatch, caplog):
    _keys(monkeypatch, True, True)
    monkeypatch.setattr(rel, "_classify_anthropic", _stub("llm"))
    monkeypatch.setattr(rel, "_classify_deepseek", _forbidden("DeepSeek"))
    caplog.set_level(logging.INFO, logger=LOGGER)
    out = rel.classify_terms(TERMS, CONTEXT)
    assert {v["source"] for v in out.values()} == {"llm"}
    assert "2 term(s) via anthropic" in caplog.text


def test_no_keys_take_the_heuristic_path(monkeypatch, caplog):
    monkeypatch.setattr(rel, "_classify_anthropic", _forbidden("Anthropic"))
    monkeypatch.setattr(rel, "_classify_deepseek", _forbidden("DeepSeek"))
    caplog.set_level(logging.INFO, logger=LOGGER)
    out = rel.classify_terms(TERMS, CONTEXT)
    assert {v["source"] for v in out.values()} == {"heuristic"}
    assert out["tire shop near me"]["relevant"] is True          # the heuristic really ran
    assert "via heuristic (no LLM key set)" in caplog.text


def test_deepseek_only_when_it_is_the_only_key(monkeypatch, caplog):
    _keys(monkeypatch, False, True)
    monkeypatch.setattr(rel, "_classify_anthropic", _forbidden("Anthropic"))
    monkeypatch.setattr(rel, "_classify_deepseek", _stub("deepseek"))
    caplog.set_level(logging.INFO, logger=LOGGER)
    out = rel.classify_terms(TERMS, CONTEXT)
    assert {v["source"] for v in out.values()} == {"deepseek"}
    assert "via deepseek" in caplog.text


def test_anthropic_failure_falls_back_to_heuristic_never_deepseek(monkeypatch, caplog):
    _keys(monkeypatch, True, True)

    def failing(terms, context):
        raise RuntimeError("upstream 529 overloaded")
    monkeypatch.setattr(rel, "_classify_anthropic", failing)
    monkeypatch.setattr(rel, "_classify_deepseek", _forbidden("DeepSeek"))
    caplog.set_level(logging.INFO, logger=LOGGER)
    out = rel.classify_terms(TERMS, CONTEXT)
    assert {v["source"] for v in out.values()} == {"heuristic"}
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "anthropic call failed (RuntimeError)" in warnings[0].getMessage()


def test_logs_never_contain_terms_context_or_keys(monkeypatch, caplog):
    _keys(monkeypatch, True, True)

    def failing(terms, context):
        raise RuntimeError(f"echoing input {terms}")          # even if an error message would
    monkeypatch.setattr(rel, "_classify_anthropic", failing)
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    rel.classify_terms(TERMS, CONTEXT)
    for secret in (*TERMS, "Tires", ANTHROPIC_KEY, DEEPSEEK_KEY, "echoing input"):
        assert secret not in caplog.text, secret
