"""Footnote element ids must be unique BY CONSTRUCTION, not by luck.

Five sites minted `Fn{ms}_{4 random chars}` independently. A book with hundreds of notes mints
dozens of ids inside one millisecond, so two notes occasionally drew the same suffix — and when they
did, the two definitions shared an identity and one silently lost its in-text link. The only
visible symptom was two runs of the SAME document disagreeing (ad752a46: 337 notes, 2 orphaned defs
one run and 1 the next, its fixture golden flapping with it).

The id SHAPE is contractual: the regression suite's id normaliser, the reader's footnote lookup and
the stored node HTML all match `[prefix]Fn<digits>_<alnum>`.
"""

import re

from shared.fnids import footnote_id

GENERATED_ID_RE = re.compile(r'(?:s(?:eq)?\d+_)?Fn\d+(?:_[A-Za-z0-9]+)?')


def test_ids_are_unique_within_a_millisecond():
    ids = [footnote_id() for _ in range(5000)]
    assert len(set(ids)) == len(ids)
    # …and this test is only meaningful if they really did share a millisecond
    assert len({i.split('_')[0] for i in ids}) < len(ids)


def test_prefix_namespaces_are_preserved():
    assert footnote_id('seq3_').startswith('seq3_Fn')
    assert footnote_id('s3_').startswith('s3_Fn')


def test_id_shape_matches_the_suite_normaliser():
    for i in (footnote_id(), footnote_id('s1_'), footnote_id('seq12_')):
        assert GENERATED_ID_RE.fullmatch(i), i


def test_prefixed_and_plain_ids_never_collide():
    ids = [footnote_id(p) for _ in range(500) for p in ('', 's1_', 'seq1_')]
    assert len(set(ids)) == len(ids)
