"""Shared base for the ORCHESTRATION-stage pass registry.

`process_document.py:main` was a single ~618-line function wiring the whole conversion (parse →
split-bib → STEM branch → PASS 1 extract → PASS 2 link → AUDIT → node-gen → sanitize/write). That is
exactly where "add a pipeline pass" meant surgery on a monolith. This module gives orchestration the
same open/closed shape as the LINKING-stage `LinkRule` registry (`link_base.py`): an ORDERED registry
of small `DocPass` units that thread a shared mutable `DocContext`. Absorbing a new conversion step
becomes "register a new pass," not "edit a 600-line function" — and the vibe loop can `op:add` a
`DocPass` class + `op:register` it into `DOC_PASSES`.

Unlike `LinkRule` (soup + a linking context, with a per-rule log), a `DocPass` threads the whole
pipeline `DocContext` and may be GUARDED (e.g. STEM-only / standard-only) — the pass decides whether
to act on `ctx`. ORDER matters (extract precedes link precedes audit; the id-generation sequence must
match the monolith for byte-identical output). The registry list IS that order. See
`process_document.py` for the `DocContext` + `DOC_PASSES`.
"""
from abc import ABC, abstractmethod


class DocPass(ABC):
    """One step of the conversion pipeline — small, ordered, guarded, independently unit-testable.
    Given the shared `DocContext`, `apply` performs its single step (mutating the soup and/or the
    context); a guarded pass returns early when its branch (STEM vs standard) doesn't apply. A new
    conversion step is absorbed by adding a pass, never by editing an existing one."""

    name = ''
    description = ''

    @abstractmethod
    def apply(self, ctx):
        ...


def run_passes(passes, ctx):
    """Apply each pass in order against the shared `ctx` (mirrors the LinkRule/TRANSFORM_PIPELINE
    loop). Returns the context so callers can read the accumulated result."""
    for p in passes:
        p.apply(ctx)
    return ctx
