<?php

namespace App\Services\SourceImport\Content;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;

/**
 * The PHP face of app/Python/ingestion/marxists/stitch.py: one marxists.org
 * work, crawled page by page and packed into ONE EPUB the existing epub
 * pipeline reads (docs/marxists-import.md).
 *
 * `metadata()` fetches a single page (the preview card). `build()` crawls the
 * whole work — politely, ~1.5s a page, so Capital takes over a minute — and is
 * therefore only ever run from a queued job (StitchMarxistsWorkJob), never
 * inside a web request.
 */
class MarxistsStitcher
{
    private const VENV_PYTHON = '/var/www/hyperlit/venv/bin/python3';

    public const METADATA_TIMEOUT = 60;

    /** 200 pages × (fetch + delay) with headroom, inside the import worker's 900s job limit. */
    public const BUILD_TIMEOUT = 780;

    /** A listing plus up to ~150 year pages at 1.5s each. */
    public const LIST_TIMEOUT = 600;

    /**
     * @return array{ok: true, metadata: array<string, mixed>}|array{ok: false, error: string, detail: ?string}
     */
    public function metadata(string $url): array
    {
        return $this->run(['metadata', $url], self::METADATA_TIMEOUT);
    }

    /**
     * Crawl the work into `{$destDir}/original.epub` (+ `marxists_provenance.json`).
     * Progress is written to `{$destDir}/progress.json` as it goes.
     *
     * @return array{ok: true, epub: string, pages: int, images: int}|array{ok: false, error: string, detail: ?string}
     */
    public function build(string $url, string $destDir): array
    {
        return $this->run(['build', $url, $destDir, '--progress'], self::BUILD_TIMEOUT);
    }

    /**
     * The works an AUTHOR'S LISTING page links, one address per work (docs/marxists-import.md).
     * Reads the listing and, for the Marx/Engels by-date listing, its year pages — nothing else.
     *
     * @return array{ok: true, listing: string, works: list<array{url: string, title: ?string, kind: string}>,
     *               followed: list<string>, skipped: array<string, int>}|array{ok: false, error: string, detail: ?string}
     */
    public function listWorks(string $listingUrl): array
    {
        return $this->run(['list', $listingUrl], self::LIST_TIMEOUT);
    }

    private function run(array $args, int $timeout): array
    {
        $command = array_merge([$this->python(), base_path('app/Python/ingestion/marxists/stitch.py')], $args);

        try {
            $result = Process::timeout($timeout)->run($command);
        } catch (\Throwable $e) {
            Log::warning('marxists stitcher did not finish', ['args' => $args, 'error' => $e->getMessage()]);

            return ['ok' => false, 'error' => 'stitch_failed', 'detail' => $e->getMessage()];
        }

        // Exit 0 = done, 2 = a refusal with a reason for the user; both print one JSON object.
        $decoded = json_decode(trim($result->output()), true);
        if (is_array($decoded) && isset($decoded['ok'])) {
            return $decoded + ['error' => null, 'detail' => null];
        }

        Log::warning('marxists stitcher failed', [
            'args' => $args, 'exit' => $result->exitCode(), 'stderr' => mb_substr($result->errorOutput(), -1500),
        ]);

        return ['ok' => false, 'error' => 'stitch_failed', 'detail' => mb_substr(trim($result->errorOutput()), -300)];
    }

    /** The prod virtualenv when present (bs4 / lxml live there), else PYTHON_PATH, else PATH. */
    private function python(): string
    {
        if (file_exists(self::VENV_PYTHON)) {
            return self::VENV_PYTHON;
        }
        $configured = env('PYTHON_PATH');

        return is_string($configured) && $configured !== '' ? $configured : 'python3';
    }
}
