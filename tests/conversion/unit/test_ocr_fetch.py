"""Unit tests for ocrFetch.fetch_ocr delivery paths — Layer 1 of "make PDF import
survive a Mistral OCR hiccup".

The bug: Mistral's files.upload returns before the file is queryable, so the very next
get_signed_url can 404 ("No file matches the given query"). Two fixes are pinned here:

  - SMALL PDFs (<= INLINE_MAX_BYTES) skip upload+signed-url entirely and go inline as a
    base64 data-URL — there is no stored file to become queryable, so the 404 is impossible.
  - LARGE PDFs must upload; on a persistent 404 we RE-UPLOAD from scratch (fresh id
    propagates cleanly) rather than re-polling the same dead id forever.

The Mistral client is faked — no network, no real OCR.
"""

from types import SimpleNamespace

from ingestion.pdf import ocrFetch


class _FakeError(Exception):
    pass


class _FakeClient:
    """Records upload / signed-url / ocr.process calls and can simulate a persistent
    404 until a *second* upload has happened."""

    def __init__(self):
        self.upload_count = 0
        self.signed_url_calls = 0
        self.ocr_calls = []
        client = self

        self.files = SimpleNamespace(
            upload=self._upload,
            get_signed_url=self._get_signed_url,
        )
        self.ocr = SimpleNamespace(process=self._process)
        self._client = client

    def _upload(self, file, purpose):
        self.upload_count += 1
        return SimpleNamespace(id=f"file-{self.upload_count}")

    def _get_signed_url(self, file_id, expiry):
        self.signed_url_calls += 1
        # 404 until a re-upload has happened (upload #2).
        if self.upload_count < 2:
            raise _FakeError(
                'API error occurred: Status 404. Body: {"detail": "No file matches the given query."}'
            )
        return SimpleNamespace(url="https://signed.example/doc.pdf")

    def _process(self, document, model, include_image_base64, extract_header, extract_footer):
        self.ocr_calls.append(document)
        return SimpleNamespace(model_dump_json=lambda: '{"pages": []}')


def _install_fake(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(ocrFetch, "Mistral", lambda api_key=None: fake)
    # Kill the real exponential backoff sleeps so the retry path runs instantly.
    monkeypatch.setattr(ocrFetch.time, "sleep", lambda *a, **k: None)
    return fake


def test_small_pdf_goes_inline_without_uploading(tmp_path, monkeypatch):
    fake = _install_fake(monkeypatch)
    pdf = tmp_path / "small.pdf"
    pdf.write_bytes(b"%PDF-1.4\n" + b"0" * 4096)  # ~4KB, well under the 8MB threshold

    result = ocrFetch.fetch_ocr(pdf, "key")

    # Inline path: no upload, no signed-url lookup — the whole 404-prone dance is skipped.
    assert fake.upload_count == 0
    assert fake.signed_url_calls == 0
    # OCR was still run, on an inline base64 data-URL.
    assert len(fake.ocr_calls) == 1
    assert fake.ocr_calls[0]["type"] == "document_url"
    assert fake.ocr_calls[0]["document_url"].startswith("data:application/pdf;base64,")
    assert result == {"pages": []}


def test_large_pdf_reuploads_on_persistent_404(tmp_path, monkeypatch):
    fake = _install_fake(monkeypatch)
    pdf = tmp_path / "big.pdf"
    pdf.write_bytes(b"%PDF-1.4\n" + b"0" * (ocrFetch.INLINE_MAX_BYTES + 4096))  # just over threshold

    result = ocrFetch.fetch_ocr(pdf, "key")

    # First upload's signed-url stayed 404 through its retries → a SECOND upload happened.
    assert fake.upload_count == 2
    # OCR ran once, on the signed URL from the successful (second) upload.
    assert len(fake.ocr_calls) == 1
    assert fake.ocr_calls[0]["document_url"] == "https://signed.example/doc.pdf"
    assert result == {"pages": []}


def test_large_pdf_happy_path_uploads_once(tmp_path, monkeypatch):
    # A client that never 404s → a single upload, no re-upload.
    fake = _FakeClient()
    fake.upload_count = 0
    monkeypatch.setattr(ocrFetch, "Mistral", lambda api_key=None: fake)
    # Make get_signed_url succeed immediately by pretending the file is already queryable.
    monkeypatch.setattr(
        fake.files, "get_signed_url",
        lambda file_id, expiry: SimpleNamespace(url="https://signed.example/ok.pdf"),
    )
    pdf = tmp_path / "big.pdf"
    pdf.write_bytes(b"%PDF-1.4\n" + b"0" * (ocrFetch.INLINE_MAX_BYTES + 4096))

    result = ocrFetch.fetch_ocr(pdf, "key")

    assert fake.upload_count == 1
    assert fake.ocr_calls[0]["document_url"] == "https://signed.example/ok.pdf"
    assert result == {"pages": []}
