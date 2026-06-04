#!/usr/bin/env python3
"""
ar5iv → Hyperlit preprocessor.

Detects ar5iv's LaTeXML markup (the HTML representation arXiv hosts for every
arXiv submission) and rewrites it into Hyperlit's internal citation conventions
before the rest of the HTML pipeline runs:

  - <cite class="ltx_cite"><a href="#bib.bibN">N</a></cite>
      → <a class="in-text-citation" href="#bib.bibN">[N]</a>

  - <li id="bib.bibN" class="ltx_bibitem">…bibblocks…</li>
      → <p><a class="bib-entry" id="bib.bibN">[N] content</a></p>
      + entry written into references.json:
        {"referenceId": "bib.bibN", "content": "[N] content"}

Non-ar5iv HTML is a no-op — the script returns immediately. Safe to wire into the
HTML pipeline unconditionally.

Usage: python3 ar5iv_preprocessor.py <html_in_place> <output_dir>
"""

import base64
import json
import os
import re
import sys
import time

from bs4 import BeautifulSoup


def looks_like_ar5iv(soup) -> bool:
    """ar5iv HTML always has at least one .ltx_bibitem or .ltx_bibliography element."""
    return bool(soup.find(class_="ltx_bibitem") or soup.find(class_="ltx_bibliography"))


def extract_bibitem_text(li) -> str:
    """Join the inner ltx_bibblock spans into a clean reference string.

    ar5iv wraps each line of a bibitem in <span class="ltx_bibblock">. We strip the
    [N] tag span (re-added by the caller in canonical position) and squash internal
    whitespace so the output reads as one continuous sentence per reference.
    """
    # Drop the leading [N] tag span — we'll re-add it deterministically.
    for tag_span in li.find_all("span", class_="ltx_tag_bibitem"):
        tag_span.decompose()

    blocks = li.find_all("span", class_="ltx_bibblock")
    if blocks:
        parts = [b.get_text(" ", strip=True) for b in blocks]
    else:
        parts = [li.get_text(" ", strip=True)]

    text = " ".join(p for p in parts if p)
    return re.sub(r"\s+", " ", text).strip()


def extract_bibitem_number(original_li) -> str:
    """Pull the citation number (e.g. '19') from <span class="ltx_tag_bibitem">[19]</span>.

    Caller has already decomposed the tag span by the time we'd want the number, so
    this needs to run BEFORE extract_bibitem_text or against a copy. We resolve that
    by reading the number off the id ('bib.bib19' → '19') as a fallback.
    """
    tag = original_li.find("span", class_="ltx_tag_bibitem")
    if tag:
        text = tag.get_text(strip=True)
        m = re.search(r"\d+", text)
        if m:
            return m.group(0)

    bib_id = original_li.get("id", "")
    m = re.search(r"\d+", bib_id)
    return m.group(0) if m else ""


def rewrite_bibitems(soup) -> list[dict]:
    """Replace each <li class="ltx_bibitem"> with a Hyperlit <p><a class="bib-entry">.

    Returns the references list ready for writing to references.json.
    """
    references = []

    bibitems = soup.find_all("li", class_="ltx_bibitem")
    for li in bibitems:
        bib_id = li.get("id", "").strip()
        if not bib_id:
            continue

        number = extract_bibitem_number(li)
        # extract_bibitem_text mutates `li` (it decomposes the tag span), so call it
        # after extract_bibitem_number above.
        text = extract_bibitem_text(li)
        if not text:
            continue

        display = f"[{number}] {text}" if number else text

        # Build replacement <p><a class="bib-entry">…</a></p>
        new_p = soup.new_tag("p")
        anchor = soup.new_tag("a", id=bib_id)
        anchor["class"] = "bib-entry"
        anchor.string = display
        new_p.append(anchor)
        li.replace_with(new_p)

        references.append({
            "referenceId": bib_id,
            "content": display,
        })

    # The surrounding <ul class="ltx_biblist"> or <ol> wrapper is now full of <p> tags
    # rather than <li> — that's fine, but the wrapping <ul>/<ol> looks weird. Unwrap
    # it so the bibliography flows as ordinary paragraphs.
    for wrapper in soup.find_all(["ul", "ol"], class_="ltx_biblist"):
        wrapper.unwrap()

    return references


def rewrite_cites(soup) -> int:
    """Convert ar5iv <cite> blocks into Hyperlit's in-text-citation anchors.

    Supports all three LaTeX citation styles — \\cite (numbered, "[19]"),
    \\citep (parenthetical author-date, "(Smith 2023)"), \\citet (textual,
    "Smith (2023)") — by preserving the brackets/parens/commas that already
    live as text nodes between the inner anchors, and only converting the
    anchor classes themselves. Then unwrap the <cite> so its contents become
    inline with the surrounding sentence.
    """
    count = 0
    for cite in soup.find_all("cite", class_="ltx_cite"):
        converted_any = False
        for a in cite.find_all("a", href=True):
            if a["href"].startswith("#bib."):
                a["class"] = "in-text-citation"
                # The link text is often nested in a cosmetic <span>; unwrap so the
                # final markup is <a class="in-text-citation" href="…">19</a>
                # instead of <a><span>19</span></a>.
                for inner_span in a.find_all("span"):
                    inner_span.unwrap()
                converted_any = True
        # Unwrap the <cite> regardless: even if it had no bib refs (rare), the
        # wrapper isn't doing anything useful for us.
        cite.unwrap()
        if converted_any:
            count += 1
    return count


def strip_ltx_list_markers(soup) -> None:
    """Remove ar5iv's manual enumerate/itemize tag spans.

    LaTeXML emits <span class="ltx_tag ltx_tag_item">1.</span> as a sibling of
    each list item's content. When that's wrapped in an <ol>, the browser also
    auto-numbers the items — so without stripping these the reader sees
    "1. 1. First contribution" duplicated. Items inside <ul> are similarly
    cleaned (the markers are usually bullets there).
    """
    for span in soup.find_all("span", class_="ltx_tag_item"):
        span.decompose()


def unwrap_cosmetic_wrappers(soup) -> None:
    """Flatten ar5iv's over-nested wrappers so the DOM matches Hyperlit's expectations.

    - <div class="ltx_para"> wraps every paragraph inside list items, theorems,
      etc. Unwrapping lifts the <p> directly under the <li>, which is what the
      downstream pipeline expects.
    - <span> inside <a> is purely cosmetic in LaTeXML; unwrap so cross-references
      like §3 don't render as <a><span>3</span></a>.
    """
    for div in soup.find_all("div", class_="ltx_para"):
        div.unwrap()

    for a in soup.find_all("a"):
        for span in a.find_all("span"):
            span.unwrap()


def rewrite_footnotes(soup) -> list[dict]:
    """Extract ar5iv's inline footnotes and convert them to Hyperlit's sup-marker form.

    ar5iv embeds a footnote's body inside the same span as its marker:

      <span id="footnote1" class="ltx_note ltx_role_footnote">
        <sup class="ltx_note_mark">1</sup>
        <span class="ltx_note_outer"><span class="ltx_note_content">
          <sup class="ltx_note_mark">1</sup>
          <span class="ltx_tag ltx_tag_note">1</span>
          Some maps are longer than a single song; …
        </span></span>
      </span>

    The downstream pipeline (`html_footnote_processor.py`) expects markers in the
    running text + content elsewhere, so without this step ar5iv footnote content
    gets inlined into paragraph text (you see the body text mid-sentence). We:

      1. Generate a unique FnXXX id (matching html_footnote_processor's format).
      2. Pull the body text out of ltx_note_content (stripping inner sup/tag markers).
      3. Replace the entire ltx_note span with
         <sup class="footnote-ref" id="FnXXX" fn-count-id="N">N</sup>.
      4. Collect {footnoteId, content} for footnotes.json.
    """
    footnotes = []
    counter = 1
    base_id = int(time.time() * 1000)

    notes = [
        n for n in soup.find_all("span")
        if "ltx_role_footnote" in (n.get("class") or [])
    ]

    for note in notes:
        # Outer marker (the <sup> sibling of the content span, not the duplicate
        # inside ltx_note_content). recursive=False so we don't grab the inner one.
        outer_sup = note.find("sup", class_="ltx_note_mark", recursive=False)
        marker_text = outer_sup.get_text(strip=True) if outer_sup else str(counter)

        content_span = note.find("span", class_="ltx_note_content")
        if content_span:
            for inner_sup in content_span.find_all("sup", class_="ltx_note_mark"):
                inner_sup.decompose()
            for tag_span in content_span.find_all("span", class_="ltx_tag_note"):
                tag_span.decompose()
            content_html = content_span.decode_contents().strip()
            content_html = re.sub(r"\s+", " ", content_html)
        else:
            content_html = ""

        fn_id = f"Fn{base_id}{counter:03d}"

        new_sup = soup.new_tag("sup")
        new_sup["class"] = "footnote-ref"
        new_sup["id"] = fn_id
        new_sup["fn-count-id"] = str(counter)
        new_sup.string = marker_text
        note.replace_with(new_sup)

        footnotes.append({
            "footnoteId": fn_id,
            "content": content_html,
        })
        counter += 1

    return footnotes


def rewrite_math(soup) -> int:
    """ar5iv emits each equation as a <math> tree with three child branches: a
    MathML presentation, an alt-text fallback, and the LaTeX source in
    <annotation encoding="application/x-tex">. When HTMLPurifier strips classes
    and styles, all three branches collapse into plain text and concatenate —
    producing the "$$pos_x...subscript pos x ... \\mathit{pos}_{x}$$" salad.

    We replace each <math> with Hyperlit's native math element shape consumed by
    `renderMathElements()` in lazyLoaderFactory.js:

        inline:  <latex data-math="<base64-utf8>">LATEX</latex>
        display: <latex-block data-math="<base64-utf8>">LATEX</latex-block>

    Two things to note:

      - data-math holds base64-encoded LaTeX so the source survives HTML attribute
        escaping cleanly. KaTeX rendering uses this.
      - The plain LaTeX source ALSO sits as the element's text content. This is
        important: HTMLPurifier's AutoFormat.RemoveEmpty strips elements that have
        no children — a self-closing <latex/> alongside a single-element paragraph
        wipes both the math AND its parent <p>. Giving the element text content
        prevents that. The text is also a useful fallback if KaTeX fails: the
        reader sees the LaTeX source instead of nothing.
    """
    count = 0
    for math in soup.find_all("math"):
        annotation = math.find("annotation", attrs={"encoding": "application/x-tex"})
        if annotation is None:
            annotation = math.find("annotation")
        if annotation is None:
            math.decompose()
            continue

        latex = (annotation.get_text() or "").strip()
        if not latex:
            math.decompose()
            continue

        encoded = base64.b64encode(latex.encode("utf-8")).decode("ascii")
        is_display = (math.get("display") or "").lower() == "block"

        tag_name = "latex-block" if is_display else "latex"
        new_tag = soup.new_tag(tag_name)
        new_tag["data-math"] = encoded
        new_tag.string = latex
        math.replace_with(new_tag)
        count += 1

    return count


def lift_figures(soup) -> int:
    """ar5iv wraps every figure in <figure class="ltx_figure">…<img/>…<figcaption/></figure>.

    HTMLPurifier is HTML4-only — it strips <figure> and <figcaption>, lifting
    their children up as siblings of the surrounding <p> tags. The orphan <img>
    then survives in the DOM but doesn't end up in any node, because
    html_footnote_processor.py only walks
    ['p','h1'..,'ul','ol','li','blockquote','table'] when building node chunks.

    We split each <figure> into TWO sibling nodes BEFORE sanitization:

        <p><img src="…"></p>                                   ← image node (<p>)
        <blockquote>                                            ← caption node (<blockquote>)
          <strong>Figure 6:</strong> Caption body text.
        </blockquote>

    Why separate nodes:
      - Hyperlit annotates per node, so splitting lets users hyperlight / hypercite
        just the image OR just the caption independently.
      - The <blockquote> on the caption gives it native browser styling (left
        border + indent) — a clear visual cue that this is a figure caption,
        not part of running prose.

    A wrapping <div> would group them visually but isn't picked up as a node by
    html_footnote_processor.py — that's fine because the surrounding paragraph
    flow already provides the visual grouping (image directly above its caption).
    """
    count = 0
    # Process figures inner-to-outer so nested figures get their own wrappers
    # before their parent figure is replaced. (reversed() on the list reverses
    # document order, which roughly approximates inner-first for nested trees.)
    for fig in reversed(soup.find_all("figure")):
        imgs = fig.find_all("img")
        # Tables can appear instead of or alongside images (table figures use
        # ltx_table). Pick top-level tables only — nested tables in cells stay
        # inside their parent table.
        tables = [t for t in fig.find_all("table") if not t.find_parent("table")]

        cap = fig.find("figcaption")
        # Pull the "Figure N:" / "Table N:" label cleanly. ar5iv nests it in
        # <span class="ltx_tag_figure"> or <span class="ltx_tag_table">.
        label_text = ""
        body_text = ""
        if cap is not None:
            label_span = cap.find("span", class_=re.compile(r"ltx_tag_(figure|table)"))
            if label_span is not None:
                label_text = label_span.get_text(" ", strip=True)
                label_span.decompose()
            body_text = cap.get_text(" ", strip=True)
            body_text = re.sub(r"\s+", " ", body_text).strip(" :")

        # Wrap the (img-p, table, caption-blockquote) trio in a <div> just so we
        # have something to slot in where the <figure> was. The div isn't picked
        # up as a node by html_footnote_processor.py, but it preserves DOM order.
        wrapper = soup.new_tag("div")

        if imgs:
            img_p = soup.new_tag("p")
            for img in imgs:
                img_p.append(img.extract())
            wrapper.append(img_p)

        for tbl in tables:
            wrapper.append(tbl.extract())

        if label_text or body_text:
            cap_bq = soup.new_tag("blockquote")
            if label_text:
                strong = soup.new_tag("strong")
                strong.string = label_text.rstrip(": ") + ":"
                cap_bq.append(strong)
                if body_text:
                    cap_bq.append(soup.new_string(" "))
            if body_text:
                cap_bq.append(soup.new_string(body_text))
            wrapper.append(cap_bq)

        if not wrapper.contents:
            fig.decompose()
            continue

        fig.replace_with(wrapper)
        count += 1
    return count


def absolutise_ar5iv_urls(soup) -> None:
    """ar5iv emits image and asset references as host-relative paths
    (`/html/2302.08927/assets/x1.png`). Those would 404 against our own origin —
    rewrite to absolute ar5iv.labs.arxiv.org URLs so the browser pulls them
    directly from arXiv's CDN.
    """
    base = "https://ar5iv.labs.arxiv.org"
    for img in soup.find_all("img"):
        src = img.get("src", "")
        if src.startswith("/"):
            img["src"] = base + src
    # ar5iv also emits same-origin links to its own pages (e.g. PDF download buttons,
    # nav links). Don't bother rewriting those — they're already stripped by
    # strip_ar5iv_footer or aren't surfaced in the body anyway.


def strip_section_cross_refs(soup) -> None:
    """ar5iv internal section refs (`<a href="#S3">3</a>`, `<a href="#S2.F1">Fig. 1</a>`)
    point at section/figure/equation anchor IDs that get renumbered by
    preprocess_html.py — so the targets cease to exist. Strip the <a> wrapper but
    keep the visible text. Reader still sees "§3" or "Fig. 1" in prose; just can't
    click to jump (which wasn't working anyway).

    Bibliography refs (`href="#bib...`) and footnotes are NOT touched — they've
    already been rewritten to their Hyperlit-internal forms by earlier passes.
    """
    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Internal ar5iv ID patterns: S1, S2.F3, S1.SS2.E4, A2 (appendix), etc.
        # Always start with `#` followed by a capital letter; never `#bib.`.
        if href.startswith("#") and not href.startswith("#bib.") and not href.startswith("#footnote"):
            a.unwrap()


def strip_ar5iv_footer(soup) -> None:
    """Drop ar5iv's site UI (feedback links, conversion report, generated-by line).

    These are not part of the paper and would otherwise become real nodes in the book.
    """
    for cls in ("ltx_page_logo", "ltx_dates", "ltx_role_endpage"):
        for el in soup.find_all(class_=cls):
            el.decompose()
    # The "◄ Feelinglucky? Conversionreport Reportan issue" navbar isn't classed
    # uniformly. Best-effort: drop divs whose text starts with the back arrow.
    for div in soup.find_all("div"):
        text = (div.get_text(" ", strip=True) or "")[:80]
        if text.startswith("◄") and "Feelinglucky" in text:
            div.decompose()


def main(html_file: str, output_dir: str) -> None:
    with open(html_file, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f.read(), "html.parser")

    if not looks_like_ar5iv(soup):
        print("ar5iv_preprocessor: not ar5iv — no-op")
        return

    references = rewrite_bibitems(soup)
    cite_count = rewrite_cites(soup)
    footnotes = rewrite_footnotes(soup)
    math_count = rewrite_math(soup)
    figure_count = lift_figures(soup)
    strip_ltx_list_markers(soup)
    unwrap_cosmetic_wrappers(soup)
    strip_section_cross_refs(soup)
    absolutise_ar5iv_urls(soup)
    strip_ar5iv_footer(soup)

    with open(html_file, "w", encoding="utf-8") as f:
        f.write(str(soup))

    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "references.json"), "w", encoding="utf-8") as f:
        json.dump(references, f, ensure_ascii=False, indent=2)
    with open(os.path.join(output_dir, "footnotes.json"), "w", encoding="utf-8") as f:
        json.dump(footnotes, f, ensure_ascii=False, indent=2)

    print(
        f"ar5iv_preprocessor: rewrote {len(references)} bibitems, "
        f"{cite_count} <cite> blocks, {len(footnotes)} footnotes, "
        f"{math_count} <math> blocks, {figure_count} figures"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: ar5iv_preprocessor.py <html_file> <output_dir>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
