"""Shared base for the LINKING-stage rule registries.

The conversion pipeline's DETECTION stage is already a clean registry (epub_normalizer's
`TRANSFORM_PIPELINE` of `EpubTransform` detectors). The LINKING stage (footnote + citation linking)
was monolithic — hard for any model (or human) to modify surgically, and impossible to extend
additively. This module gives linking the same open/closed shape: an ORDERED registry of small
`LinkRule` units that thread a shared mutable Context. Absorbing a new file variant becomes
"register a new rule," not "edit a 300-line method" — and the vibe loop can `op:add` a `LinkRule`
class + `op:register` it into a `*_LINK_RULES` list.

Unlike `EpubTransform` (stateless, soup-only), a `LinkRule` reads/writes a Context (the id_mapping,
the accumulators) and ORDER matters — the registry list IS the order. See `footnote_link_rules.py`
and `citation_link_rules.py`.
"""
from abc import ABC, abstractmethod


class LinkRule(ABC):
    """One step of a linking pipeline — small, ordered, independently unit-testable. Given the
    pipeline's shared Context, `apply` performs its single transformation (mutating the soup and/or
    the context). A new file variant is absorbed by adding a rule, never by editing an existing one."""

    name = ''
    description = ''

    @abstractmethod
    def apply(self, ctx, log=None):
        ...


def run_link_rules(rules, ctx, log=None):
    """Apply each rule in order against the shared `ctx` (mirrors the TRANSFORM_PIPELINE loop).
    Returns the context so callers can read the accumulated result."""
    _log = log if callable(log) else (lambda *a, **k: None)
    for rule in rules:
        rule.apply(ctx, _log)
    return ctx
