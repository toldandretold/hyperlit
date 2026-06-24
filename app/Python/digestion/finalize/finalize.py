"""Digestion — FINAL stage. The last DocPasses, run after AUDIT: flag structure-vs-output
contradictions (StructuralCoverageAssessment), remove ALL spans before the DB (StripStylingSpans),
build the node chunks (GenerateNodeChunks), and sanitize + write the artifacts (SanitizeAndWrite).
Turns the processed soup into nodes.jsonl / footnotes.jsonl / references.json + the report files.
Extracted from process_document.py (the orchestrator now just imports these into DOC_PASSES)."""
import json
import os
import re
from bs4 import BeautifulSoup, NavigableString
from PIL import Image as PILImage
from shared.assessment import ASSESSMENT
from shared.refkeys import is_likely_reference
from shared.sanitize import sanitize_html
from shared.pipeline_base import DocPass
from digestion._doc_shared import emit_progress


class StructuralCoverageAssessment(DocPass):
    name = 'structural_coverage'
    description = ('[standard] Flag FALSIFIABLE structure-vs-output contradictions: structure that is clearly '
                  'PRESENT in the document but absent from the OUTPUT. The flagship case — many reference-shaped '
                  'paragraphs exist but almost none were extracted → the reference section was never FOUND '
                  '(its "Bibliography"/"References" header is a styled <p>, not an <h*>, so the scan misses it). '
                  'Routes the fix to heading detection instead of the reference matcher.')
    plain = ('Cross-checks what the document CONTAINS against what conversion PRODUCED. A pile of '
             'reference-shaped paragraphs with ~0 references extracted means the reference list was not '
             'located — usually because its section header is a styled <p>, not a real <h*> heading. This is '
             'the signal that tells a human (or the fix-loop) to look at HEADING DETECTION, not bibliography '
             'matching. Diagnostic only — never changes the conversion output.')

    # Conservative thresholds: only fire on an unmistakable contradiction (avoid noise on small/odd docs).
    MIN_REF_SHAPED = 10          # need a real pile of reference-looking paragraphs
    EXTRACTED_RATIO = 0.1        # ...of which ~none (<=10%) were extracted
    MIN_FN_IN_LIST = 10          # footnote markers inside <li> beyond this = a list/index/nav matched as footnotes

    def apply(self, ctx):
        if ctx.is_stem:          # STEM uses numeric [N] refs, counted differently
            return
        soup = ctx.soup
        if soup is None:
            return
        ref_shaped = sum(1 for p in soup.find_all('p') if is_likely_reference(p))
        extracted = len(ctx.references_data or [])
        if ref_shaped >= self.MIN_REF_SHAPED and extracted <= max(2, ref_shaped * self.EXTRACTED_RATIO):
            ASSESSMENT.record(
                module='structural_coverage',
                # Routes to bibliography.py (the scan that failed to locate the section); _DECOMPOSITION_SIBLINGS
                # pairs it with headingMatching.py (the usual real fix — recognise the styled-<p> section header).
                code_ref='bibliography.py:_find_reference_paragraphs',
                decision='faulty',
                rationale=(f'{ref_shaped} reference-shaped paragraphs are present in the document but only '
                           f'{extracted} were extracted — the reference list was not located. Its header is '
                           f'likely a STYLED <p> (e.g. a bold "BIBLIOGRAPHY"/"REFERENCES"), not an <h*>, so '
                           f'the heading-based scan in _find_reference_paragraphs skips it. Fix where the '
                           f'section HEADER is recognised (heading detection), not the reference matcher.'),
                evidence={'reference_shaped_paragraphs': ref_shaped, 'references_extracted': extracted},
                question='Was the reference list FOUND?',
                considered=[{'option': 'reference section located by its heading',
                             'rejected_because': f'only {extracted} of ~{ref_shaped} reference-shaped paragraphs were extracted',
                             'would_need': 'an <h1>-<h6> (or a recognised styled-<p>) "References"/"Bibliography" '
                                           'heading sitting above the entries'}],
                confidence=0.2,
                node_help=self.plain,
            )
            print(f"⚠️ structural_coverage: {ref_shaped} reference-shaped paragraphs but only {extracted} extracted "
                  f"— reference section likely not recognised (styled-<p> header?)")

        # CONTRADICTION 2: footnote references inside LIST ITEMS. Real footnote markers sit in body <p> text;
        # a pile of them inside <li> means a numbered list / index / nav (e.g. an EPUB page-list) was matched
        # as footnotes (rudolph1981finance: a page-list's page-numbers became 66 false <sup class="footnote-ref">).
        # NavStripper removes TAGGED page-list/landmarks navs upstream; this catches the UNTAGGED variants and
        # routes the fix to footnote DETECTION, not the linker.
        fn_in_list = sum(1 for sup in soup.find_all('sup', class_='footnote-ref') if sup.find_parent('li'))
        if fn_in_list >= self.MIN_FN_IN_LIST:
            ASSESSMENT.record(
                module='structural_coverage',
                code_ref='footnoteMatching.py:ClassPatternFootnoteDetector',
                decision='faulty',
                rationale=(f'{fn_in_list} footnote references are inside <li> list items — real footnote markers '
                           f'live in body <p> text, so this many in lists means a numbered list / index / '
                           f'navigation (e.g. an EPUB page-list of page numbers) was matched as footnotes. Fix '
                           f'in footnote DETECTION (exclude nav/list anchors), not the linker.'),
                evidence={'footnote_refs_in_list_items': fn_in_list},
                question='Are these footnote references real, or list/nav entries?',
                considered=[{'option': 'the in-<li> markers are genuine footnotes',
                             'rejected_because': f'{fn_in_list} footnote refs sit inside list items, not body prose',
                             'would_need': 'the markers to appear in running <p> text, not as bare <li> entries'}],
                confidence=0.2,
                node_help=self.plain,
            )
            print(f"⚠️ structural_coverage: {fn_in_list} footnote refs inside <li> — a list/index/nav matched as "
                  f"footnotes (check footnote detection / nav stripping)")


def _span_role(span):
    """Work out what a styling <span> was FOR, from its class / inline style, so the meaning survives as a
    SEMANTIC tag instead of being flattened: 'i' (italic), 'b' (bold), or None (meaningless → just unwrap).
    Publishers express these as class names ('italic'/'bold'/'sc') or inline CSS.

    NOTE: underline is deliberately NOT promoted to <u>. The app reserves <u> for the HYPERCITE system
    (citation markup), so a publisher underline must flatten to plain text — emitting <u> here would
    collide with hypercites. (Underline is presentational anyway; losing it is harmless.)"""
    blob = (' '.join(span.get('class') or []) + ' ' + (span.get('style') or '')).lower()
    if 'italic' in blob or re.search(r'font-style\s*:\s*italic', blob):
        return 'i'
    if 'bold' in blob or re.search(r'font-weight\s*:\s*(bold|[6-9]00)', blob):
        return 'b'
    return None


def _unwrap_spans(soup):
    """Remove EVERY <span> so none reach the DB, but DON'T lose meaning:
      • a styling span we can read (class/style says italic/bold) → the semantic tag <i>/<b>
        (so an italicised title stays italic instead of going flat; underline is NOT promoted — see _span_role);
      • a span carrying an id is an anchor target (page/CFI/bib markers) → an empty <a id> jump-target is
        left in its place (internal links still resolve);
      • anything else → unwrapped to plain text.
    Returns (removed, promoted)."""
    removed = promoted = 0
    for span in list(soup.find_all('span')):
        sid = span.get('id')
        if sid:
            anchor = soup.new_tag('a')          # preserve the anchor target as an empty <a> (not a <span>)
            anchor['id'] = sid
            span.insert_before(anchor)
            del span['id']
        role = _span_role(span)
        if role:
            span.name = role                     # <span class="italic">…</span> → <i>…</i>
            span.attrs = {}                      # the tag now carries the meaning; class/style are noise
            promoted += 1
        else:
            span.unwrap()                        # drop the <span> tag, keep its text content
        removed += 1
    return removed, promoted


def _strip_spans_html(html):
    """Same, for an HTML STRING (footnote / reference content captured as a string before this pass)."""
    if not html or '<span' not in html:
        return html
    frag = BeautifulSoup(html, 'html.parser')
    _unwrap_spans(frag)
    return str(frag)


class StripStylingSpans(DocPass):
    name = 'strip_styling_spans'
    description = ('[always] FINAL span removal — unwrap every <span> (keeping its text) so NONE reach the '
                  'database, across ALL of it: node content AND footnote / reference content. In our pipeline '
                  'spans are styling-only; left in they fragment text and break downstream consumers (e.g. a '
                  'heading whose text sits inside <span>s never shows in the table of contents). Runs LAST in '
                  'the SHARED backend, AFTER all detection/linking that might key on span styling, so EPUB / '
                  'PDF / HTML / DOCX are ALL covered in one place. (EPUB has an earlier SpanUnwrapper, but it '
                  'only catches calibre/class-less spans; this is the universal guarantee.) id-bearing spans '
                  'are kept — they are anchor link targets.')
    plain = ('Removes ALL <span>s at the very end so none reach the DB — node, footnote AND reference content. '
             'But preserves meaning: a span we can read as italic/bold becomes <i>/<b>, and an id-bearing span '
             'becomes an empty <a> anchor; the rest unwrap to plain text. (Underline is NOT promoted — <u> is '
             'reserved for the hypercite system.) Spans fragment text / break the TOC. Universal backend.')

    def apply(self, ctx):
        soup = ctx.soup
        if soup is None:
            return
        stripped, promoted = _unwrap_spans(soup)                         # node content (the main body)
        # footnote + reference content are captured as HTML STRINGS earlier (before this pass), then
        # serialized by SanitizeAndWrite from ctx — strip those too so sub-books / bibliography are clean.
        for bucket in (ctx.footnotes_data, ctx.all_footnotes_data, ctx.references_data):
            for item in (bucket or []):
                if isinstance(item, dict) and item.get('content'):
                    item['content'] = _strip_spans_html(item['content'])
        if stripped:
            print(f"🧹 Removed {stripped} <span>(s) from node content "
                  f"({promoted} promoted to <i>/<b>/<u>, rest unwrapped) — none reach the database")
        return {'spans_stripped': stripped, 'spans_promoted': promoted}


class GenerateNodeChunks(DocPass):
    name = 'generate_node_chunks'
    description = 'PASS 3 — walk the body into node chunks (numeric ids, extracted refs/footnotes, images).'

    def apply(self, ctx):
        soup = ctx.soup
        output_dir = ctx.output_dir
        book_id = ctx.book_id
        # ====================================================================
        # PASS 3: GENERATE FINAL JSON OUTPUT
        # ====================================================================
        emit_progress(78, "doc_json_gen", "Building node chunks")
        print("\n--- PASS 3: Generating Final JSON Output ---")
        # Use the passed book_id parameter instead of generating a new one
        node_chunks_data = []
        start_line_counter = 0
        CHUNK_SIZE = 50
        content_root = soup.body if soup.body else soup

        # Rewrite bare image src to servable route path: img-1.jpeg → /{book_id}/media/img-1.jpeg
        # Also inject width/height from file on disk to prevent layout shift
        for img_tag in content_root.find_all('img'):
            src = img_tag.get('src', '')
            if src and not src.startswith('/') and not src.startswith('http'):
                # Inject dimensions from file on disk before rewriting src
                img_path = os.path.join(output_dir, 'media', src)
                try:
                    with PILImage.open(img_path) as pil_img:
                        w, h = pil_img.size
                        img_tag['width'] = str(w)
                        img_tag['height'] = str(h)
                except Exception:
                    pass  # image missing or unreadable — skip silently
                img_tag['src'] = f'/{book_id}/media/{src}'

        for node in content_root.find_all(recursive=False):
            if isinstance(node, NavigableString) and not node.strip(): continue
            start_line_counter += 1
            chunk_id = (start_line_counter - 1) // CHUNK_SIZE
            node_key = f"{book_id}_{start_line_counter}"

            # Store original ID if it exists (for anchor preservation)
            original_id = node.get('id') if node.has_attr('id') else None

            # Remove ALL class attributes from the node and its children to clean up EPUB styling
            if node.has_attr('class'):
                del node['class']

            # Also remove class attributes from all nested elements EXCEPT functional classes
            preserved_classes = {'in-text-citation', 'footnote-ref', 'bib-entry', 'pageNumber'}
            for nested_element in node.find_all():
                if nested_element.has_attr('class'):
                    # Keep only functional classes, remove styling classes
                    element_classes = nested_element.get('class', [])
                    if isinstance(element_classes, str):
                        element_classes = element_classes.split()
                    functional_classes = [c for c in element_classes if c in preserved_classes]
                    if functional_classes:
                        nested_element['class'] = functional_classes
                    else:
                        del nested_element['class']

            # FORCE all elements to get numerical IDs (overwrite any existing non-numerical IDs)

            node['id'] = start_line_counter

            # Only the TOP-LEVEL node owns an id. Strip phantom ids off any
            # DESCENDANTS: upstream passes (preprocess_html, EPUB heading
            # numbering, etc.) can stamp sequential numeric ids on <p>/<div>/
            # <button> nested inside wrappers like <figure>/<a>. Left in place,
            # the editor bolts a data-node-id onto each at save time, creating a
            # ghost node that shadows the real one — so e.g. deleting a broken
            # image targets the ghost and the real node is never updated (the
            # image returns on refresh). Meaningful ids (FnXXX, bib anchors,
            # hypercite_…) are non-numeric and survive.
            for descendant in node.find_all(True):
                desc_id = descendant.get('id')
                if desc_id and str(desc_id).isdigit():
                    del descendant['id']
                if descendant.has_attr('data-node-id'):
                    del descendant['data-node-id']


            # For specific element types, preserve the original ID as an anchor for backwards compatibility
            if original_id and (
                (node.name == 'li' and node.find('a', attrs={'fn-count-id': True})) or
                (node.name == 'p' and node.find('a', class_='bib-entry')) or
                (node.name and node.name.startswith('h'))
            ):
                # Only add anchor if original_id was not already numerical
                if not original_id.isdigit():
                    original_anchor = soup.new_tag('a', id=original_id)
                    node.insert(0, original_anchor)

            references_in_node = []
            for a in node.find_all('a', class_='in-text-citation'):
                data_refs = a.get('data-refs')
                if data_refs:
                    references_in_node.extend(data_refs.split(','))
                else:
                    references_in_node.append(a['href'].lstrip('#'))
            # Extract footnote IDs and markers from sup elements
            # Store as objects {id, marker} to support non-numeric markers (*, 23a, etc.)
            # This enables dynamic renumbering for numeric footnotes while preserving symbolic markers
            footnotes_in_node = []
            for sup in node.find_all('sup'):
                # Get marker from fn-count-id attribute
                marker = sup.get('fn-count-id', '')
                # New format: sup has id directly and class="footnote-ref"
                if sup.get('class') and 'footnote-ref' in sup.get('class', []):
                    footnote_id = sup.get('id', '')
                    if footnote_id:
                        footnotes_in_node.append({'id': footnote_id, 'marker': marker})
                else:
                    # Old format: anchor inside sup with class="footnote-ref"
                    fn_link = sup.find('a', class_='footnote-ref')
                    if fn_link and fn_link.get('href'):
                        footnote_id = fn_link['href'].lstrip('#')
                        if footnote_id:
                            footnotes_in_node.append({'id': footnote_id, 'marker': marker})
            node_object = {
                "id": node_key, "book": book_id, "chunk_id": chunk_id,
                "startLine": start_line_counter, "content": str(node),
                "references": references_in_node, "footnotes": footnotes_in_node,
                "hypercites": [], "hyperlights": [],
                "plainText": node.get_text(strip=True),
                "type": node.name if hasattr(node, 'name') else 'p'
            }
            node_chunks_data.append(node_object)

        ctx.node_chunks_data = node_chunks_data


class SanitizeAndWrite(DocPass):
    name = 'sanitize_and_write'
    description = 'Sanitize all HTML + write references.json / footnotes.jsonl / nodes.jsonl + dump the assessment.'

    def apply(self, ctx):
        output_dir = ctx.output_dir
        node_chunks_data = ctx.node_chunks_data
        references_data = ctx.references_data
        footnotes_data = ctx.footnotes_data

        emit_progress(80, "doc_sanitize", "Sanitizing output")
        print("\n--- Sanitizing and writing JSON output files ---")
        os.makedirs(output_dir, exist_ok=True)

        # Security: Sanitize all HTML content before writing to JSON
        sanitized_references = [
            {"referenceId": r.get("referenceId", ""), "content": sanitize_html(r.get("content", ""))}
            for r in references_data
        ]
        sanitized_footnotes = [
            {"footnoteId": f.get("footnoteId", ""), "content": sanitize_html(f.get("content", ""))}
            for f in footnotes_data
        ]
        total_nodes = len(node_chunks_data)
        sanitized_nodes = []
        for i, node in enumerate(node_chunks_data):
            sanitized_node = node.copy()
            sanitized_node["content"] = sanitize_html(node.get("content", ""))
            sanitized_nodes.append(sanitized_node)
            if (i + 1) % 5000 == 0:
                emit_progress(80 + int((i / total_nodes) * 4), "doc_sanitize", f"Sanitized {i + 1} / {total_nodes} nodes")

        emit_progress(84, "doc_json_write", "Writing output files")

        # Preserve a populated references.json written by an upstream step in the same
        # run (e.g. ar5iv_preprocessor.py translates LaTeXML bibitems into Hyperlit's
        # bib shape before process_document.py runs). Only fall back to our own
        # extracted references when no usable file already exists. The import pipeline
        # deletes references.json at the start of every import/reconvert, so a file
        # present here was written deliberately this run. Mirrors the guard the legacy
        # html_footnote_processor.py applied on the old HTML path.
        references_path = os.path.join(output_dir, 'references.json')
        existing_refs = None
        if os.path.exists(references_path):
            try:
                with open(references_path, 'r', encoding='utf-8') as f:
                    existing_refs = json.load(f)
            except Exception:
                existing_refs = None
        if isinstance(existing_refs, list) and existing_refs:
            print(f"Keeping existing references.json with {len(existing_refs)} entries")
        else:
            with open(references_path, 'w', encoding='utf-8') as f:
                json.dump(sanitized_references, f, ensure_ascii=False)
            print(f"Successfully created {references_path}")

        # Write footnotes as JSONL for memory-efficient PHP streaming
        footnotes_path = os.path.join(output_dir, 'footnotes.jsonl')
        with open(footnotes_path, 'w', encoding='utf-8') as f:
            for fn in sanitized_footnotes:
                f.write(json.dumps(fn, ensure_ascii=False) + '\n')
        print(f"Successfully created {footnotes_path}")

        # Write nodes as JSONL (one JSON object per line) for memory-efficient PHP streaming
        nodes_path = os.path.join(output_dir, 'nodes.jsonl')
        with open(nodes_path, 'w', encoding='utf-8') as f:
            for node in sanitized_nodes:
                f.write(json.dumps(node, ensure_ascii=False) + '\n')
        print(f"Successfully created {nodes_path}")
        emit_progress(85, "doc_json_written", f"Written {len(sanitized_nodes)} nodes, {len(sanitized_footnotes)} footnotes, {len(sanitized_references)} references")

        # Decision-trace: what the pipeline decided, in which module, and why.
        ASSESSMENT.dump(output_dir)
        print(f"Successfully created {os.path.join(output_dir, 'assessment.json')} ({len(ASSESSMENT.records)} records)")
