"""Citation reference-key generation + bibliography-entry detection.

Pure functions (no soup mutation, no I/O) extracted from process_document.py so they
can be unit-tested in isolation: given bibliography text, assert the candidate match
keys; given a paragraph's text, assert whether it looks like a reference entry.
"""

import re
import unicodedata


def normalize_unicode_name(name):
    """Normalize unicode characters in names for key matching.
    Converts ß→ss, ü→u, é→e, etc. Also handles hyphenated names."""
    # First handle German ß explicitly (it normalizes to 'ss')
    name = name.replace('ß', 'ss').replace('ẞ', 'SS')
    # Normalize to NFD (decomposed form), then remove combining marks
    normalized = unicodedata.normalize('NFD', name)
    # Keep only ASCII letters, removing diacritics
    ascii_name = ''.join(c for c in normalized if unicodedata.category(c) != 'Mn')
    # Remove hyphens for key generation (von Ingersleben-Seip → von IngerslebenSeip)
    ascii_name = ascii_name.replace('-', '').replace("'", '')
    return ascii_name


# The window in which a bare 4-digit number is plausibly a PUBLICATION YEAR. The ceiling excludes
# arXiv-style ids ("2601"); the floor excludes stray 4-digit numbers in an entry's title, venue or
# page range.
#
# TWO floors, because the two callers have opposite risk profiles. A BIBLIOGRAPHY ENTRY is a long
# string full of incidental numbers, so it keeps the conservative 1900 — dropping it to 1500
# measurably invented references (an EPUB with no bibliography grew one) and shifted entry keys so
# that citations which used to resolve stopped (80bb62b6 lost 3 links, 93d34a74 lost 2). An
# IN-TEXT CITATION is a few words long, and scholarly prose cites originals constantly — there the
# 1900 floor made `generate_ref_keys` return NO KEYS AT ALL, so "(Engels 1886a: 356f; Hegel 1874:
# §§97f)" linked to nothing even though both bibliography entries existed and were keyed correctly
# (an entry's own parenthesized year takes the branch above, which has no floor — which is why the
# targets looked fine and only the in-text side was broken).
PLAUSIBLE_YEAR_MAX = 2099
MODERN_YEAR_MIN = 1900
HISTORICAL_YEAR_MIN = 1500      # in-text citations only — see above


# The "(accessed on 8 September 2013)" / ", retrieved 2019-03-02" tail of a web-cited entry.
# Bounded and stopped at a closing bracket so it can never eat the entry's own title.
# The leading \b matters: without it the alternation matches INSIDE a word — "(cases re|viewed in
# Atteridge & Remling, 2018)" lost its year and its link (5c548774).
_ACCESS_CLAUSE_RE = re.compile(
    r'(?i)\(?\s*\b(?:last\s+)?(?:accessed|retrieved|viewed|downloaded|consulted)\b[^)\]]{0,60}\)?')

# Sentence connectives / stance adverbs that can sit immediately before a narrative citation.
# Capitalised (they open the clause) and never a surname, so they are excluded from author keys.
_DISCOURSE_MARKERS = {
    'Indeed', 'However', 'Thus', 'Therefore', 'Moreover', 'Furthermore', 'Nevertheless',
    'Nonetheless', 'Meanwhile', 'Similarly', 'Likewise', 'Conversely', 'Accordingly',
    'Consequently', 'Hence', 'Instead', 'Finally', 'Firstly', 'Secondly', 'Thirdly',
    'Recently', 'Notably', 'Importantly', 'Crucially', 'Arguably', 'Overall', 'Again',
    'Here', 'There', 'Yet', 'But', 'While', 'Although', 'Though', 'Whereas', 'Because',
    'Since', 'When', 'Where', 'After', 'Before', 'According', 'Compare', 'Following',
}


# Capitalised words that are never a surname: the old local `excluded` set plus the discourse
# markers. A NARRATIVE citation takes its author from the prose in front of it ("Engels (1888,
# 517)") and the author match walks BACKWARDS from the paren, so a sentence-opening marker was read
# as a co-author — "Indeed, Engels (1888, 517)" keyed indeed1888 / engelsindeed1888 and never
# engels1888, so the citation could not resolve even once its entry was keyed (24d86fb9).
_NON_SURNAME_WORDS = ({'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
                      | _DISCOURSE_MARKERS)

# A name-shaped token: capitalised, then lowercase letters (so acronyms and ALL-CAPS headings are
# not names). Used to walk BACKWARDS from a bare-year citation for its antecedent author.
_NAME_TOKEN_RE = re.compile(r"(?<![A-Za-zÀ-ÿßẞ])([A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zà-ÿßẞ'’-]{1,})")


def trailing_author_candidates(text, limit=8, window=600):
    """Surname candidates for a citation whose author is NOT adjacent to the year — nearest first.

    Academic prose routinely separates the two: "Similarly, Lévy anticipated … 'quote' argues the
    philosopher (2002: 33)", or an author that opens the sentence with the quotation in between
    ("Häyhtio and Rinne consider that '…' (2008: 26)"). The key-generation rules can only see the
    text immediately before the paren, so those citations produced no usable key at all (46c0fbb5).
    This is a LAST RESORT for the caller: it returns candidate keys to try against the bibliography,
    and the bibliography is the gate — an invented name resolves to nothing.
    """
    text = (text or '')[-window:]
    out = []
    for m in reversed(list(_NAME_TOKEN_RE.finditer(text))):
        word = m.group(1)
        if word in _NON_SURNAME_WORDS:
            continue
        key = normalize_unicode_name(word.replace("'s", '')).lower()
        if key and key not in out:
            out.append(key)
        if len(out) >= limit:
            break
    return out


# Author separators inside a citation's author phrase. The SLASH is the German-language
# convention and it is everywhere in this corpus ("Schmidt/Bannon (1992)",
# "Fuchs/Hofkirchner/Klauninger (2001)", "Haralambos/Holborn (1991)"); without it the phrase
# collapsed to its LAST word, so the keys missed the first author the entry is keyed on — and the
# antecedent walk-back then resolved the citation to a DIFFERENT work by a middle author (7fa30289).
_AUTHOR_SEP = r"\s+and\s+|\s*&\s*|\s*/\s*|\s*,\s*(?:and\s+)?"
_AUTHOR_ATOM = r"[A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+(?:\s+[A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+){0,2}"
# A trailing author PHRASE: one to three capitalised words per author ("Michael Hardt"), any number
# of authors joined by those separators, anchored at the end of the text before the year.
_AUTHOR_GROUP_RE = re.compile(r"(" + _AUTHOR_ATOM + r"(?:(?:" + _AUTHOR_SEP + r")" + _AUTHOR_ATOM + r")*)\s*$")


def is_plausible_year(token, min_year=MODERN_YEAR_MIN):
    """Is this token plausibly a publication year? Accepts a bare '1886' or a suffixed '1886a'."""
    m = re.match(r'\d{4}', str(token))
    return bool(m) and min_year <= int(m.group()) <= PLAUSIBLE_YEAR_MAX


def generate_ref_keys(text, context_text="", min_year=MODERN_YEAR_MIN):
    # Normalize curly apostrophes to straight for consistent matching
    text = text.replace('’', "'").replace('‘', "'").replace('ʼ', "'")
    context_text = context_text.replace('’', "'").replace('‘', "'").replace('ʼ', "'")
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    # An ACCESS DATE is not a publication year, and it sits at the END of the entry where the
    # last-year rule below looks: "European Commission. 2012. Towards Better Access… (accessed on
    # September 8, 2013)" keyed september2013a — the year from the access clause and a "surname"
    # from the month in front of it — so every "(European Commission 2012)" in the body linked to
    # nothing (ffbb3ac7 mis-keyed its European Commission, Bergstrom 2002 and Thomson Reuters 2008
    # entries this way; any web-cited entry with an access date is exposed).
    processed_text = _ACCESS_CLAUSE_RE.sub(' ', processed_text)
    # Prefer parenthesized year (common in bibliography: "Author (2022). Title...")
    paren_year = re.search(r'\((\d{4}[a-z]?)\)', processed_text)
    if paren_year:
        year_match = paren_year
    else:
        # For entries without parenthesized year, find the LAST plausible year (see
        # MODERN_YEAR_MIN / PLAUSIBLE_YEAR_MAX) to avoid picking up title numbers or arXiv IDs
        # like "2601".
        all_years = list(re.finditer(r'(?<!\d)(\d{4}[a-z]?)(?!\d)', processed_text))
        plausible_years = [m for m in all_years if is_plausible_year(m.group(1))]
        # A historical year is a FALLBACK, never a competitor. Admitting it to the same pool let
        # it WIN the last-year rule over the real one — "(Author 2005: 1850)" would key
        # author1850 — which cost 93d34a74 a link that used to resolve. Only reach below the
        # modern floor when there is no modern year to be found at all.
        if not plausible_years and min_year < MODERN_YEAR_MIN:
            plausible_years = [m for m in all_years if is_plausible_year(m.group(1), min_year)]
        # A BIBLIOGRAPHY ENTRY for a pre-1900 work, keyed POSITIONALLY instead of by the floor.
        # The 1900 floor above means "Marx, Karl. 1875. Critique of the Gotha Programme. In *MECW
        # Volume 24*, 75-76, London: …" yields NO KEYS, so the entry is dropped as unkeyable and
        # every "(Marx 1875)" in the body links to nothing (24d86fb9 dropped four consecutive
        # Marx/Engels entries this way — a systematic hole for any text citing 19th-century
        # originals). Lowering the floor is what the comment above rejects, and rightly: any
        # 4-digit number in a long entry would become a candidate YEAR. Position is the missing
        # evidence — a bibliography entry states its year immediately after the author block, so
        # accept a historical year ONLY there, and only when no modern year exists anywhere (the
        # branch can therefore never move a key that already resolves). "1850s" is a decade, not a
        # year; a trailing 's' is excluded the same way the disambiguation-suffix rule does it.
        if not plausible_years:
            lead = re.match(
                r"^\s*(?:<[^>]+>\s*)*[^\d()\[\]]{3,120}?[.,]\s*\(?"
                # `/` in the lookahead: composition-span years ("1845/46. The German Ideology",
                # "1857/1858. Grundrisse") are the NORMAL citation form for these works, and
                # without it the entry produced no keys at all and was dropped as unkeyable —
                # unreachable by every citation in the corpus.
                r"(1[5-8]\d{2}[a-rt-z]?)\)?(?=[.,)\s/])", processed_text)
            if lead:
                plausible_years = [lead]
        # A LETTER-SUFFIXED year ("2015b") is a disambiguation marker — it IS the publication year a
        # citation references, and in "Author. 2015b. Title … 2015 International Conference…" it sits
        # BEFORE an incidental venue year, so the last-year rule would drop the 'b' (keying the entry
        # sharma2015, unreachable by the "(Sharma et al., 2015b)" citation). Prefer the suffixed one —
        # but NOT a decade ("1990s"): the disambiguation suffix is a/b/c…, never the plural 's'.
        suffixed = [m for m in plausible_years
                    if re.search(r'[a-z]$', m.group(1)) and not m.group(1).endswith('s')]
        year_match = suffixed[0] if suffixed else (plausible_years[-1] if plausible_years else None)
    if not year_match: return []
    year = year_match.group(1)
    authors_part = text.split(year)[0]
    # For bare-year entries (no parens), the year is near the end so authors_part
    # includes the title. Limit to the initial author block (before first ". " + uppercase).
    # Use lookbehind to avoid matching single-letter initials like "G. Otis" or "D. Lawrence".
    if not paren_year and '. ' in authors_part:
        author_block_end = re.search(r'(?<=[a-z]{2})\.\s+[A-Z]', authors_part)
        if author_block_end:
            authors_part = authors_part[:author_block_end.start()]
    # ORDERED-unique, not a set: keys[0] is used downstream as the reference's canonical id
    # (bibliography.py: base_entry_id = keys[0]). A set's arbitrary iteration order let the ugly
    # all-authors-concatenated key win the id for multi-author entries
    # ("albathanalbishreeffectivekhaledlimubarakyuefeng2015"). We add the clean first-author key
    # FIRST so it is always keys[0]; the concatenated/group variants stay in the list as MATCH keys
    # (bibliography_map) so a citation that spells out every author still resolves.
    keys = []
    def _add(k):
        if k not in keys:
            keys.append(k)
    # Check for any letter (including Unicode) in authors_part
    has_author = re.search(r'[a-zA-ZÀ-ÿßẞ]', authors_part)
    author_source = authors_part if has_author else context_text

    if author_source:
        if not has_author:
            # Try to extract full author group at end of context: "Name", "Name and Name", "Name, Name, and Name"
            # Each author is up to THREE capitalised words, not one: a narrative citation routinely
            # spells names out in full ("Michael Hardt and Antonio Negri (2017)"), and a single-word
            # atom could only match the suffix "Negri" — so the keys were negri2017 while the entry
            # is keyed on the FIRST author, hardt2017, and the citation could never resolve
            # (a7fc96d5). Over-capture is harmless: each group's SURNAME is its last word.
            group_match = re.search(_AUTHOR_GROUP_RE, author_source)
            if group_match:
                author_source = group_match.group(1)
            else:
                # Fallback: last capitalized word
                candidates = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
                if candidates: author_source = candidates[-1]

        # Match capitalized words including Unicode letters and hyphens
        # This pattern matches: Capital letter (including accented) followed by letters/hyphens/apostrophes
        surnames = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
        excluded = _NON_SURNAME_WORDS
        # Normalize Unicode and remove apostrophe-s for key generation
        surnames = [normalize_unicode_name(s.replace("'s", "")).lower() for s in surnames if s not in excluded and len(s) > 1]
        if surnames:
            # Last-word-of-each-author-group as surnames (handles "FirstName LastName and
            # FirstName LastName" bibliography patterns).
            groups = re.split(r'\s+and\s+|\s*&\s*|\s*/\s*|,\s*and\s+|,\s+(?=[A-Z])', author_source)
            group_surnames = []
            for group in groups:
                words = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", group)
                words = [w for w in words if w not in excluded and len(w) > 1]
                if words:
                    group_surnames.append(normalize_unicode_name(words[-1].replace("'s", "")).lower())
            # Canonical id (keys[0]) = the FIRST AUTHOR'S SURNAME. "Surname, Initials…" → the surname
            # is the first token (surnames[0]); "First Last" (no leading comma) → it's the LAST token
            # of the first author group (group_surnames[0]). Without this the id keys on a given name
            # ("leo2001" for "Leo Breiman"). All other forms below stay as MATCH keys.
            comma_first = bool(re.match(r"^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+\s*,", author_source))
            primary = surnames[0] if (comma_first or not group_surnames) else group_surnames[0]
            _add(primary + year)
            _add(surnames[0] + year)
            _add("".join(sorted(surnames)) + year)
            if group_surnames and set(group_surnames) != set(surnames):
                _add(group_surnames[0] + year)
                _add("".join(sorted(group_surnames)) + year)
        else:
            # Lowercase-branded author ("ephemera collective. 2021…") — no capitalised token to
            # key on, so both the entry and its "(ephemera collective 2021)" citation produced
            # ZERO keys and could never meet. Key on the first lowercase word instead; the same
            # fallback runs on both sides, so they generate the same key. Gated to a NAME-shaped
            # author_source (<= 4 word tokens): a prose sentence that merely contains a year used
            # to die here as unkeyable, and rescuing it would mint junk entries ("A journal's
            # publication history…" keyed journal1997 — 93d34a74 grew 2 phantom references).
            words = re.findall(r"(?<![\w'’-])[\wà-ÿÀ-ÿ][\w'’-]*", author_source)
            words = [w for w in words if not w.isdigit()]
            if len(words) <= 4:
                lower_words = [normalize_unicode_name(w).lower()
                               for w in words
                               if len(w) > 2 and w.lower() not in
                               {'and', 'the', 'for', 'in', 'an', 'on', 'as',
                                'ed', 'of', 'see', 'also', 'et', 'al'}]
                if lower_words:
                    _add(lower_words[0] + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source)
    for acronym in acronyms: _add(acronym.lower() + year)
    if "United Nations General Assembly" in text: _add("un" + year)
    # A SLASH-PAIR year ("1845/46", "1845/1846", "1857/1858") names ONE work written across two
    # years, and citations use EITHER year ("Marx and Engels 1845/1846" but also a bare "(1845)").
    # Whichever year the rules above chose, add every key's other-year variant as a MATCH key, so
    # both citation forms reach the same entry. keys[0] (the canonical id) is untouched.
    _pair = re.search(r'(?<!\d)(1[5-9]\d\d|20\d\d)\s*/\s*(\d{2}|\d{4})(?!\d)', processed_text)
    if _pair and keys:
        _y1 = _pair.group(1)
        _y2 = _pair.group(2) if len(_pair.group(2)) == 4 else _pair.group(1)[:2] + _pair.group(2)
        _bare_year = re.match(r'\d{4}', year).group(0)
        _alt = _y2 if _bare_year == _y1 else (_y1 if _bare_year == _y2 else None)
        if _alt and _alt != _bare_year:
            for k in list(keys):
                if k.endswith(year):
                    _add(k[: -len(year)] + _alt + year[4:])

    return keys


# Journal article back-matter: the copyright statement, ORCID line, "to cite this article"
# self-citation and publisher imprint that sit AFTER the references on the last page. Every
# one of them starts with a capital and carries a 4-digit year, which is all rule #5 below
# asks for, so they read as bibliography entries — and the heading-anchored collector in
# bibliography.py walks to the end of the document whenever the section under "References"
# holds nothing it recognises (fixture 42be715c: its references are footnote-shaped, so the
# collector found zero entries there and swept up these four instead, inventing 4 references
# and 18 citations in a document that has none). They are chrome wherever they appear —
# including under a real References heading — so the rejection belongs here, at the one gate
# every collection path goes through, rather than in any single caller's walk.
_ARTICLE_CHROME_RE = re.compile(
    r'^\s*(?:'
    r'article\s+copyright\b'
    r'|copyright\s*[:©]'
    r'|©\s*\d{4}'
    r'|orcid(?:\s+id)?\s*[:.]'
    r'|(?:how\s+)?to\s+cite\s+this\s+(?:article|paper|work)\b'
    r'|cite\s+this\s+(?:article|paper|work)\s+as\b'
    r'|published\s+by\s+.{0,80}?\bon\s+\d{1,2}\s+\w+\s+\d{4}\s*$'
    # Publication-history line: "Submitted on 5 November 2018 Revised on … Published on …".
    # Anchored on the leading verb AND a following date so a genuine entry that merely opens
    # with one of these words cannot match.
    r'|(?:submitted|received|revised|accepted)\s+on\s+\d{1,2}\s+\w+\s+\d{4}\b'
    r'|competing\s+interests?\s*[:.]'
    r'|conflicts?\s+of\s+interest\s*[:.]'
    r'|correspondence\s*[:.]'
    r'|e-?mail\s*[:.]'
    r'|received\s*[:.].{0,60}accepted\s*[:.]'
    r'|this\s+is\s+an\s+open[- ]access\s+article\b'
    r')',
    re.IGNORECASE,
)


def is_article_chrome(text):
    """True when a paragraph is journal front/back-matter, never a bibliography entry."""
    return bool(_ARTICLE_CHROME_RE.match(text or ''))


# The self-citation an article prints for itself ("Lawson, S, Access, ethics and piracy,
# Insights, 2017, 30(1), 25-30; DOI: …") is shaped EXACTLY like a bibliography entry, because
# it is one — of this very work. Nothing in the line itself distinguishes it; the only signal
# is the label paragraph above it, so this is a look-behind rather than a pattern.
_CITE_LABEL_RE = re.compile(r'^\s*(?:how\s+)?to\s+cite\s+this\s+(?:article|paper|work)\b',
                            re.IGNORECASE)


def _follows_cite_label(p_tag):
    """True when the previous paragraph is a 'To cite this article:' label."""
    previous = p_tag.find_previous_sibling() if hasattr(p_tag, 'find_previous_sibling') else None
    hops = 0
    while previous is not None and hops < 2:
        if getattr(previous, 'name', None) == 'p':
            return bool(_CITE_LABEL_RE.match(previous.get_text(" ", strip=True)))
        previous = previous.find_previous_sibling()
        hops += 1
    return False


def is_likely_reference(p_tag):
    """
    Detect if a paragraph looks like a bibliography reference entry.
    Handles multiple formats:
    - Standard: "Author, A. (2023). Title..."
    - Numbered: "[1] Author, A. (2023). Title..."
    - Bracketed year: "[2023] Author. Title..."
    - Noble particles: "von Name, A. (2023). Title..."
    """
    if not p_tag: return False
    text = p_tag.get_text(" ", strip=True)

    # Must contain a 4-digit year
    if not re.search(r'\d{4}', text):
        return False

    # Article chrome (copyright / ORCID / self-citation / imprint) is never an entry.
    if is_article_chrome(text) or _follows_cite_label(p_tag):
        return False

    # Check various reference formats:
    # 1. Numbered format: [1] Author... (year)
    if re.match(r'^\s*\[\d+\]', text):
        return True

    # 1b. Ordinal-numbered format: "1. Caso, R. (2019)…" / "12) Author…" — an ORDERED
    # bibliography whose entries are author-date (5f52d575: every entry rejected, so its 8
    # author-date citations had nothing to link against). The remainder after the enumerator
    # must itself be reference-shaped (author-comma, or capitalised author with a year near the
    # start) — a numbered prose list item ("3. In 2019 we surveyed…") fails both and stays out.
    m = re.match(r'^\s*\d{1,4}[.)]\s+(.+)$', text, re.DOTALL)
    if m:
        rest = m.group(1)
        if (re.match(r"^[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+,\s", rest)
                or re.match(r"^[A-ZÀ-ÖØ-Þ].{0,60}?\(\d{4}[a-z]?\)", rest, re.DOTALL)
                # Vancouver format: "Adger W, Barnett J, Brown K: Title. Nat Clim Change 2013,
                # 3:112-117" — surname + dotless initials, colon before the title (6c4e7d58:
                # all 53 entries rejected, so its [N,M] citations had nothing to link against).
                or (re.match(r"^[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+\s+[A-Z]{1,3}[,:]", rest)
                    and ':' in rest[:120])
                # lowercase-branded author: "ephemera collective. 2021. Title…"
                or re.match(r"^[a-zà-ÿ][\w'’-]*(?:\s+[\w'’-]+){0,3}[.,]\s+\(?(?:19|20)\d{2}[a-z]?\)?[.,]", rest)):
            return True

    # 2. Bracketed year format: [2023] Author...
    if re.match(r'^\s*\[\d{4}\]', text):
        return True

    # 3. Noble particle format: starts with common particles like "von", "van", "de", "du", "da", "del", "della"
    # followed by a capitalized surname
    if re.match(r'^\s*(von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ]', text, re.IGNORECASE):
        return True

    # 4. Em-dash repeat-author format: —. Year. Title...
    if re.match(r'^\s*[—–‒―⸺⸻—–-]{1,3}[\.\,\s]', text):
        return True

    # 5. Standard author-first format: starts with capital letter (including Unicode like Ö, É, etc.)
    # Use Unicode property \p{Lu} for uppercase letters, or check first non-space char
    first_char = text.lstrip()[:1] if text.strip() else ''
    if first_char and first_char.isupper():
        return True

    return False
