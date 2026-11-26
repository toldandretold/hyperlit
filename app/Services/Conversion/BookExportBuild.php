<?php

namespace App\Services\Conversion;

use App\Console\Commands\BookExport;
use App\Jobs\BuildBookExportJob;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;

/**
 * The state of one book's case-bundle build, shared by the maintainer consoles' "⤓ glitch"
 * buttons and the job that does the work.
 *
 * The bundle used to be built INSIDE the download request. A long book outlasts Cloudflare's
 * 100-second origin limit, so the button answered with a 524 page and no file (prod 2026-11-26,
 * Theories of Surplus-Value). The build is now a queued job and the request only ever does
 * one of three short things: start it, report on it, or hand over a file that already exists.
 */
class BookExportBuild
{
    public const BUILDING = 'building';
    public const READY = 'ready';
    public const FAILED = 'failed';
    public const NONE = 'none';

    /** A build still "building" after this long is taken for dead and may be restarted. */
    private const STALE_AFTER_SECONDS = 3900;

    private const TTL_SECONDS = 86400;

    public function tarball(string $book): string
    {
        return storage_path("app/book-exports/{$book}.tar.gz");
    }

    /**
     * Queue a build unless one is already running for this book. Returns the state the caller
     * should show.
     *
     * @return array{state: string, kind?: string, error?: string, bytes?: int, seconds?: int}
     */
    public function start(string $book, string $kind = '', string $origin = ''): array
    {
        $current = $this->status($book);
        if ($current['state'] === self::BUILDING) {
            return $current;
        }

        $this->put($book, ['state' => self::BUILDING, 'kind' => $kind, 'started_at' => time()]);
        BuildBookExportJob::dispatch($book, $kind, $origin);

        // With the sync driver the job has already run and written its own verdict.
        return $this->status($book);
    }

    /** @return array{state: string, kind?: string, error?: string, bytes?: int, seconds?: int} */
    public function status(string $book): array
    {
        $state = Cache::get($this->key($book));
        if (!is_array($state)) {
            return ['state' => self::NONE];
        }
        if ($state['state'] === self::BUILDING) {
            $age = time() - (int) ($state['started_at'] ?? 0);
            if ($age > self::STALE_AFTER_SECONDS) {
                return ['state' => self::FAILED, 'error' => 'The build never reported back — press the button again.'];
            }

            return ['state' => self::BUILDING, 'kind' => (string) ($state['kind'] ?? ''), 'seconds' => $age];
        }
        if ($state['state'] === self::READY && !File::exists($this->tarball($book))) {
            return ['state' => self::NONE];
        }
        unset($state['started_at']);

        return $state;
    }

    public function markReady(string $book, string $kind): void
    {
        $this->put($book, [
            'state' => self::READY,
            'kind'  => $kind,
            'bytes' => (int) @filesize($this->tarball($book)),
        ]);
    }

    public function markFailed(string $book, string $error): void
    {
        $this->put($book, ['state' => self::FAILED, 'error' => mb_substr($error, 0, 300)]);
    }

    /** The case kind recorded in the manifest of the bundle on disk (book:export auto-detects it). */
    public function builtKind(string $book): string
    {
        $probe = new \Symfony\Component\Process\Process(['tar', '-xzOf', $this->tarball($book), './manifest.json']);
        $probe->run();

        return (string) (json_decode($probe->getOutput(), true)['case_kind'] ?? BookExport::KIND_CONVERSION);
    }

    private function put(string $book, array $state): void
    {
        Cache::put($this->key($book), $state, self::TTL_SECONDS);
    }

    private function key(string $book): string
    {
        return "book-export-build:{$book}";
    }
}
