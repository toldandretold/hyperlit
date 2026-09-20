<?php

/**
 * Citation sources that ARE PDFs.
 *
 * Citation resolution used to discard these outright — `application/pdf` meant
 * "not readable" — so a reference pointing straight at a report, the commonest
 * shape for NGO, government and UN sources, resolved as "source not found"
 * while the document sat there downloadable.
 *
 * A cited PDF now goes down the SAME lane as every other source: staged to
 * `resources/markdown/{bookId}/original.pdf` with `pdf_url_status =
 * 'downloaded'` and `has_nodes = false`, which is exactly what `citation:ocr`
 * (step 3 of `citation:pipeline`) selects on. It then converts properly —
 * footnotes, headings — and bills per page like everything else.
 *
 * The first version of this read the text layer in-process and wrote the
 * characters into a stub. Free and instant, but PLAIN TEXT: no structure, and
 * invisible to the OCR step on all three of its conditions. These tests exist
 * mostly to stop that shortcut coming back.
 */

use App\Services\WebContent\PdfSourceReader;
use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebFetchService;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    // Http::fake cannot reach into the browser subprocess.
    config()->set('services.source_fetch.browser', false);
});

function pdfFixture(string $name): string
{
    return file_get_contents(base_path("tests/webcontent/fixtures/{$name}"));
}

test('a PDF URL is recognised before any fetch happens', function () {
    // Shape check, so the reader is chosen without spending a request.
    expect(PdfSourceReader::looksLikePdf('https://pucl.org/wp-content/uploads/2023/05/PUCL-28.09.2022.pdf'))->toBeTrue()
        // Repository landings advertise the rendition in the query string —
        // this exact URL is a chacko citation.
        ->and(PdfSourceReader::looksLikePdf('https://digitallibrary.un.org/record/4015916?v=pdf'))->toBeTrue()
        ->and(PdfSourceReader::looksLikePdf('https://example.com/article?format=pdf'))->toBeTrue()
        ->and(PdfSourceReader::looksLikePdf('https://scroll.in/latest/1050748/'))->toBeFalse()
        // "pdf" appearing in a slug is not a PDF.
        ->and(PdfSourceReader::looksLikePdf('https://example.com/how-to-read-a-pdf-file'))->toBeFalse();
});

test('a cited PDF is STAGED for the conversion lane, not text-extracted', function () {
    Http::fake(['*' => Http::response(pdfFixture('report-with-text-layer.pdf'), 200, ['Content-Type' => 'application/pdf'])]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/report.pdf');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_PDF_STAGED)
        ->and($result['extraction'])->toBe('staged_for_conversion')
        // No text at resolution time — it arrives when the OCR step runs. The
        // shortcut this replaced returned characters here.
        ->and($result['text'])->toBeNull()
        ->and($result['staged_path'])->toBeString()
        ->and(is_file($result['staged_path']))->toBeTrue()
        ->and($result['prose_blocks'])->toBe(1);  // page count

        @unlink($result['staged_path']);
});

test('a staged PDF counts as RESOLVED even with no text yet', function () {
    // The trap: every caller decided "did we get a source" with
    // `text !== null`, which would silently discard a perfectly resolved PDF
    // reference. isResolved() is the one place that question is asked.
    expect(WebTextAcquirer::isResolved(['text' => null, 'grade' => WebTextAcquirer::GRADE_PDF_STAGED]))->toBeTrue()
        ->and(WebTextAcquirer::isResolved(['text' => 'real prose', 'grade' => WebTextAcquirer::GRADE_ARTICLE_EXTRACT]))->toBeTrue()
        ->and(WebTextAcquirer::isResolved(['text' => null, 'grade' => WebTextAcquirer::GRADE_BLOCKED]))->toBeFalse()
        ->and(WebTextAcquirer::isResolved(['text' => null, 'grade' => WebTextAcquirer::GRADE_DEAD]))->toBeFalse();
});

test('a scan with no text layer is staged too — OCR is what it is FOR', function () {
    // The earlier version refused to spend OCR credits here and graded the
    // scan unusable. Citation review IS the paid service, and the OCR lane
    // exists precisely to read documents like this.
    Http::fake(['*' => Http::response(pdfFixture('scan-no-text-layer.pdf'), 200, ['Content-Type' => 'application/pdf'])]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/scanned.pdf');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_PDF_STAGED)
        ->and($result['reason'])->toContain('staged for OCR');

    @unlink($result['staged_path']);
});

test('an HTML error page mislabelled as a PDF is caught by the magic bytes', function () {
    // Servers do this. Handing it to the parser yields a useless exception
    // instead of a clear answer, so the %PDF- header is checked, not the
    // Content-Type header.
    Http::fake(['*' => Http::response('<html><body>Not found</body></html>', 200, ['Content-Type' => 'application/pdf'])]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/decoy.pdf');

    expect($result['text'])->toBeNull()
        ->and($result['reason'])->toContain('did not serve a PDF');
});

test('a 404 on a PDF URL is DEAD, not merely unreadable', function () {
    Http::fake(['*' => Http::response('gone', 404)]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/missing.pdf');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_DEAD)
        ->and($result['http_status'])->toBe(404);
});

test('the batch path stages a PDF reference rather than escalating it', function () {
    // The pooled HTML pass can only ever report "this served a PDF"; the
    // escalation must pick the PDF lane, not the browser.
    Http::fake(['*' => Http::response(pdfFixture('report-with-text-layer.pdf'), 200, ['Content-Type' => 'application/pdf'])]);

    $results = app(WebFetchService::class)->fetchAndValidateBatch([
        'ref1' => ['url' => 'https://example.com/report.pdf', 'title' => 'A PUCL Study'],
    ]);

    expect($results['ref1']['grade'])->toBe(WebTextAcquirer::GRADE_PDF_STAGED)
        ->and(WebTextAcquirer::isResolved($results['ref1']))->toBeTrue();

    @unlink($results['ref1']['staged_path']);
});

test('a landing page is followed to its ENGLISH pdf, not its French one', function () {
    // Institutional publishers post one document in six languages off a single
    // record page — the UN is the standard case — and we can only verify a
    // claim against the language we can read.
    $locator = app(\App\Services\SourceImport\Content\LandingPagePdfLocator::class);

    $html = '<html><body>'
        . '<a href="/record/4015916/files/A_HRC_54_25-FR.pdf">Français</a>'
        . '<a href="/record/4015916/files/A_HRC_54_25-AR.pdf">Arabic</a>'
        . '<a href="/record/4015916/files/A_HRC_54_25-EN.pdf">English</a>'
        . '<a href="/record/4015916/files/A_HRC_54_25-ZH.pdf">Chinese</a>'
        . '<a href="/record/4015916/files/frontmatter.pdf">Cover</a>'
        . '<a href="/about">About</a></body></html>';

    expect($locator->locateForCitation($html, 'https://digitallibrary.un.org/record/4015916'))
        ->toBe('https://digitallibrary.un.org/record/4015916/files/A_HRC_54_25-EN.pdf');
});

test('a government publishing path is recognised as the report', function () {
    // Drupal/WordPress institutional paths score nothing on the harvest ladder
    // beyond a bare .pdf, but they are where cited reports actually live.
    $locator = app(\App\Services\SourceImport\Content\LandingPagePdfLocator::class);

    $html = '<html><body><a href="/sites/default/files/2024-01/annual-report.pdf">Download</a>'
        . '<a href="/news">News</a></body></html>';

    expect($locator->locateForCitation($html, 'https://example.gov/publications/annual'))
        ->toBe('https://example.gov/sites/default/files/2024-01/annual-report.pdf');

    expect($locator->locateForCitation('<html><body><a href="/x">x</a></body></html>', 'https://e.com/a'))
        ->toBeNull();
});

test("harvest's own PDF ranking is unchanged by the citation variant", function () {
    // locateForCitation is a SEPARATE method precisely so the choice harvest
    // mints canonical versions from cannot drift.
    $locator = app(\App\Services\SourceImport\Content\LandingPagePdfLocator::class);

    $html = '<html><body><a href="/bitstream/123/1/paper.pdf">Full text</a>'
        . '<a href="/other.pdf">Other</a></body></html>';

    expect($locator->extractFromHtml($html, 'https://repo.test/handle/123'))
        ->toBe('https://repo.test/bitstream/123/1/paper.pdf');
});

test('an article page is NOT abandoned for a stray PDF link in its sidebar', function () {
    // The landing-page hunt runs only after the HTML has failed to yield an
    // article, so a real piece with a "download our report" rail keeps its own
    // text.
    $para = '<p>' . str_repeat('The committee reported that enforcement had lapsed in four districts. ', 14) . '</p>';
    Http::fake(['*' => Http::response(
        "<html><head><title>Enforcement lapsed</title></head><body><article>{$para}{$para}</article>"
        . '<aside><a href="/sites/default/files/unrelated.pdf">Download our annual report</a></aside>'
        . '</body></html>',
        200,
        ['Content-Type' => 'text/html'],
    )]);

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/story');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_ARTICLE_EXTRACT)
        ->and($result['channel'])->not->toBe('landing_pdf')
        ->and($result['text'])->toContain('enforcement had lapsed');
});

test('a PDF source stub records completeness as verified_full', function () {
    // full_text is the only web grade that earns verified_full, so the verify
    // prompt does NOT get the "absence is inconclusive" warning for it.
    $columns = (new ReflectionClass(WebFetchService::class))->getMethod('completenessColumns');
    $columns->setAccessible(true);
    $row = $columns->invoke(app(WebFetchService::class), WebTextAcquirer::GRADE_FULL_TEXT);

    expect($row['completeness'])->toBe('verified_full');

    $extract = $columns->invoke(app(WebFetchService::class), WebTextAcquirer::GRADE_ARTICLE_EXTRACT);
    expect($extract['completeness'])->toBe('partial');
});
