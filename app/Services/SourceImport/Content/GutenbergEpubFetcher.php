<?php

namespace App\Services\SourceImport\Content;

use App\Services\SourceImport\Identifier\GutenbergId;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Downloads a Project Gutenberg book's EPUB into the import directory. Gutenberg
 * publishes stable per-format URLs under /ebooks/<id>.<format> that 302 to the
 * actual cache file; we prefer the epub3-with-images build and fall back to the
 * older epub2 variants. The resulting original.epub rides the existing
 * EpubProcessor pipeline unchanged.
 */
class GutenbergEpubFetcher implements ContentFetcher
{
    private const BASE_URL = 'https://www.gutenberg.org/ebooks/';
    private const VARIANTS = ['epub3.images', 'epub.images', 'epub.noimages'];
    private const TIMEOUT_SECONDS = 120;

    public function supports(Identifier $id, SourceMetadata $metadata): bool
    {
        return $id instanceof GutenbergId;
    }

    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        if (!$id instanceof GutenbergId) {
            return FetchResult::failure('unsupported_identifier');
        }

        $lastStatus = null;

        foreach (self::VARIANTS as $variant) {
            $url = self::BASE_URL . $id->value() . '.' . $variant;

            try {
                $response = Http::timeout(self::TIMEOUT_SECONDS)
                    ->withHeaders(['User-Agent' => 'Hyperlit/1.0 (mailto:sam@hyperlit.io)'])
                    ->get($url);
            } catch (\Throwable $e) {
                Log::warning('Gutenberg EPUB fetch threw', [
                    'gutenberg_id' => $id->value(),
                    'variant'      => $variant,
                    'error'        => $e->getMessage(),
                ]);
                continue;
            }

            if (!$response->successful()) {
                $lastStatus = $response->status();
                Log::info('Gutenberg EPUB variant non-2xx', [
                    'gutenberg_id' => $id->value(),
                    'variant'      => $variant,
                    'status'       => $lastStatus,
                ]);
                continue;
            }

            $body = $response->body();
            // An EPUB is a ZIP; a missing variant can come back as an HTML page.
            if (!str_starts_with($body, 'PK')) {
                Log::info('Gutenberg EPUB variant returned non-zip body', [
                    'gutenberg_id' => $id->value(),
                    'variant'      => $variant,
                ]);
                continue;
            }

            $targetPath = rtrim($destDir, '/') . '/original.epub';
            if (file_put_contents($targetPath, $body) === false) {
                return FetchResult::failure('write_failed');
            }
            @chmod($targetPath, 0644);

            return FetchResult::success($targetPath, 'epub');
        }

        return FetchResult::failure('http_error', $lastStatus);
    }
}
