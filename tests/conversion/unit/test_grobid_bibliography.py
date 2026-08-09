"""GROBID bibliography integration — server-free unit coverage.

The GROBID path is OPT-IN (env GROBID_URL + a source PDF on disk); these tests pin the two things
that must hold WITHOUT a server: (1) the TEI parsing + DOM anchoring/keying logic is correct, and
(2) every failure mode falls back to None so the regex path runs — conversion must never gain a
hard dependency on the service. Live end-to-end coverage = the regression suite run with
GROBID_URL set against the PDF-bearing fixtures (see grobid_client.py docstring).
"""
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'app', 'Python')))

from bs4 import BeautifulSoup                                        # noqa: E402
from digestion.bibliographyExtraction.grobid_client import _parse_tei_references   # noqa: E402
from digestion.bibliographyExtraction import bibliography as B       # noqa: E402


TEI = '''<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
 <text><back><div><listBibl>
  <biblStruct>
   <analytic>
    <title level="a" type="main">Impact factors and prestige</title>
    <author><persName><forename>Q</forename><surname>Al-Awqati</surname></persName></author>
    <idno type="DOI">10.1038/sj.ki.5002094</idno>
   </analytic>
   <monogr><title level="j">Kidney International</title>
    <imprint><date type="published" when="2007-02"/></imprint></monogr>
   <note type="raw_reference">Al-Awqati, Q. (2007). Impact factors and prestige. Kidney International, 71(3), 183-185.</note>
  </biblStruct>
  <biblStruct>
   <analytic>
    <title level="a" type="main">History of the journal impact factor</title>
    <author><persName><forename>E</forename><surname>Archambault</surname></persName></author>
   </analytic>
   <monogr><imprint><date type="published" when="2009"/></imprint></monogr>
   <note type="raw_reference">Archambault, E. (2009). History of the journal impact factor. Scientometrics, 79(3), 635-649.</note>
  </biblStruct>
 </listBibl></div></back></text>
</TEI>'''


def test_tei_parse_extracts_structured_fields():
    refs = _parse_tei_references(TEI)
    assert len(refs) == 2
    assert refs[0]['first_author'] == 'Al-Awqati'
    assert refs[0]['year'] == '2007'
    assert refs[0]['doi'] == '10.1038/sj.ki.5002094'
    assert refs[0]['raw'].startswith('Al-Awqati, Q. (2007)')
    assert refs[1]['year'] == '2009'


def test_grobid_refs_anchor_into_glued_paragraph(monkeypatch):
    # The acid case: ONE DOM paragraph carrying two glued entries. Both must key + anchor
    # into that same paragraph, so both citations link (regex keyed only the first author).
    html = ('<html><body><h1>References</h1>'
            '<p>Al-Awqati, Q. (2007). Impact factors and prestige. Kidney International, 71(3), '
            '183-185. doi: 10.1038/sj.ki.5002094 Archambault, E. (2009). History of the journal '
            'impact factor. Scientometrics, 79(3), 635-649.</p></body></html>')
    soup = BeautifulSoup(html, 'html.parser')
    refs = _parse_tei_references(TEI)
    monkeypatch.setattr(B, 'extract_refs_from_pdf', None, raising=False)
    import digestion.bibliographyExtraction.grobid_client as gc
    monkeypatch.setattr(gc, 'grobid_alive', lambda url: True)
    monkeypatch.setattr(gc, 'extract_refs_from_pdf', lambda pdf, url: refs)

    result = B.extract_bibliography_via_grobid(soup, '/nonexistent.pdf', 'http://x')
    # thin-result guard needs >=3 anchored — with only 2 refs this falls back…
    assert result is None

    # …so extend with a third ref to cross the guard and assert the real behaviour.
    refs3 = refs + [{'raw': 'Bar-Ilan, J. (2008). Informetrics review. J. Informetrics, 2(1), 1-52.',
                     'first_author': 'Bar-Ilan', 'year': '2008', 'title': 'Informetrics review', 'doi': ''}]
    html3 = html.replace('</p>', ' Bar-Ilan, J. (2008). Informetrics review. J. Informetrics, 2(1), 1-52.</p>')
    soup3 = BeautifulSoup(html3, 'html.parser')
    monkeypatch.setattr(gc, 'extract_refs_from_pdf', lambda pdf, url: refs3)
    bibliography_map, references_data = B.extract_bibliography_via_grobid(soup3, '/nonexistent.pdf', 'http://x')

    assert bibliography_map['alawqati2007'] == 'alawqati2007'
    assert 'archambault2009' in bibliography_map
    assert 'barilan2008' in bibliography_map
    # all three anchors landed in the DOM (same glued <p> is fine — nav reaches the paragraph)
    anchors = soup3.find_all('a', class_='bib-entry')
    assert {a['id'] for a in anchors} >= {'alawqati2007', 'archambault2009', 'barilan2008'}
    assert len(references_data) == 3


def test_unlocatable_ref_is_skipped_not_dead_linked(monkeypatch):
    # A GROBID ref whose text is NOT in the DOM must not enter the map (no dead links).
    html = ('<html><body><p>Al-Awqati, Q. (2007). Impact factors and prestige. Kidney '
            'International. more text to anchor</p>'
            '<p>Archambault, E. (2009). History of the journal impact factor. Scientometrics.</p>'
            '<p>Bar-Ilan, J. (2008). Informetrics review. J. Informetrics, 2(1).</p></body></html>')
    soup = BeautifulSoup(html, 'html.parser')
    refs = [
        {'raw': 'Al-Awqati, Q. (2007). Impact factors and prestige. Kidney International.',
         'first_author': 'Al-Awqati', 'year': '2007', 'title': 'Impact factors', 'doi': ''},
        {'raw': 'Archambault, E. (2009). History of the journal impact factor. Scientometrics.',
         'first_author': 'Archambault', 'year': '2009', 'title': 'History', 'doi': ''},
        {'raw': 'Bar-Ilan, J. (2008). Informetrics review. J. Informetrics, 2(1).',
         'first_author': 'Bar-Ilan', 'year': '2008', 'title': 'Informetrics review', 'doi': ''},
        {'raw': 'Ghost, G. (2001). Not in this document at all, hallucinated entry.',
         'first_author': 'Ghost', 'year': '2001', 'title': 'Not here', 'doi': ''},
    ]
    import digestion.bibliographyExtraction.grobid_client as gc
    monkeypatch.setattr(gc, 'grobid_alive', lambda url: True)
    monkeypatch.setattr(gc, 'extract_refs_from_pdf', lambda pdf, url: refs)
    bibliography_map, references_data = B.extract_bibliography_via_grobid(soup, '/x.pdf', 'http://x')
    assert 'ghost2001' not in bibliography_map
    assert len(references_data) == 3


def test_bibliography_health_flags_glued_and_overlong():
    # Two run-on entries carrying multiple (year) patterns → suspect.
    glued = ['Al-Awqati, Q. (2007). Impact. doi:x Archambault, E. (2009). History. Scientometrics.',
             'Adam, D. (2002). Counting. Nature. Bar-Ilan, J. (2008). Informetrics review.',
             'Normal, N. (2010). A perfectly ordinary single entry here.']
    h = B.assess_bibliography_health(glued)
    assert h['suspect'] and h['multi_year_entries'] == 2

    # Overlong merged blob (>=3x median, >=500 chars) → suspect even without paren years.
    long_blob = 'x' * 900
    h2 = B.assess_bibliography_health(['short entry one here', 'short entry two here',
                                       'short entry three xx', long_blob])
    assert h2['suspect'] and h2['overlong_entries'] == 1

    # A clean bibliography → not suspect.
    clean = [f'Author{i}, A. ({1990 + i}). A title. A Journal, {i}(1), 1-10.' for i in range(20)]
    h3 = B.assess_bibliography_health(clean)
    assert not h3['suspect']
    assert B.assess_bibliography_health([])['suspect'] is False


def test_healthy_bibliography_never_calls_grobid(monkeypatch):
    # The escalation gate: with a CLEAN bibliography, GROBID must not even be attempted —
    # non-blocking by construction (no network touch on the common path).
    import digestion.bibliographyExtraction.bib_passes as BP
    calls = []
    monkeypatch.setattr(BP, 'merge_grobid_into_bibliography',
                        lambda *a, **k: calls.append(1) or 0)
    monkeypatch.setenv('GROBID_URL', 'http://localhost:9')
    monkeypatch.delenv('GROBID_ALWAYS', raising=False)

    html = ('<html><body><h1>References</h1>'
            + ''.join(f'<p>Author{i}, A. ({1990 + i}). Title {i}. Journal, {i}(1), 1-10.</p>'
                      for i in range(12))
            + '</body></html>')
    soup = BeautifulSoup(html, 'html.parser')

    class Ctx:
        is_stem = False
        output_dir = '.'
    ctx = Ctx(); ctx.soup = soup
    # stage a fake source.pdf presence via tmp output_dir
    import tempfile, os as _os
    with tempfile.TemporaryDirectory() as td:
        open(_os.path.join(td, 'source.pdf'), 'wb').write(b'%PDF-1.4 fake')
        ctx.output_dir = td
        BP.ExtractBibliography().apply(ctx)
    assert calls == []                       # healthy → no GROBID attempt
    assert len(ctx.references_data) >= 10    # regex path ran normally


def test_suspect_bibliography_merges_additively(monkeypatch):
    # Suspect blobs escalate to the surgical merge; the regex extraction ALWAYS stands and the
    # merge only ADDS. A merge that adds nothing (server down etc.) leaves the regex result intact.
    import digestion.bibliographyExtraction.bib_passes as BP
    seen = {}

    def fake_merge(soup, pdf, url, bibliography_map, references_data, suspect_ps):
        seen['suspects'] = len(suspect_ps)
        seen['refs_before'] = len(references_data)
        return 0                              # GROBID couldn't help — nothing added, nothing lost

    monkeypatch.setattr(BP, 'merge_grobid_into_bibliography', fake_merge)
    monkeypatch.setenv('GROBID_URL', 'http://localhost:9')
    glued = ('Al-Awqati, Q. (2007). Impact factors. Kidney Int. doi: 10.1038/x '
             'Archambault, E. (2009). History of the JIF. Scientometrics, 79(3), 635-649.')
    glued2 = ('Adam, D. (2002). The counting house. Nature, 415. '
              'Bar-Ilan, J. (2008). Informetrics review. J. Informetrics, 2(1), 1-52.')
    html = ('<html><body><h1>References</h1>'
            f'<p>{glued}</p><p>{glued2}</p>'
            '<p>Normal, N. (2010). Ordinary entry. Journal, 1(1), 1-2.</p></body></html>')
    soup = BeautifulSoup(html, 'html.parser')

    class Ctx:
        is_stem = False
    ctx = Ctx(); ctx.soup = soup
    import tempfile, os as _os
    with tempfile.TemporaryDirectory() as td:
        open(_os.path.join(td, 'source.pdf'), 'wb').write(b'%PDF-1.4 fake')
        ctx.output_dir = td
        BP.ExtractBibliography().apply(ctx)
    assert seen.get('suspects') == 2         # the two glued paragraphs, not the clean one
    assert seen['refs_before'] >= 1          # regex extraction ran BEFORE the merge
    assert ctx.references_data               # and its result stands


def test_merge_adds_hidden_entry_only_into_suspect_paragraph():
    # Core surgical semantics on the real Al-Awqati shape: regex keyed the blob to its first
    # author only; the merge adds the HIDDEN entry (all keys absent) into the suspect paragraph,
    # never touches existing keys, and ignores refs probing outside the suspect set.
    glued = ('Adam, D. (2002). The counting house. Nature, 415(6873), 726-729. doi: 10.1038/415726a '
             'Al-Awqati, Q. (2007). Impact factors and prestige. Kidney International, 71(3), 183-185.')
    html = (f'<html><body><h1>References</h1><p>{glued}</p>'
            '<p>Normal, N. (2010). Ordinary entry. Journal, 1(1), 1-2.</p></body></html>')
    soup = BeautifulSoup(html, 'html.parser')
    suspect_ps = [soup.find_all('p')[0]]                      # only the glued blob is suspect
    bibliography_map = {'adam2002': 'adam2002'}               # regex reached the blob's FIRST entry
    references_data = [{'referenceId': 'adam2002', 'content': 'x'}]

    refs = [
        # hidden entry inside the suspect blob → must be ADDED
        {'raw': 'Al-Awqati, Q. (2007). Impact factors and prestige. Kidney International, 71(3), 183-185.',
         'first_author': 'Al-Awqati', 'year': '2007', 'title': 'Impact factors and prestige', 'doi': 'x'},
        # already reachable by an existing key → must be SKIPPED (never overwritten/duplicated)
        {'raw': 'Adam, D. (2002). The counting house. Nature, 415(6873), 726-729.',
         'first_author': 'Adam', 'year': '2002', 'title': 'The counting house', 'doi': ''},
        # keys absent but probes into a NON-suspect paragraph → out of surgical scope, SKIPPED
        {'raw': 'Normal, N. (2010). Ordinary entry. Journal, 1(1), 1-2.',
         'first_author': 'Normal', 'year': '2010', 'title': 'Ordinary entry', 'doi': ''},
    ]
    added = B.merge_grobid_refs(soup, refs, bibliography_map, references_data, suspect_ps)
    assert added == 1
    assert bibliography_map['alawqati2007'] == 'alawqati2007'
    assert bibliography_map['adam2002'] == 'adam2002'          # untouched
    assert 'normal2010' not in bibliography_map                # out of scope
    anchors = soup.find_all('a', class_='bib-entry')
    assert {a['id'] for a in anchors} == {'alawqati2007'}      # anchored into the suspect blob
    assert anchors[0].find_parent('p') is suspect_ps[0]
    assert len(references_data) == 2                           # regex entry + the one addition


def test_falls_back_to_none_when_server_down(monkeypatch):
    import digestion.bibliographyExtraction.grobid_client as gc
    monkeypatch.setattr(gc, 'grobid_alive', lambda url: False)
    soup = BeautifulSoup('<p>whatever</p>', 'html.parser')
    assert B.extract_bibliography_via_grobid(soup, '/x.pdf', 'http://down') is None


def test_falls_back_to_none_on_transport_error(monkeypatch):
    import digestion.bibliographyExtraction.grobid_client as gc
    monkeypatch.setattr(gc, 'grobid_alive', lambda url: True)

    def boom(pdf, url):
        raise OSError('connection reset')
    monkeypatch.setattr(gc, 'extract_refs_from_pdf', boom)
    soup = BeautifulSoup('<p>whatever</p>', 'html.parser')
    assert B.extract_bibliography_via_grobid(soup, '/x.pdf', 'http://x') is None
