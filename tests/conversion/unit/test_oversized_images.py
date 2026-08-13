"""Guardrail: oversized image XObjects are normalised before the PDF reaches Mistral OCR.

Book a22004 (a 2004 Distiller/PageMaker journal PDF) failed all three import attempts on a
Mistral 400 — {"message": "Document is not a valid PDF.", "code": "3740"} — while pypdf read
every page of it perfectly. The cause was four CCITT stencil masks of 131-257 megapixels
(~1200dpi figure scans) buried two Form XObjects deep. Bisection proved it: drop the giant
image's draw op and the same page OCRs fine; drop the ordinary photo beside it instead and
the 400 persists. Downsampling those four made the full 10-page document OCR successfully.

These tests lock the four things that make the fix safe rather than merely effective:
  - it is a NO-OP on a PDF without oversized images (this is the one protecting every book
    that already converts — the pass must not become a blanket rewrite of every upload),
  - it finds images nested inside Form XObjects (a page-level scan misses the real bug),
  - a stencil mask comes back OUT as a stencil mask (an opaque replacement would paint a
    white box over whatever sits beneath it), and
  - an image too big to decode safely is blanked, never decoded, so a 2GB production box
    degrades to a missing figure instead of an OOM-killed import.
"""

import zlib

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)

from ingestion.pdf import ocrFetch


def _image_xobject(writer, width, height, mask=True):
    """Build a real, decodable Flate image XObject of the requested size."""
    pil = Image.new("1", (width, height), 1)
    # A block of ink in one corner so polarity is measurable after the round-trip.
    for y in range(height // 4):
        for x in range(width // 4):
            pil.putpixel((x, y), 0)

    stream = DecodedStreamObject()
    stream.set_data(pil.tobytes())
    stream[NameObject("/Type")] = NameObject("/XObject")
    stream[NameObject("/Subtype")] = NameObject("/Image")
    stream[NameObject("/Width")] = NumberObject(width)
    stream[NameObject("/Height")] = NumberObject(height)
    stream[NameObject("/BitsPerComponent")] = NumberObject(1)
    if mask:
        stream[NameObject("/ImageMask")] = BooleanObject(True)
    else:
        stream[NameObject("/ColorSpace")] = NameObject("/DeviceGray")
    return writer._add_object(stream)


def _form_xobject(writer, inner_name, inner_ref):
    """Wrap an XObject in a Form XObject that draws it — the a22004 nesting shape."""
    form = DecodedStreamObject()
    form.set_data(f"q 100 0 0 100 0 0 cm {inner_name} Do Q".encode())
    form[NameObject("/Type")] = NameObject("/XObject")
    form[NameObject("/Subtype")] = NameObject("/Form")
    form[NameObject("/BBox")] = ArrayObject(
        [NumberObject(0), NumberObject(0), NumberObject(100), NumberObject(100)]
    )
    resources = DictionaryObject()
    xobjects = DictionaryObject()
    xobjects[NameObject(inner_name)] = inner_ref
    resources[NameObject("/XObject")] = xobjects
    form[NameObject("/Resources")] = resources
    return writer._add_object(form)


def _make_pdf(path, images=(), nest_depth=0):
    """Write a one-page PDF embedding `images` as [(width, height, is_mask)] tuples.

    `nest_depth` wraps each image in that many Form XObjects, reproducing the structure
    that hid the real offenders (page -> /Fm8 -> /Fm7 -> /Im4).
    """
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)

    xobjects = DictionaryObject()
    for index, (width, height, is_mask) in enumerate(images):
        name = f"/Im{index}"
        ref = _image_xobject(writer, width, height, mask=is_mask)
        for level in range(nest_depth):
            ref = _form_xobject(writer, name, ref)
            name = f"/Fm{index}_{level}"
        xobjects[NameObject(name)] = ref

    resources = page.get("/Resources")
    if resources is None:
        resources = DictionaryObject()
        page[NameObject("/Resources")] = resources
    resources.get_object()[NameObject("/XObject")] = xobjects

    with open(path, "wb") as f:
        writer.write(f)
    return path


@pytest.fixture
def small_limits(monkeypatch):
    """Shrink the thresholds so the fixtures stay small but the real code path runs."""
    monkeypatch.setattr(ocrFetch, "MAX_IMAGE_PIXELS", 1_000_000)
    monkeypatch.setattr(ocrFetch, "NORMALIZED_IMAGE_MAX_DIM", 400)


def _find_images(pdf_path):
    reader = PdfReader(str(pdf_path))
    seen, found = set(), []
    for page in reader.pages:
        ocrFetch._iter_image_xobjects(page, seen, found)
    return found


def test_noop_when_nothing_is_oversized(tmp_path, small_limits):
    """A PDF with only reasonable images is returned untouched and nothing is written.

    THE regression that matters: this pass runs ahead of every PDF import, so any book
    without the problem must convert on byte-identical input to what it always got.
    """
    src = _make_pdf(tmp_path / "ok.pdf", images=[(200, 200, True)])
    before = src.read_bytes()

    result, report = ocrFetch.normalize_oversized_images(src, tmp_path)

    assert result == src
    assert src.read_bytes() == before
    assert report == {"oversized": [], "downsampled": [], "blanked": []}
    assert not (tmp_path / "normalized.pdf").exists()


def test_oversized_image_is_downsampled(tmp_path, small_limits):
    src = _make_pdf(tmp_path / "big.pdf", images=[(1500, 1500, True)])

    result, report = ocrFetch.normalize_oversized_images(src, tmp_path)

    assert result != src
    assert result.name == "normalized.pdf"
    assert len(report["downsampled"]) == 1
    assert report["blanked"] == []

    width, height = report["downsampled"][0]["new_width"], report["downsampled"][0]["new_height"]
    assert max(width, height) <= 400

    # The rewritten file must still be a readable PDF with the page intact.
    reader = PdfReader(str(result))
    assert len(reader.pages) == 1
    images = _find_images(result)
    assert len(images) == 1
    assert int(images[0][1]["/Width"]) <= 400


def test_original_is_never_modified(tmp_path, small_limits):
    """The upload stays the user's source of truth; downstream pypdf recovery re-reads it."""
    src = _make_pdf(tmp_path / "big.pdf", images=[(1500, 1500, True)])
    before = src.read_bytes()

    ocrFetch.normalize_oversized_images(src, tmp_path)

    assert src.read_bytes() == before


def test_images_nested_in_form_xobjects_are_found(tmp_path, small_limits):
    """The real offenders sat two Form XObjects deep — a page-level scan finds nothing."""
    src = _make_pdf(tmp_path / "nested.pdf", images=[(1500, 1500, True)], nest_depth=2)

    result, report = ocrFetch.normalize_oversized_images(src, tmp_path)

    assert len(report["downsampled"]) == 1, "nested oversized image was not reached"
    assert result != src


def test_stencil_mask_stays_a_stencil_mask(tmp_path, small_limits):
    """An /ImageMask must not come back as an opaque greyscale image.

    A mask paints the fill colour where the sample is 0 and leaves the rest alone; an
    opaque replacement paints a box over whatever is underneath. Polarity has to survive
    too, or the figure comes back inverted.
    """
    src = _make_pdf(tmp_path / "mask.pdf", images=[(1500, 1500, True)])

    result, _report = ocrFetch.normalize_oversized_images(src, tmp_path)

    _name, obj = _find_images(result)[0]
    assert ocrFetch._pdf_bool(obj.get("/ImageMask")) is True
    assert int(obj["/BitsPerComponent"]) == 1
    assert "/ColorSpace" not in obj
    assert "/DecodeParms" not in obj

    # The fixture inks the top-left quarter (1/16th of the area). Nearest-neighbour
    # downsampling moves that a little, never inverts it.
    decoded = obj.decode_as_image().convert("L")
    ink = decoded.histogram()[0] / (decoded.size[0] * decoded.size[1])
    assert 0.03 < ink < 0.12, f"ink fraction {ink:.3f} — mask polarity flipped"


def test_over_budget_image_is_blanked_not_decoded(tmp_path, small_limits, monkeypatch):
    """Too big to decode safely -> 1x1 blank, so a tight box loses a figure, not the book."""
    monkeypatch.setattr(ocrFetch, "_decode_budget_pixels", lambda: 0)

    def _explode(*_args, **_kwargs):
        raise AssertionError("decoded an image that was over the memory budget")

    monkeypatch.setattr(ocrFetch, "_shrink_image_xobject", _explode)

    src = _make_pdf(tmp_path / "huge.pdf", images=[(1500, 1500, True)])
    result, report = ocrFetch.normalize_oversized_images(src, tmp_path)

    assert report["downsampled"] == []
    assert len(report["blanked"]) == 1
    assert report["blanked"][0]["reason"] == "decode_budget"

    _name, obj = _find_images(result)[0]
    assert int(obj["/Width"]) == 1 and int(obj["/Height"]) == 1
    assert ocrFetch._pdf_bool(obj.get("/ImageMask")) is True


def test_undecodable_image_falls_back_to_blank(tmp_path, small_limits):
    """A decoder failure must not abort the import — blank that image and carry on."""
    src = _make_pdf(tmp_path / "broken.pdf", images=[(1500, 1500, True)])

    # Corrupt the image stream so decode_as_image() throws, leaving the dict intact.
    writer = PdfWriter(clone_from=str(src))
    for _name, obj, _w, _h in ocrFetch.find_oversized_images(writer.pages, limit=1_000_000):
        obj[NameObject("/Filter")] = NameObject("/FlateDecode")
        obj._data = zlib.compress(b"not an image", 6)
    broken = tmp_path / "broken2.pdf"
    with open(broken, "wb") as f:
        writer.write(f)

    result, report = ocrFetch.normalize_oversized_images(broken, tmp_path)

    assert len(report["blanked"]) == 1
    assert PdfReader(str(result)).pages, "normalised PDF is unreadable"


def test_decode_budget_never_exceeds_the_static_ceiling():
    assert ocrFetch._decode_budget_pixels() <= ocrFetch.MAX_DECODE_PIXELS
