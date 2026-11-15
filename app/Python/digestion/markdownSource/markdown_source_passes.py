"""Digestion — passes that run ONLY for a user's own Markdown file (`--markdown-source`).

In Markdown, `[^1]: note` and a trailing ` ^block-id` are MARKUP, not content. The OCR/PDF lane feeds
this same pipeline Markdown it generated from a printed page, where the notes block IS part of the
document and stays in the body — so nothing here runs unless the caller says the input was authored
as Markdown (MarkdownProcessor does; PdfProcessor does not).

Why it matters: a vault exported from Hyperlit and dropped back in must come back as the same book.
Left in the body, every definition line was exported a second time beside the real footnote, and the
copy grew with each export → import cycle (tests/Feature/ArchiveExport/VaultRoundTripTest.php).
"""
import re

from bs4 import NavigableString, Tag

from shared.pipeline_base import DocPass

# Obsidian block id: ` ^harvey2020` closing a block (letters, digits and hyphens only).
_BLOCK_ID_RE = re.compile(r'[ \t ]+\^([A-Za-z0-9-]+)\s*$')
_BLOCK_TAGS = ['p', 'li', 'blockquote', 'dd', 'td']


def _last_text_node(element):
    for node in reversed(list(element.descendants)):
        if isinstance(node, NavigableString) and str(node).strip():
            return node
    return None


class StripObsidianBlockIds(DocPass):
    name = 'strip_obsidian_block_ids'
    description = '[markdown source] take the trailing ` ^block-id` off each block before anything reads its text.'
    plain = ('An Obsidian block id (` ^harvey2020` at the end of a paragraph) is a link TARGET, not text. '
             'Left in, it is printed in the book and becomes part of the reference the bibliography '
             'extractor keys. It is removed here and remembered on the element so the links that point '
             'at it can be re-aimed once the bibliography is known.')

    def apply(self, ctx):
        if not getattr(ctx, 'markdown_source', False):
            return
        for element in ctx.soup.find_all(_BLOCK_TAGS):
            if element.find(_BLOCK_TAGS):
                continue   # the id belongs to the innermost block
            node = _last_text_node(element)
            if node is None:
                continue
            match = _BLOCK_ID_RE.search(str(node))
            if not match:
                continue
            node.replace_with(NavigableString(str(node)[:match.start()]))
            # Remembered on the context, not as an attribute: the bibliography extractor snapshots
            # the entry's HTML, and an attribute would be stored with it.
            ctx.obsidian_blocks.append((element, match.group(1)))


def _text_fingerprint(text):
    """Letters and digits only: a reference compared as a run of words, whatever its punctuation."""
    return re.sub(r'[^a-z0-9]+', '', (text or '').lower())


class ResolveVaultCitationLinks(DocPass):
    name = 'resolve_vault_citation_links'
    description = '[markdown source] turn the vault\'s citation links back into links to the bibliography entry.'
    plain = ('A vault export writes an in-text citation in one of two ways: `[2020](#^harvey2020)`, a '
             'link to the reference\'s Obsidian block id; or, when the citation was pointed at the cited '
             'work itself (its note in the vault, or its DOI), a link whose TITLE is the reference\'s '
             'text. Once the bibliography is extracted, both are re-aimed at the entry\'s own id, so the '
             'citation linker recognises them as citations again. Anything that matches no entry is '
             'left exactly as written.')

    # A title must be a recognisable stretch of a reference before it may claim one.
    MIN_TITLE_FINGERPRINT = 20

    def apply(self, ctx):
        if not getattr(ctx, 'markdown_source', False):
            return
        soup = ctx.soup

        by_block = {}
        for element, block_id in getattr(ctx, 'obsidian_blocks', []):
            entry = element.find('a', class_='bib-entry')
            if entry is not None and entry.get('id'):
                by_block[block_id] = entry['id']

        entries = []   # (fingerprint of the entry's text, entry id)
        for entry in soup.find_all('a', class_='bib-entry'):
            if entry.get('id') and entry.parent is not None:
                entries.append((_text_fingerprint(entry.parent.get_text()), entry['id']))

        for link in soup.find_all('a', href=True):
            href = link['href']
            target = None
            for prefix in ('#^', '#%5E', '#%5e'):
                if href.startswith(prefix):
                    target = by_block.get(href[len(prefix):])
                    break
            if target is None and link.get('title'):
                target = self._entry_for_title(link['title'], entries)
                if target is not None:
                    del link['title']
            if target is not None:
                link['href'] = '#' + target

    def _entry_for_title(self, title, entries):
        wanted = _text_fingerprint(title)
        if len(wanted) < self.MIN_TITLE_FINGERPRINT:
            return None
        # The export may have cut a long reference short, so a title is a PREFIX of its entry.
        matches = {entry_id for fingerprint, entry_id in entries if fingerprint.startswith(wanted)}
        return matches.pop() if len(matches) == 1 else None   # two entries it could be → neither


def _previous_element(node):
    sibling = node.previous_sibling
    while sibling is not None and not isinstance(sibling, Tag):
        if str(sibling).strip():
            return None
        sibling = sibling.previous_sibling
    return sibling


def _is_empty_anchor(node):
    return isinstance(node, Tag) and node.name == 'a' and not node.get_text(strip=True) and not node.find(True)


class RemoveMarkdownFootnoteDefinitions(DocPass):
    name = 'remove_markdown_footnote_definitions'
    description = '[markdown source] take linked `[^n]:` definitions out of the body once they are footnotes.'
    plain = ('A Markdown footnote definition is markup: once its text is a footnote and a marker in the '
             'body links to it, the `[^n]: …` paragraphs (and the continuation blocks folded into the '
             'footnote) are removed from the body. A definition NO marker links to stays where it is — '
             'removing it would make its text unreachable.')

    def apply(self, ctx):
        if not getattr(ctx, 'markdown_source', False):
            return
        consumed = getattr(ctx, 'footnote_def_elements', None) or {}
        if not consumed:
            return
        linked = {sup.get('id') for sup in ctx.soup.find_all('sup', class_='footnote-ref')}

        removed = 0
        for fn_id, elements in consumed.items():
            if fn_id not in linked:
                continue
            first = elements[0]
            if first.parent is None:
                continue
            # The rule the author typed between the text and its notes, and the section marker the
            # md→html step planted, exist only for the definitions: they go with the first of a run.
            before = _previous_element(first)
            while before is not None and _is_empty_anchor(before):
                marker, before = before, _previous_element(before)
                if 'footnoteDefinitionsStart' in (marker.get('class') or []):
                    marker.decompose()
            if before is not None and before.name == 'hr':
                before.decompose()
            for element in elements:
                if element.parent is not None:
                    element.decompose()
            removed += 1

        if removed:
            print(f"Markdown source: removed {removed} footnote definition(s) from the body")
