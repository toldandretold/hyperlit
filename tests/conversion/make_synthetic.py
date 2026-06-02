#!/usr/bin/env python3
"""
Generate the committed SYNTHETIC fixture set — small, hand-authored inputs that
reproduce each conversion pathway with zero proprietary content, so the public repo
hosts no real books. Real harvested fixtures live in the git-ignored fixtures-local/.

Builds each input, runs it through the real pipeline to read exact counts + sample
links, and writes the manifest. Run once, then:
    python3 tests/conversion/run_regression.py --update-golden
    python3 tests/conversion/run_regression.py
"""
import json, os, re, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_regression as rr
import harvest

FIX = rr.FIXTURES_DIR

BIB = ("\n\n## References\n\nOstrom, Elinor (1990). Governing the Commons. Cambridge "
       "University Press.\n\nHardin, Garrett (1968). The Tragedy of the Commons. Science, "
       "162(3859).\n\nBenkler, Yochai (2006). The Wealth of Networks. Yale University Press.\n")
BIB_HTML = ("<h2>References</h2><p>Ostrom, Elinor (1990). Governing the Commons. Cambridge "
            "University Press.</p><p>Hardin, Garrett (1968). The Tragedy of the Commons. "
            "Science.</p><p>Benkler, Yochai (2006). The Wealth of Networks. Yale UP.</p>")
PROSE = ("# A Study of the Commons\n\nThe governance of shared resources is a central "
         "question in political economy. Communities devise institutions to manage "
         "common-pool resources.\n\nThis paragraph develops the argument with further "
         "detail so the converter has realistic structure to process.\n")

def html_doc(body):
    return f'<html><head><title>t</title></head><body>{body}</body></html>'

def ocr_json(markdown):
    return json.dumps({'pages': [{'index': 0, 'markdown': markdown, 'images': [], 'dimensions': {},
                                  'tables': [], 'hyperlinks': [], 'header': '', 'footer': ''}],
                       'model': 'test', 'usage_info': {}, 'document_annotation': None})

# --- footnote bodies with distinctive words for link assertions ---
FN_MD = ("First point is contested.[^1] Second point follows.[^2] Third point stands.[^3]\n\n"
         "[^1]: A note concerning cathedrals and central planning.\n"
         "[^2]: A note concerning bazaars and emergent order.\n"
         "[^3]: A note concerning the commons and shared governance.\n")
def sup_defs_html(n):
    refs = ''.join(f'<p>Claim {i} is advanced in this paragraph.<sup>{i}</sup> With more prose.</p>' for i in range(1, n+1))
    words = ['cathedrals','bazaars','commons','markets','hackers','gardens','rivers','forests','bridges','harbours','orchards','meadows']
    defs = ''.join(f'<p>[{i}]: A note concerning {words[(i-1)%len(words)]} and governance.</p>' for i in range(1, n+1))
    return refs, defs

# slug -> (pipeline, files-dict). casename always 'synthetic'.
SPECS = {}
def md(slug, body): SPECS[slug] = ('md', {'input.md': body})
def html(slug, body, pre=None): SPECS[slug] = ('html', {'input.html': html_doc(body)}, pre)
def pdf(slug, markdown): SPECS[slug] = ('pdf', {'ocr_response.json': ocr_json(markdown)})

md('md/no_footnotes', PROSE)
md('md/author_year_bracket', "# Commons\n\nProperty regimes vary widely (Ostrom 1990). The tragedy framing (Hardin 1968) was later critiqued (Benkler 2006)." + BIB)
md('md/bibliography_only', PROSE + BIB)
md('md/sequential', "# Chapter\n\n" + FN_MD)

refs12, defs12 = sup_defs_html(12)
html('html/no_footnotes', f'<h1>Commons</h1><p>{PROSE}</p>')
html('html/author_year_bracket', f'<h1>C</h1><p>Regimes vary (Ostrom 1990); the tragedy framing (Hardin 1968) was critiqued (Benkler 2006).</p>{BIB_HTML}')
html('html/bibliography_only', f'<h1>C</h1><p>{PROSE}</p>{BIB_HTML}')
html('html/whole_document', f'<h1>C</h1>{refs12}<h2>Endmatter</h2>{defs12}')
html('html/sectioned', '<h1>Chapter One</h1><p>A<sup>1</sup> and B<sup>2</sup></p><h2>Notes</h2><p>[1]: note c1 cathedrals</p><p>[2]: note c1 bazaars</p><hr/><h1>Chapter Two</h1><p>C<sup>1</sup> and D<sup>2</sup></p><h2>Notes</h2><p>[1]: note c2 commons</p><p>[2]: note c2 markets</p>')
# suppression: 15 body refs, 11 real notes (Endmatter) + 4 bibliography entries (excluded as
# citations) -> the numbering has a gap -> whole-document guard suppresses links rather than
# emit confident wrong ones. Reproduces the raymond2010cathedral2 pathology synthetically.
html('html/numbering_ambiguous_suppressed',
     '<h1>Essay</h1>' + ''.join(f'<p>Body claim {i} is advanced in this paragraph.<sup>{i}</sup> with following prose.</p>' for i in range(1, 16)) +
     '<h1>Endmatter</h1>' + ''.join(f'<p>[{i}]: real note {i} about cathedrals and governance.</p>' for i in range(1, 12)) +
     '<h1>Bibliography</h1>' + ''.join(f'<p>[{i}]: Author {i}. (19{60+i}). A Book Title. Publisher.</p>' for i in range(12, 16)))

pdf('pdf/no_footnotes', PROSE)
pdf('pdf/author_year_bracket', "# Paper\n\nRegimes vary (Ostrom 1990); the tragedy framing (Hardin 1968) was critiqued (Benkler 2006)." + BIB)
pdf('pdf/bibliography_only', PROSE + BIB)
pdf('pdf/sequential', "# Paper\n\n" + FN_MD)

def probe(pipeline, files, preprocessor=None):
    with tempfile.TemporaryDirectory() as fdir:
        for fn, content in files.items():
            open(os.path.join(fdir, fn), 'w').write(content)
        manifest = {'book_id': 'probe'}
        if preprocessor: manifest['preprocessor'] = preprocessor
        fx = {'name': 'probe', 'dir': fdir, 'manifest': manifest, 'pipeline': pipeline}
        with tempfile.TemporaryDirectory() as t:
            err = rr.RUNNERS[pipeline](fx, t)
            if err: return None
            stats = json.load(open(os.path.join(t, 'conversion_stats.json')))
            rr.normalize_outputs(t)
            summary = json.load(open(os.path.join(t, 'nodes.summary.json')))
            content = {f['footnoteId']: f['content'] for f in rr._read_jsonl(os.path.join(t, 'footnotes.normalized.jsonl'))}
            links, seen = [], set()
            for node in summary.get('linked_nodes', []):
                for fn in node.get('footnotes', []):
                    mk = str(fn.get('marker'))
                    if mk in seen: continue
                    sub = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', content.get(fn['id'], ''))).strip()
                    m = re.search(r'(cathedrals|bazaars|commons|markets|hackers|gardens|rivers|forests|bridges|harbours|orchards|meadows)', sub)
                    if m: links.append({'marker': mk, 'content_contains': m.group(1)}); seen.add(mk)
                    if len(links) >= 3: break
                if len(links) >= 3: break
            return {'stats': stats, 'links': links}

def write_fixture(slug, pipeline, files, preprocessor=None):
    p = probe(pipeline, files, preprocessor)
    if not p:
        print(f'  SKIP {slug}: pipeline error'); return
    s = p['stats']
    fdir = os.path.join(FIX, *slug.split('/'), 'synthetic')
    if os.path.isdir(fdir): shutil.rmtree(fdir)
    os.makedirs(fdir)
    for fn, content in files.items():
        open(os.path.join(fdir, fn), 'w').write(content)
    exp = {'references_count': s.get('references_found', 0), 'footnotes_count': s.get('footnotes_matched', 0),
           'audit_gaps': 0, 'footnote_strategy': s.get('footnote_strategy', 'no_footnotes')}
    if s.get('citation_style') and s['citation_style'] != 'none':
        exp['citation_style'] = s['citation_style']
    if p['links']:
        exp['footnote_links'] = p['links']
    man = {'name': 'synthetic', 'description': f'Synthetic non-proprietary fixture for pathway {slug}.',
           'book_id': slug.replace('/', '_'), 'citation_style': s.get('citation_style', 'none'),
           'footnote_strategy': s.get('footnote_strategy', 'no_footnotes'), 'pipeline': pipeline, 'expected': exp}
    if preprocessor: man['preprocessor'] = preprocessor
    json.dump(man, open(os.path.join(fdir, 'manifest.json'), 'w'), indent=4)
    print(f'  {slug:42} strat={s.get("footnote_strategy")} style={s.get("citation_style")} fn={s.get("footnotes_matched")} refs={s.get("references_found")} links={len(p["links"])}')

if __name__ == '__main__':
    print('=== generating synthetic text-pipeline fixtures ===')
    for slug, spec in SPECS.items():
        pipeline, files = spec[0], spec[1]
        pre = spec[2] if len(spec) > 2 else None
        write_fixture(slug, pipeline, files, pre)
