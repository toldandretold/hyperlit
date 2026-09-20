<?php

namespace App\Services\WebContent;

use App\Services\ContentFetchService;
use App\Services\Security\UrlGuard;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Smalot\PdfParser\Parser;

/**
 * Acquire a cited source that IS a PDF, and STAGE it for the real conversion.
 *
 * Citation resolution used to throw these away outright: WebFetchService saw
 * `application/pdf` and returned nothing, so a reference pointing straight at a
 * report — the commonest shape for NGO, government and UN sources — resolved as
 * "source not found" while the document sat there, downloadable. Measured on
 * chacko: `pucl.org/.../PUCL-28.09.2022.pdf` is 41 pages of clean text layer
 * and we were reading none of it.
 *
 * ── Why this STAGES rather than extracts ─────────────────────────────────────
 * The first version of this class read the text layer in-process with
 * smalot/pdfparser and wrote the characters straight into a stub. It worked and
 * it was free — but it produced PLAIN TEXT: no footnotes, no headings, no
 * structure. That is the wrong output for this app, whose whole conversion
 * pipeline exists to recover exactly that structure (and which uses pypdf
 * alongside OCR precisely because OCR drops the superscript layer that carries
 * footnote markers).
 *
 * So a cited PDF now goes down the SAME lane as every other source in the
 * pipeline: the bytes are staged to `resources/markdown/{bookId}/original.pdf`,
 * the library row is written with `pdf_url_status = 'downloaded'` and
 * `has_nodes = false`, and the pipeline's existing OCR step (`citation:ocr`,
 * step 3 of `citation:pipeline`) converts it properly and bills the pages like
 * any other. Nothing new has to be invented; the earlier version simply could
 * not be SEEN by that step, because it failed all three of its conditions.
 *
 * Consequence for callers: a PDF reference resolves with NO text at resolution
 * time. Content arrives later, at the OCR step — the same two-phase shape the
 * canonical lane has always had (resolve in the scan, fetch in vacuum, convert
 * in OCR, review last).
 */
class PdfSourceReader
{
    /**
     * Refuse to buffer more than this. A citation source is a paper or a
     * report; anything past this is a corpus dump or a mis-served stream, and
     * smalot holds the whole document in memory while parsing.
     */
    private const MAX_BYTES = 40 * 1024 * 1024;

    /** Does this URL look like it will serve a PDF? */
    public static function looksLikePdf(string $url): bool
    {
        $path = strtolower((string) parse_url($url, PHP_URL_PATH));
        if (str_ends_with($path, '.pdf')) {
            return true;
        }

        // Repository landings advertise the rendition in the query string —
        // digitallibrary.un.org/record/4015916?v=pdf is a real chacko citation.
        $query = strtolower((string) parse_url($url, PHP_URL_QUERY));

        return $query !== '' && preg_match('/(^|&)(v|format|type|download)=pdf(&|$)/', $query) === 1;
    }

    /**
     * Download a cited PDF and hold it on disk for the conversion lane.
     *
     * @return array{path: ?string, pages: int, bytes: int, has_text_layer: bool, status: ?int, reason: ?string, final_url: ?string}
     *         `path` is a TEMP file. The caller moves it into the book's
     *         markdown directory once it has minted the stub's id — see
     *         WebFetchService::createPdfSourceStub.
     */
    public function download(string $url): array
    {
        if (! UrlGuard::isSafeFetchUrl($url)) {
            return $this->miss('blocked as unsafe to fetch');
        }

        try {
            $response = Http::withHeaders(ContentFetchService::browserHeaders())
                ->withOptions(['allow_redirects' => ['max' => 5, 'track_redirects' => true]])
                ->timeout(60)
                ->get($url);
        } catch (\Throwable $e) {
            return $this->miss('could not download the PDF: '.Str::limit($e->getMessage(), 120));
        }

        $status = $response->status();
        if (! $response->successful()) {
            return $this->miss("HTTP {$status} downloading the PDF", $status);
        }

        $bytes = $response->body();
        if (strlen($bytes) > self::MAX_BYTES) {
            return $this->miss('PDF is larger than we will buffer ('.round(strlen($bytes) / 1048576).'MB)', $status);
        }

        // Magic bytes, not the Content-Type header: a server that mislabels an
        // HTML error page as application/pdf is common, and staging that would
        // hand the conversion pipeline a file it cannot read.
        if (! str_starts_with($bytes, '%PDF-')) {
            // A URL that ADVERTISES a PDF (`?v=pdf`, a `.pdf` path) but serves
            // HTML is usually a repository LANDING page — digitallibrary.un.org
            // /record/4015916?v=pdf is exactly this. Flagged so the caller can
            // fall back to the HTML ladder and hunt the real PDF link on it,
            // rather than reporting a flat "not a PDF" and stopping.
            // array_merge, NOT `+`: the union operator keeps the LEFT side's
            // value for a duplicate key, so `miss()`'s default false would win
            // and the fallback would never fire.
            return array_merge(
                $this->miss('the URL did not serve a PDF (no %PDF- header)', $status),
                ['not_a_pdf' => true],
            );
        }

        $history = $response->header('X-Guzzle-Redirect-History');
        $finalUrl = $history ? last(explode(', ', $history)) : $url;

        $dir = storage_path('app/tmp/citation-pdf');
        if (! is_dir($dir) && ! @mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return $this->miss('could not create a staging directory for the PDF', $status, $finalUrl);
        }

        $path = $dir.'/'.Str::random(24).'.pdf';
        if (file_put_contents($path, $bytes) === false) {
            return $this->miss('could not stage the PDF to disk', $status, $finalUrl);
        }

        $probe = $this->probe($path);

        return [
            'path' => $path,
            'pages' => $probe['pages'],
            'bytes' => strlen($bytes),
            'has_text_layer' => $probe['has_text_layer'],
            'status' => $status,
            'reason' => null,
            'final_url' => $finalUrl,
        ];
    }

    /**
     * Cheap look at what we staged, for the resolution LOG only — never as the
     * source text. Knowing a cited report is a scan (so its conversion will
     * cost OCR and may come back rough) is worth recording; using these
     * characters as evidence is not, which is why nothing returns them.
     *
     * @return array{pages: int, has_text_layer: bool}
     */
    private function probe(string $path): array
    {
        try {
            $doc = (new Parser())->parseFile($path);

            return [
                'pages' => count($doc->getPages()),
                'has_text_layer' => mb_strlen(trim($doc->getText())) >= 400,
            ];
        } catch (\Throwable $e) {
            // Encrypted or malformed for smalot says nothing about whether the
            // real pipeline can read it — it is a probe, not a gate.
            Log::info('PdfSourceReader: probe failed', ['error' => Str::limit($e->getMessage(), 160)]);

            return ['pages' => 0, 'has_text_layer' => false];
        }
    }

    /** @return array{path: null, pages: int, bytes: int, has_text_layer: bool, status: ?int, reason: string, final_url: ?string, not_a_pdf: bool} */
    private function miss(string $reason, ?int $status = null, ?string $finalUrl = null): array
    {
        return [
            'path' => null, 'pages' => 0, 'bytes' => 0, 'has_text_layer' => false,
            'status' => $status, 'reason' => $reason, 'final_url' => $finalUrl,
            'not_a_pdf' => false,
        ];
    }
}
