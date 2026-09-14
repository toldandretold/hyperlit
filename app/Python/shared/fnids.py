"""The ONE generator for footnote element ids — collision-proof by construction.

Five sites used to mint these independently as `Fn{ms}_{4 random chars}` (one with 8), which is
unique only PROBABILISTICALLY: a book with hundreds of notes mints dozens of ids inside the same
millisecond, so two notes occasionally get the same id. When they do, the two defs share one
identity and one of them silently loses its in-text link — invisible unless you happen to diff two
runs of the same document (ad752a46: 337 notes, 2 orphans one run and 1 the next, with the fixture
golden flapping as the proof).

The id shape is contractual and must not change: `[prefix]Fn<digits>_<alnum>` — the regression
suite's id normaliser (GENERATED_ID_RE), the reader's footnote lookup and the stored node HTML all
match on it. So the millisecond stays, and the SUFFIX carries a per-process monotonic counter
(base36) instead of 4 random characters: same shape, same length class, zero collisions within a
conversion. A conversion is one process, and ids only ever need to be unique within the document.
"""
import itertools
import string
import time

_B36 = string.digits + string.ascii_lowercase
_SEQ = itertools.count(1)


def _b36(n, width=4):
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return (out or '0').rjust(width, '0')


def footnote_id(prefix=''):
    """A fresh footnote element id: `<prefix>Fn<epoch-ms>_<base36 counter>`.

    `prefix` carries the section/sequence namespace the call site already used
    ('s3_', 'seq3_') — unchanged, because the suite's regex and the reader both read it.
    """
    return f'{prefix}Fn{int(time.time() * 1000)}_{_b36(next(_SEQ))}'
