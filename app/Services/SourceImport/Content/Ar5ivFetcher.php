<?php

namespace App\Services\SourceImport\Content;

use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Fetches ar5iv's LaTeXML-rendered HTML for an arXiv paper. ar5iv is a public
 * service that runs LaTeXML across every arXiv submission and hosts the HTML;
 * preferred over fetching the source .tar because the bibliography is already
 * resolved (citation markers numbered, bib entries structured) — Pandoc on raw
 * LaTeX would leave us re-doing that work with worse results.
 */
class Ar5ivFetcher implements ContentFetcher
{
    private const BASE_URL = 'https://ar5iv.labs.arxiv.org/html/';
    private const TIMEOUT_SECONDS = 60;

    public function supports(Identifier $id, SourceMetadata $metadata): bool
    {
        return $id instanceof ArxivId;
    }

    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        if (!$id instanceof ArxivId) {
            return FetchResult::failure('unsupported_identifier');
        }

        $url = self::BASE_URL . $id->value();

        try {
            $response = Http::timeout(self::TIMEOUT_SECONDS)
                ->withHeaders(['User-Agent' => 'Hyperlit/1.0 (mailto:sam@hyperlit.io)'])
                ->get($url);
        } catch (\Throwable $e) {
            Log::warning('Ar5iv fetch threw', ['arxiv_id' => $id->value(), 'error' => $e->getMessage()]);
            return FetchResult::failure('network_error');
        }

        if (!$response->successful()) {
            Log::info('Ar5iv fetch non-2xx', ['arxiv_id' => $id->value(), 'status' => $response->status()]);
            return FetchResult::failure('http_error', $response->status());
        }

        $body = $response->body();
        if ($body === '' || stripos($body, '<html') === false) {
            return FetchResult::failure('empty_or_invalid_html');
        }

        $targetPath = rtrim($destDir, '/') . '/original.html';
        if (file_put_contents($targetPath, $body) === false) {
            return FetchResult::failure('write_failed');
        }
        @chmod($targetPath, 0644);

        return FetchResult::success($targetPath, 'html');
    }
}
