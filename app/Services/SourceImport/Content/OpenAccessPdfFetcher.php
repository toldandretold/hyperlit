<?php

namespace App\Services\SourceImport\Content;

use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Fetches the OA PDF that OpenAlex (or any other metadata resolver) flagged on
 * the work. Many publisher hosts return 403 for non-browser User-Agents even
 * when the paper is OA; that's a typed failure ('blocked'), not an exception.
 */
class OpenAccessPdfFetcher implements ContentFetcher
{
    private const TIMEOUT_SECONDS = 120;
    private const MAX_BYTES = 250 * 1024 * 1024;

    public function supports(Identifier $id, SourceMetadata $metadata): bool
    {
        return $metadata->isOpenAccess() && $metadata->pdfUrl() !== null;
    }

    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        $url = $metadata->pdfUrl();
        if (!$url) {
            return FetchResult::failure('no_pdf_url');
        }

        try {
            $response = Http::timeout(self::TIMEOUT_SECONDS)
                ->withHeaders([
                    // A browser-like UA gets past hosts that block bare HTTP clients.
                    // We aren't pretending to be a real user, but we are a legitimate
                    // OA fetcher and OpenAlex itself recommends this practice.
                    'User-Agent' => 'Mozilla/5.0 (compatible; Hyperlit/1.0; +https://hyperlit.io)',
                    'Accept'     => 'application/pdf,*/*;q=0.8',
                ])
                ->get($url);
        } catch (\Throwable $e) {
            Log::warning('OA PDF fetch threw', ['url' => $url, 'error' => $e->getMessage()]);
            return FetchResult::failure('network_error');
        }

        if ($response->status() === 403 || $response->status() === 401) {
            return FetchResult::failure('blocked', $response->status());
        }
        if (!$response->successful()) {
            return FetchResult::failure('http_error', $response->status());
        }

        $body = $response->body();
        if (strlen($body) > self::MAX_BYTES) {
            return FetchResult::failure('too_large');
        }
        if (substr($body, 0, 4) !== '%PDF') {
            // Some servers return HTML "click here to download" pages with a 200.
            return FetchResult::failure('not_a_pdf');
        }

        $targetPath = rtrim($destDir, '/') . '/original.pdf';
        if (file_put_contents($targetPath, $body) === false) {
            return FetchResult::failure('write_failed');
        }
        @chmod($targetPath, 0644);

        return FetchResult::success($targetPath, 'pdf');
    }
}
