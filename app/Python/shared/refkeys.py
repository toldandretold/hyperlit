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


def generate_ref_keys(text, context_text=""):
    # Normalize curly apostrophes to straight for consistent matching
    text = text.replace('’', "'").replace('‘', "'").replace('ʼ', "'")
    context_text = context_text.replace('’', "'").replace('‘', "'").replace('ʼ', "'")
    processed_text = re.sub(r'\[\d{4}\]\s*', '', text)
    # Prefer parenthesized year (common in bibliography: "Author (2022). Title...")
    paren_year = re.search(r'\((\d{4}[a-z]?)\)', processed_text)
    if paren_year:
        year_match = paren_year
    else:
        # For entries without parenthesized year, find the LAST plausible year (1900-2099)
        # to avoid picking up title numbers like "Scopus 1900–2020" or arXiv IDs like "2601"
        plausible_years = list(re.finditer(r'(?<!\d)(\d{4}[a-z]?)(?!\d)', processed_text))
        plausible_years = [m for m in plausible_years if 1900 <= int(re.match(r'\d{4}', m.group(1)).group()) <= 2099]
        year_match = plausible_years[-1] if plausible_years else None
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
    keys = set()
    # Check for any letter (including Unicode) in authors_part
    has_author = re.search(r'[a-zA-ZÀ-ÿßẞ]', authors_part)
    author_source = authors_part if has_author else context_text

    if author_source:
        if not has_author:
            # Try to extract full author group at end of context: "Name", "Name and Name", "Name, Name, and Name"
            group_match = re.search(
                r"([A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+(?:(?:\s+and\s+|\s*,\s*(?:and\s+)?)[A-ZÀ-ÖØ-ÞẞĀ-Ž][a-zA-ZÀ-ÿßẞ'-]+)*)\s*$",
                author_source
            )
            if group_match:
                author_source = group_match.group(1)
            else:
                # Fallback: last capitalized word
                candidates = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
                if candidates: author_source = candidates[-1]

        # Match capitalized words including Unicode letters and hyphens
        # This pattern matches: Capital letter (including accented) followed by letters/hyphens/apostrophes
        surnames = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", author_source)
        excluded = {'And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'}
        # Normalize Unicode and remove apostrophe-s for key generation
        surnames = [normalize_unicode_name(s.replace("'s", "")).lower() for s in surnames if s not in excluded and len(s) > 1]
        if surnames:
            keys.add(surnames[0] + year)
            surnames.sort()
            keys.add("".join(surnames) + year)
            # Also generate keys using last-word-of-each-author-group as surnames
            # (handles "FirstName LastName and FirstName LastName" bibliography patterns)
            groups = re.split(r'\s+and\s+|,\s*and\s+|,\s+(?=[A-Z])', author_source)
            group_surnames = []
            for group in groups:
                words = re.findall(r"(?<![a-zA-ZÀ-ÿßẞ])[A-ZÀ-ÖØ-ÞẞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮİĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽ][a-zA-ZÀ-ÿßẞ'-]*", group)
                words = [w for w in words if w not in excluded and len(w) > 1]
                if words:
                    group_surnames.append(normalize_unicode_name(words[-1].replace("'s", "")).lower())
            if group_surnames and set(group_surnames) != set(surnames):
                keys.add(group_surnames[0] + year)
                group_surnames.sort()
                keys.add("".join(group_surnames) + year)

    acronyms = re.findall(r'\b[A-Z]{2,}\b', author_source)
    for acronym in acronyms: keys.add(acronym.lower() + year)
    if "United Nations General Assembly" in text: keys.add("un" + year)
    return list(keys)


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

    # Check various reference formats:
    # 1. Numbered format: [1] Author... (year)
    if re.match(r'^\s*\[\d+\]', text):
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
