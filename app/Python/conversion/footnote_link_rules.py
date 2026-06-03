"""EPUB footnote LINKING as an ordered registry of LinkRule units (was the monolithic
`FootnoteConverter.convert`). Each rule is a small, independently unit-testable step that mutates a
shared `FootnoteLinkContext`; the registry order IS the pipeline order. A new EPUB footnote variant
is absorbed by ADDING a rule (op:add + op:register into FOOTNOTE_LINK_RULES), not by editing a
300-line method — which is what no model could do reliably (the aarushi nested-noteref bug lived here).

This is a PURE extraction of the original method — the rules preserve its exact logic and ordering,
including the in-place mutation of the caller's `all_footnotes` list (reverse-definition appends to
it, and epub_normalizer's `_write_assessment` reads it afterwards).
"""
import random
import re
import string
import time

from bs4 import BeautifulSoup, NavigableString

from .link_base import LinkRule, run_link_rules

_BLOCK_TAGS = {'p', 'div', 'li', 'aside', 'section', 'blockquote', 'td'}


# ---------------------------------------------------------------------------
# Shared context (the state the monolith threaded through its phases)
# ---------------------------------------------------------------------------
class FootnoteLinkContext:
    def __init__(self, soup, all_footnotes, all_noterefs, book_id):
        self.soup = soup
        self.book_id = book_id
        # SAME list reference (not a copy): reverse-definition appends in place, and
        # epub_normalizer._write_assessment reads `all_footnotes` after convert() returns.
        self.all_footnotes = all_footnotes
        self.all_noterefs = all_noterefs               # reverse-mapping REASSIGNS this (new list)
        self.all_footnote_ids = {fn.get('id', '') for fn in all_footnotes if fn.get('id')}
        self.id_mapping = {}                            # old_id -> {new_id, count, content, element, ...}
        self.footnotes_json = []
        self.used_ref_ids = set()
        self.linked_targets = set()                     # def ids that got a SURVIVING in-text link
        self.converted_refs = 0
        self.numeric_count = 1
        self.backlinks_excluded = 0
        self.nested_excluded = 0
        self.linking_stats = None


# ---------------------------------------------------------------------------
# Helper functions (were FootnoteConverter methods — pure, no instance state)
# ---------------------------------------------------------------------------
def strip_leading_footnote_number(content):
    """Remove leading footnote numbers/symbol markers from a definition's content
    ('5. Text' / '[5] Text' / '<sup>5</sup>. Text' / '* Text' → 'Text')."""
    if not content:
        return content
    soup = BeautifulSoup(content, 'html.parser')

    def strip_marker_element(container):
        first_elem = None
        for child in container.children:
            if hasattr(child, 'name') and child.name:
                first_elem = child
                break
            elif isinstance(child, NavigableString) and str(child).strip():
                break
        if first_elem and first_elem.name in ['a', 'sup']:
            elem_text = first_elem.get_text().strip()
            if re.match(r'^(\d+\.?|[\*†‡§¶#a-zA-Z]{1,3}\.?)$', elem_text):
                next_sib = first_elem.next_sibling
                first_elem.decompose()
                if next_sib and isinstance(next_sib, NavigableString):
                    text = str(next_sib)
                    next_sib.replace_with(re.sub(r'^[\.\s]+', '', text))
                return True
        return False

    strip_marker_element(soup)
    for p_tag in soup.find_all('p'):
        strip_marker_element(p_tag)
    content = str(soup)
    for pattern in (r'^\s*\[\d+\]\s*\.?\s*', r'^\s*\d+\.\s+', r'^\s*\d+\s*\)\s*',
                    r'^\s*\(\d+\)\s*', r'^\s*[\*†‡§¶#]+\s*'):
        content = re.sub(pattern, '', content, count=1)
    return content.strip()


def extract_footnote_content(elem, old_id):
    """Extract a footnote definition's content (handling the empty/numeric/symbol <a>-marker case
    where the content is in following siblings, and stripping back-links + leading markers)."""
    if elem.name == 'a':
        elem_text = elem.get_text(strip=True)
        is_empty = not elem_text
        is_numeric = bool(re.match(r'^\d+\.?$', elem_text))
        is_symbol_marker = bool(re.match(r'^[\*†‡§¶#a-zA-Z]{1,3}\.?$', elem_text))
        if is_empty or is_numeric or is_symbol_marker:
            sibling_content = []
            for sibling in elem.next_siblings:
                if hasattr(sibling, 'name') and sibling.name:
                    if sibling.name == 'a' and sibling.get('id'):
                        break
                    sibling_content.append(str(sibling))
                elif str(sibling).strip():
                    sibling_content.append(str(sibling).strip())
            if sibling_content:
                return ''.join(sibling_content)

    content_parts = []
    for child in elem.children:
        if hasattr(child, 'name'):
            if child.name == 'a':
                if ('backlink' in child.get('class', []) or child.get('epub:type', '') == 'backlink'
                        or child.get('role', '') == 'doc-backlink'):
                    continue
            content_parts.append(str(child))
        else:
            text = str(child).strip()
            if text:
                content_parts.append(text)
    content = ''.join(content_parts).strip()
    if not content:
        content = elem.decode_contents()
    content = strip_leading_footnote_number(content)
    if content and not content.startswith('<p') and not content.startswith('<div'):
        content = f'<p>{content}</p>'
    return content


def convert_noteref_element(elem, new_id, fn_count, soup) -> bool:
    """Convert an in-text reference to the canonical <sup class="footnote-ref">. Returns True iff a
    marker was actually emitted — False if the element was detached (so the caller doesn't count a
    phantom conversion that orphans the definition)."""
    if elem.parent is None:
        return False
    prev = elem.previous_sibling
    if prev and isinstance(prev, NavigableString):
        stripped = prev.rstrip()
        if stripped != prev:
            prev.replace_with(NavigableString(stripped))
    if elem.name == 'sup':
        elem.clear()
        elem['fn-count-id'] = str(fn_count)
        elem['id'] = new_id
        elem['class'] = 'footnote-ref'
        elem.string = str(fn_count)
        return True
    elif elem.name == 'a':
        new_sup = soup.new_tag('sup')
        new_sup['fn-count-id'] = str(fn_count)
        new_sup['id'] = new_id
        new_sup['class'] = 'footnote-ref'
        new_sup.string = str(fn_count)
        elem.replace_with(new_sup)
        return True
    return False


def _new_fn_id():
    return f"Fn{int(time.time() * 1000)}_{''.join(random.choices(string.ascii_lowercase + string.digits, k=8))}"


# ---------------------------------------------------------------------------
# The rules (one phase each — order matters; the registry list IS the order)
# ---------------------------------------------------------------------------
class ReverseDefinitionLookup(LinkRule):
    name = 'reverse_definition'
    description = "Find footnote definitions whose id matches a ref target but no detector caught them."

    def apply(self, ctx, log=None):
        unmatched_targets = set()
        for ref in ctx.all_noterefs:
            target_id = ref.get('target_id', '')
            if target_id and target_id not in ctx.all_footnote_ids:
                unmatched_targets.add(target_id)
        if not unmatched_targets:
            return
        log(f"  Reverse-definition lookup: {len(unmatched_targets)} unmatched targets")
        id_lookup = {e.get('id', ''): e for e in ctx.soup.find_all(id=True) if e.get('id')}
        found = skipped = 0
        for target_id in unmatched_targets:
            elem = id_lookup.get(target_id)
            if elem is None:
                continue
            if elem.name not in _BLOCK_TAGS:
                skipped += 1
                continue
            ctx.all_footnotes.append({'id': target_id, 'element': elem,
                                      'type': 'footnote', 'strategy': 'reverse_definition'})
            ctx.all_footnote_ids.add(target_id)
            found += 1
        log(f"  Found {found} definitions via reverse-definition lookup (skipped {skipped} non-block elements)")


class ReverseRefMapping(LinkRule):
    name = 'reverse_mapping'
    description = "Find <a href='#fnId'> in-text refs no detector caught (skipping definition backlinks)."

    def apply(self, ctx, log=None):
        seen_ref_targets = {ref.get('target_id', '') for ref in ctx.all_noterefs}
        additional_refs = []
        for a_tag in ctx.soup.find_all('a', href=True):
            href = a_tag.get('href', '')
            if not href.startswith('#'):
                continue
            target_id = href[1:]
            if target_id in seen_ref_targets or target_id not in ctx.all_footnote_ids:
                continue
            is_backlink = any(re.search(r'\b(footnote|endnote|note)\b', ' '.join(p.get('class', [])), re.I)
                              for p in a_tag.parents)
            if is_backlink:
                continue
            seen_ref_targets.add(target_id)
            additional_refs.append({'element': a_tag, 'target_id': target_id,
                                    'original_marker': a_tag.get_text(strip=True), 'strategy': 'reverse_mapping'})
        ctx.all_noterefs = ctx.all_noterefs + additional_refs
        log(f"  Found {len(additional_refs)} additional refs via reverse-mapping, total: {len(ctx.all_noterefs)}")


class IdMappingBuilder(LinkRule):
    name = 'id_mapping'
    description = "Assign each definition a new Hyperlit id + extract its content (the link decision table)."

    def apply(self, ctx, log=None):
        count = 1
        for fn in ctx.all_footnotes:
            old_id = fn.get('id', '')
            if not old_id:
                continue
            elem = fn.get('element')
            content_html = extract_footnote_content(elem, old_id) if elem else ""
            ctx.id_mapping[old_id] = {'new_id': _new_fn_id(), 'count': count,
                                      'content': content_html, 'element': elem}
            count += 1


class NoterefConverter(LinkRule):
    name = 'noteref_convert'
    description = ("Convert each in-text reference to <sup>, skipping detached/backlink/nested ones "
                  "(the nested-dedup that fixed aarushi) and handling multiply-referenced defs.")

    def apply(self, ctx, log=None):
        # A noteref INSIDE a definition is a back-pointer; one nested in another ref is a double-detect.
        def_elem_ids = {id(fn['element']) for fn in ctx.all_footnotes if fn.get('element') is not None}
        noteref_elem_ids = {id(nr['element']) for nr in ctx.all_noterefs if nr.get('element') is not None}

        for noteref in ctx.all_noterefs:
            target_id = noteref.get('target_id', '')
            elem = noteref.get('element')
            original_marker = noteref.get('original_marker', '')
            if not target_id or not elem:
                continue
            if elem.parent is None:
                continue
            if any(id(anc) in def_elem_ids for anc in elem.parents):
                ctx.backlinks_excluded += 1
                continue
            if any(id(anc) in noteref_elem_ids for anc in elem.parents):
                ctx.nested_excluded += 1
                continue
            if target_id not in ctx.id_mapping:
                continue
            mapping = ctx.id_mapping[target_id]
            new_id = mapping['new_id']
            if new_id in ctx.used_ref_ids:
                new_id = _new_fn_id()
                mapping.setdefault('_duplicate_entries', []).append(new_id)
            ctx.used_ref_ids.add(new_id)
            if original_marker and not original_marker.isdigit():
                display_marker = original_marker
                mapping['original_marker'] = original_marker
            else:
                display_marker = ctx.numeric_count
                mapping['original_marker'] = None
                ctx.numeric_count += 1
            mapping['display_marker'] = display_marker
            if convert_noteref_element(elem, new_id, display_marker, ctx.soup):
                ctx.converted_refs += 1
                ctx.linked_targets.add(target_id)


class LinkingStatsRecorder(LinkRule):
    name = 'linking_stats'
    description = "Record detected-vs-linked-vs-orphaned — the signal that routes a fixer to the LINKER."

    def apply(self, ctx, log=None):
        orphaned = [fn.get('id') for fn in ctx.all_footnotes
                    if fn.get('id') and fn['id'] not in ctx.linked_targets]
        ctx.linking_stats = {
            'detected_footnotes': len(ctx.all_footnotes),
            'detected_noterefs': len(ctx.all_noterefs),
            'backlinks_excluded': ctx.backlinks_excluded,
            'nested_excluded': ctx.nested_excluded,
            'linked': ctx.converted_refs,
            'orphaned_defs': len(orphaned),
            'orphaned_sample': orphaned[:8],
        }
        log(f"  Converted {ctx.converted_refs} in-text references "
            f"({ctx.backlinks_excluded} backlinks + {ctx.nested_excluded} nested refs excluded); "
            f"{len(orphaned)} orphaned")


class FootnotesJsonBuilder(LinkRule):
    name = 'footnotes_json'
    description = "Emit footnotes.json entries (with duplicate entries for multiply-referenced defs)."

    def apply(self, ctx, log=None):
        for old_id, mapping in ctx.id_mapping.items():
            new_id = mapping['new_id']
            display_marker = mapping.get('display_marker', mapping['count'])
            original_marker = mapping.get('original_marker')
            content = mapping['content']
            entry = {'footnoteId': new_id, 'content': f'<a fn-count-id="{display_marker}" id="{new_id}"></a>' + content}
            if original_marker:
                entry['originalMarker'] = original_marker
            ctx.footnotes_json.append(entry)
            for dup_id in mapping.get('_duplicate_entries', []):
                dup = {'footnoteId': dup_id,
                       'content': f'<a fn-count-id="{display_marker}" id="{dup_id}"></a>' + content}
                if original_marker:
                    dup['originalMarker'] = original_marker
                ctx.footnotes_json.append(dup)


class DefinitionElementRemover(LinkRule):
    name = 'definition_remove'
    description = "Decompose each definition element from the body (its content is now in footnotes.json)."

    def apply(self, ctx, log=None):
        for mapping in ctx.id_mapping.values():
            elem = mapping.get('element')
            if elem and elem.parent:
                elem.decompose()


class StrayLinkCleaner(LinkRule):
    name = 'stray_link_clean'
    description = "Remove leftover <a href='#defId'> links to extracted definitions (+ their empty wrappers)."

    def apply(self, ctx, log=None):
        removed_ids = set(ctx.id_mapping.keys())
        stray = 0
        for a_tag in list(ctx.soup.find_all('a', href=True)):
            href = a_tag.get('href', '')
            if not (href.startswith('#') and href[1:] in removed_ids):
                continue
            container = a_tag.parent
            a_tag.decompose()
            stray += 1
            if (container is not None and container.name in ('p', 'li', 'div')
                    and not container.get_text(strip=True)
                    and not container.find(['img', 'figure', 'table'])):
                container.decompose()
        if stray:
            log(f"  Removed {stray} stray links to extracted footnote definitions")


# Ordered registry — the pipeline order. A new EPUB footnote variant = register a new rule here.
FOOTNOTE_LINK_RULES = [
    ReverseDefinitionLookup(),
    ReverseRefMapping(),
    IdMappingBuilder(),
    NoterefConverter(),
    LinkingStatsRecorder(),
    FootnotesJsonBuilder(),
    DefinitionElementRemover(),
    StrayLinkCleaner(),
]


def link_epub_footnotes(soup, all_footnotes, all_noterefs, book_id, log):
    """Run the footnote-linking pipeline. Returns {footnotes_json, id_mapping, linking_stats}.
    The thin `FootnoteConverter.convert` shell calls this."""
    if not all_footnotes and not all_noterefs:
        log("  No footnotes to convert")
        return {'footnotes_json': [], 'id_mapping': {}, 'linking_stats': None}
    log(f"  Converting {len(all_footnotes)} footnotes, {len(all_noterefs)} references (detected)")
    ctx = FootnoteLinkContext(soup, all_footnotes, all_noterefs, book_id)
    run_link_rules(FOOTNOTE_LINK_RULES, ctx, log)
    log(f"  Generated {len(ctx.footnotes_json)} footnote entries for JSON")
    return {'footnotes_json': ctx.footnotes_json, 'id_mapping': ctx.id_mapping,
            'linking_stats': ctx.linking_stats}


# ===========================================================================
# B. In-text MARKER linking (was conversion/footnotes.py:link_footnotes) — wiring
#    <a href="#fnN">, <sup>N</sup>, and [^id] markers to their definitions, strategy-aware.
# ===========================================================================
class MarkerLinkContext:
    def __init__(self, soup, all_elements, strategy, global_footnote_map,
                 sequential_footnote_map, sectioned_footnote_map, footnote_sections):
        self.soup = soup
        self.all_elements = all_elements
        self.strategy = strategy
        self.global_footnote_map = global_footnote_map
        self.sequential_footnote_map = sequential_footnote_map
        self.sectioned_footnote_map = sectioned_footnote_map
        self.footnote_sections = footnote_sections
        self._element_pos = {id(elem): i for i, elem in enumerate(all_elements)}
        self.ref_section_positions = []
        if strategy == 'sequential':
            for marker in soup.find_all('a', class_='footnoteSectionStart'):
                section_num = marker.get('id', '').replace('fnRefSection_', '')
                self.ref_section_positions.append((self._elem_position(marker), section_num))
            self.ref_section_positions.sort(key=lambda x: x[0])

    def _elem_position(self, element):
        pos = self._element_pos.get(id(element))
        if pos is not None:
            return pos
        parent = element.parent
        while parent:
            pos = self._element_pos.get(id(parent))
            if pos is not None:
                return pos
            parent = parent.parent
        return 0

    def find_footnote_data(self, identifier, current_element=None):
        if self.strategy == 'whole_document':
            if identifier in self.global_footnote_map:
                print(f"Found footnote {identifier} in whole-document mode")
                return self.global_footnote_map[identifier]
            print(f"Could not find footnote {identifier} in whole-document mode "
                  f"(available: {list(self.global_footnote_map.keys())[:10]}...)")
            return None
        elif self.strategy == 'sequential':
            return self._find_in_sequential(identifier, current_element)
        return self._find_in_sections(identifier, current_element)

    def _find_in_sequential(self, identifier, current_element):
        current_pos = self._elem_position(current_element)
        section_num = None
        for pos, num in self.ref_section_positions:
            if pos <= current_pos:
                section_num = num
            else:
                break
        if section_num and section_num in self.sequential_footnote_map:
            if identifier in self.sequential_footnote_map[section_num]:
                print(f"Found footnote {identifier} in sequential section {section_num} (pos {current_pos})")
                return self.sequential_footnote_map[section_num][identifier]
        for sec_id, sec_map in self.sequential_footnote_map.items():
            if identifier in sec_map:
                print(f"Fallback: found footnote {identifier} in section {sec_id}")
                return sec_map[identifier]
        print(f"Could not find footnote {identifier} in sequential mode (section {section_num})")
        return None

    def _find_in_sections(self, identifier, current_element):
        current_pos = self._elem_position(current_element)
        for section in self.footnote_sections:
            if (current_pos >= section.get('text_start_idx', 0)
                    and current_pos < section.get('text_end_idx', len(self.all_elements))):
                if identifier in self.sectioned_footnote_map.get(section['id'], {}):
                    return self.sectioned_footnote_map[section['id']][identifier]
        if 'traditional' in self.sectioned_footnote_map and identifier in self.sectioned_footnote_map['traditional']:
            return self.sectioned_footnote_map['traditional'][identifier]
        return None


class AnchorLinkConverter(LinkRule):
    name = 'anchor_link'
    description = "Wire existing <a href='#fnN'> markers to their definition as <sup class='footnote-ref'>."

    def apply(self, ctx, log=None):
        for a_tag in ctx.soup.find_all('a', href=re.compile(r'^#fn\d+')):
            identifier_match = re.search(r'(\d+)', a_tag.get('href', ''))
            if not identifier_match:
                continue
            identifier = identifier_match.group(1)
            text_content = a_tag.get_text(strip=True)
            footnote_data = ctx.find_footnote_data(identifier, a_tag)
            if footnote_data and text_content == identifier:
                new_sup = ctx.soup.new_tag('sup', id=footnote_data['unique_fn_id'])
                new_sup['fn-count-id'] = identifier
                new_sup['class'] = 'footnote-ref'
                if 'section_id' in footnote_data:
                    new_sup['fn-section-id'] = footnote_data['section_id']
                new_sup.string = text_content
                a_tag.replace_with(new_sup)


class SupTagLinkConverter(LinkRule):
    name = 'sup_link'
    description = "Wire bare <sup>N</sup> markers to their definition (in place)."

    def apply(self, ctx, log=None):
        for sup_tag in ctx.soup.find_all('sup'):
            if 'footnote-ref' in sup_tag.get('class', []) or sup_tag.find('a', class_='footnote-ref'):
                continue
            identifier = sup_tag.get_text(strip=True)
            footnote_data = ctx.find_footnote_data(identifier, sup_tag)
            if footnote_data:
                sup_tag['id'] = footnote_data['unique_fn_id']
                sup_tag['fn-count-id'] = identifier
                sup_tag['class'] = sup_tag.get('class', []) + ['footnote-ref']
                if 'section_id' in footnote_data:
                    sup_tag['fn-section-id'] = footnote_data['section_id']


class BracketTextNodeLinker(LinkRule):
    name = 'bracket_link'
    description = "Wire [^id] / [id] markers in text nodes (gated, skipping definitions like [^id]:)."

    def apply(self, ctx, log=None):
        _fn_full_text = ctx.soup.get_text()
        _has_bracket_fn = re.search(r'\[\^?\w+\]', _fn_full_text)
        del _fn_full_text
        if not _has_bracket_fn:
            print("  ⏭️ No [^identifier] patterns found — skipping text node scan for footnotes")
        for text_node in (ctx.soup.find_all(string=True) if _has_bracket_fn else []):
            if not text_node.parent.name in ['style', 'script', 'a']:
                text = str(text_node)
                matches = list(re.finditer(r'\[\^?(\w+)\]', text))
                if matches:
                    new_content = []
                    last_index = 0
                    for match in matches:
                        identifier = match.group(1)
                        match_end = match.end()
                        following_text = text[match_end:match_end + 5].strip()
                        if following_text.startswith(':'):
                            print(f"Skipping footnote definition pattern: {match.group(0)}:")
                            continue
                        footnote_data = ctx.find_footnote_data(identifier, text_node.parent)
                        if footnote_data:
                            new_content.append(NavigableString(text[last_index:match.start()]))
                            new_sup = ctx.soup.new_tag('sup', id=footnote_data['unique_fn_id'])
                            new_sup['fn-count-id'] = identifier
                            new_sup['class'] = 'footnote-ref'
                            if 'section_id' in footnote_data:
                                new_sup['fn-section-id'] = footnote_data['section_id']
                            new_sup.string = identifier
                            new_content.append(new_sup)
                            last_index = match.end()
                        else:
                            continue
                    if new_content:
                        new_content.append(NavigableString(text[last_index:]))
                        text_node.replace_with(*new_content)


# Ordered registry — a new in-text marker shape = register a new rule here.
MARKER_LINK_RULES = [
    AnchorLinkConverter(),
    SupTagLinkConverter(),
    BracketTextNodeLinker(),
]


def link_marker_footnotes(soup, all_elements, strategy, global_footnote_map,
                          sequential_footnote_map, sectioned_footnote_map, footnote_sections):
    """Run the in-text marker-linking pipeline (the thin `link_footnotes` shell calls this)."""
    ctx = MarkerLinkContext(soup, all_elements, strategy, global_footnote_map,
                            sequential_footnote_map, sectioned_footnote_map, footnote_sections)
    run_link_rules(MARKER_LINK_RULES, ctx)
