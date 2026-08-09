"""GROBID client for bibliography extraction — the ML-backed alternative to the regex reference
scan. GROBID (grobid.readthedocs.io) segments a PDF's reference list with a CRF model trained on
scholarly corpora, which handles the failure mode regex fundamentally cannot: RUN-ON entries with
no terminal period ("…doi: 10.1038/sj.ki.5002094 Archambault, E., …" — book 93d34a74, where the
whole blob keyed to its first author and every later entry was uncitable).

OPT-IN: only used when the GROBID_URL env var is set AND the book has its source PDF on disk AND
the server answers /api/isalive — anything else falls back to the regex path, so conversion never
gains a hard dependency on the service. Stdlib-only (urllib + xml.etree); requests are CHUNKED by
page-window (pypdf) so a memory-capped GROBID (~1GB droplet container) never sees a 300-page PDF
in one bite.
"""

import io
import os
import re
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET

_TEI_NS = {'t': 'http://www.tei-c.org/ns/1.0'}

# NON-BLOCKING BUDGET: conversion must never stall a queue worker on a slow/hung GROBID. Per-request
# timeout + an overall wall-clock deadline for the whole document; breaching either raises, and the
# caller falls back to the regex path. Native GROBID does a 40-page window in seconds, so these are
# generous — tune via env if a huge corpus book genuinely needs more.
_REQUEST_TIMEOUT_S = int(os.environ.get('GROBID_REQUEST_TIMEOUT', '120'))
_TOTAL_DEADLINE_S = int(os.environ.get('GROBID_TOTAL_DEADLINE', '300'))


def grobid_alive(base_url, timeout=5):
    """True if a GROBID server answers at base_url."""
    try:
        with urllib.request.urlopen(f'{base_url.rstrip("/")}/api/isalive', timeout=timeout) as r:
            return b'true' in r.read().lower()
    except Exception:
        return False


def _post_pdf(base_url, pdf_bytes, timeout=_REQUEST_TIMEOUT_S):
    """POST pdf bytes to /api/processReferences (includeRawCitations) → TEI XML string."""
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    body.write(f'--{boundary}\r\n'
               f'Content-Disposition: form-data; name="input"; filename="doc.pdf"\r\n'
               f'Content-Type: application/pdf\r\n\r\n'.encode())
    body.write(pdf_bytes)
    body.write(f'\r\n--{boundary}\r\n'
               f'Content-Disposition: form-data; name="includeRawCitations"\r\n\r\n1\r\n'
               f'--{boundary}--\r\n'.encode())
    req = urllib.request.Request(
        f'{base_url.rstrip("/")}/api/processReferences',
        data=body.getvalue(),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}',
                 'Accept': 'application/xml'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def _parse_tei_references(xml_text):
    """TEI XML → [{'raw', 'first_author', 'year', 'title', 'doi'}] (raw may be None).
    GROBID answers 204/empty for a PDF (or page window) with NO references — that's a valid
    zero-refs result, not an error (an empty window must not abort a chunked whole-document run)."""
    if not (xml_text or '').strip():
        return []
    refs = []
    root = ET.fromstring(xml_text)
    for bibl in root.iter('{http://www.tei-c.org/ns/1.0}biblStruct'):
        surnames = [s.text for s in bibl.iter('{http://www.tei-c.org/ns/1.0}surname') if s.text]
        date = bibl.find('.//t:date[@type="published"]', _TEI_NS)
        year = ''
        if date is not None:
            year = (date.get('when') or (date.text or ''))[:4]
        title_el = bibl.find('.//t:title[@level="a"]', _TEI_NS)
        if title_el is None:
            title_el = bibl.find('.//t:title', _TEI_NS)
        doi_el = bibl.find('.//t:idno[@type="DOI"]', _TEI_NS)
        raw_el = bibl.find('.//t:note[@type="raw_reference"]', _TEI_NS)
        refs.append({
            'raw': raw_el.text if raw_el is not None and raw_el.text else None,
            'first_author': surnames[0] if surnames else '',
            'year': year if re.fullmatch(r'\d{4}', year or '') else '',
            'title': (title_el.text or '') if title_el is not None else '',
            'doi': (doi_el.text or '') if doi_el is not None else '',
        })
    return refs


def _pdf_page_windows(pdf_path, max_pages):
    """Yield pdf-bytes windows of at most max_pages pages (whole file if small enough)."""
    from pypdf import PdfReader, PdfWriter   # already a pipeline dependency (OCR chunking)
    reader = PdfReader(pdf_path)
    n = len(reader.pages)
    if n <= max_pages:
        yield open(pdf_path, 'rb').read()
        return
    for start in range(0, n, max_pages):
        writer = PdfWriter()
        for i in range(start, min(start + max_pages, n)):
            writer.add_page(reader.pages[i])
        buf = io.BytesIO()
        writer.write(buf)
        yield buf.getvalue()


def extract_refs_from_pdf(pdf_path, base_url, max_pages_per_request=40):
    """Segment + parse the PDF's references via GROBID. Returns a list of parsed refs (possibly
    empty); raises on transport errors — the CALLER decides fallback. Page-window chunking keeps
    per-request memory bounded; references living wholly inside a window survive, a rare entry
    STRADDLING a window boundary may be lost or duplicated (documents cite per-chapter, so windows
    of 40 pages make that unlikely). De-dupes identical (first_author, year, title-prefix) repeats."""
    seen = set()
    out = []
    deadline = time.monotonic() + _TOTAL_DEADLINE_S
    for pdf_bytes in _pdf_page_windows(pdf_path, max_pages_per_request):
        if time.monotonic() > deadline:
            raise TimeoutError(f'GROBID total deadline ({_TOTAL_DEADLINE_S}s) exceeded')
        tei = _post_pdf(base_url, pdf_bytes)
        for ref in _parse_tei_references(tei):
            key = (ref['first_author'].lower(), ref['year'],
                   re.sub(r'[^a-z0-9]', '', ref['title'].lower())[:40])
            if key in seen:
                continue
            seen.add(key)
            out.append(ref)
    return out
