<?php

namespace App\Services\SourceImport\Content;

use App\Services\Security\UrlGuard;
use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Exception\ProcessTimedOutException;
use Symfony\Component\Process\Process;

/**
 * Headless-browser PDF fetcher. Shells out to scripts/fetch-pdf.mjs (Node +
 * Playwright) so we can clear Cloudflare JS challenges, scrape citation_pdf_url
 * meta tags, and carry session cookies across navigations — none of which a
 * bare HTTP client can do. Runs as the fallback after the cheap PHP probe.
 */
class PlaywrightPdfFetcher implements ContentFetcher
{
    /** Symfony Process wall-clock. Must exceed the script's HARD_TIMEOUT (68s)
     *  so PHP doesn't kill the browser mid-challenge — a headed patchright
     *  Cloudflare solve alone can take ~25-30s. */
    private const WALL_CLOCK_SECONDS = 75;

    public function supports(Identifier $id, SourceMetadata $metadata): bool
    {
        // arXiv is handled by Ar5ivFetcher more efficiently (HTML, no browser).
        return ! ($id instanceof ArxivId);
    }

    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        $dest = rtrim($destDir, '/').'/original.pdf';
        $progressFile = rtrim($destDir, '/').'/progress.json';

        $url = $metadata->pdfUrl() ?? $id->url();
        $landing = $id->url();

        if (! UrlGuard::isSafeFetchUrl($url)) {
            Log::warning('Playwright PDF fetch blocked by UrlGuard (SSRF)', ['url' => $url]);

            return FetchResult::failure('blocked_url');
        }
        if (! UrlGuard::isSafeFetchUrl($landing)) {
            Log::warning('Playwright landing URL blocked by UrlGuard (SSRF)', ['url' => $landing]);

            return FetchResult::failure('blocked_url');
        }

        $this->writeProgress($progressFile, 'fetching_pdf_browser', 'Opening browser…', 12);

        $payload = json_encode([
            'url' => $url,
            'dest' => $dest,
            'landing' => $landing,
            'progressFile' => $progressFile,
        ]);

        $scriptPath = base_path('scripts/fetch-pdf.mjs');

        try {
            $process = new Process(['node', $scriptPath], base_path());
            $process->setInput($payload);
            $process->setTimeout(self::WALL_CLOCK_SECONDS);
            $process->run();
        } catch (ProcessTimedOutException $e) {
            Log::warning('Playwright fetch wall-clock exceeded', [
                'identifier' => $id->kind().':'.$id->value(),
            ]);

            return FetchResult::failure('playwright_timeout');
        } catch (\Throwable $e) {
            Log::warning('Playwright process spawn failed', ['error' => $e->getMessage()]);

            return FetchResult::failure('node_unavailable');
        }

        $stdout = trim($process->getOutput());
        $result = json_decode($stdout, true);

        if (is_array($result) && ($result['ok'] ?? false) === true) {
            if (! File::exists($dest)) {
                Log::warning('Playwright reported ok but file missing', ['dest' => $dest]);

                return FetchResult::failure('playwright_crash');
            }
            @chmod($dest, 0644);

            return FetchResult::success($dest, 'pdf');
        }

        if (is_array($result) && isset($result['reason'])) {
            Log::info('Playwright fetch reported failure', [
                'reason' => $result['reason'],
                'detail' => $result['detail'] ?? null,
                'httpStatus' => $result['httpStatus'] ?? null,
                'finalUrl' => $result['finalUrl'] ?? null,
            ]);

            return FetchResult::failure($result['reason'], $result['httpStatus'] ?? null);
        }

        // Non-JSON output usually means Node itself crashed before we wrote our protocol.
        $stderr = $process->getErrorOutput();
        Log::warning('Playwright produced no parseable output', [
            'exit' => $process->getExitCode(),
            'stderr' => substr($stderr, 0, 500),
            'stdout' => substr($stdout, 0, 200),
        ]);
        if (str_contains($stderr, "Cannot find module 'playwright'")) {
            return FetchResult::failure('playwright_not_installed');
        }
        if ($process->getExitCode() === 127 || str_contains($stderr, 'command not found')) {
            return FetchResult::failure('node_unavailable');
        }

        return FetchResult::failure('playwright_crash');
    }

    private function writeProgress(string $file, string $stage, string $detail, int $percent): void
    {
        try {
            File::put($file, json_encode([
                'status' => 'processing',
                'stage' => $stage,
                'percent' => $percent,
                'detail' => $detail,
                'updated_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT));
        } catch (\Throwable $e) {
            // Progress is best-effort — never fail the fetch on a progress write.
        }
    }
}
