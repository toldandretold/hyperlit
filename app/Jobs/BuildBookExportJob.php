<?php

namespace App\Jobs;

use App\Console\Commands\BookExport;
use App\Services\Conversion\BookExportBuild;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;

/**
 * Builds one book's case bundle (`book:export`) for the maintainer consoles. See
 * BookExportBuild for why this is not done in the request.
 *
 * Rides the `archive-export` queue: it is the same kind of work (package a tarball for a
 * person who is waiting), that worker is almost always idle, and a new queue name would be
 * one more that Supervisor, package.json and queue:probe all have to learn. It must NOT ride
 * `default` — the consoles are used exactly while a 900-book reconvert is draining there.
 */
class BuildBookExportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;

    public int $tries = 1; // pressing the button again re-dispatches

    public function __construct(
        private string $book,
        private string $kind = '',
        private string $origin = '',
    ) {
        $this->onQueue('archive-export');
    }

    public function handle(BookExportBuild $build): void
    {
        $args = ['book' => $this->book];
        if (in_array($this->kind, [BookExport::KIND_CONVERSION, BookExport::KIND_HARVEST], true)) {
            $args['--kind'] = $this->kind;
        }
        if ($this->origin !== '') {
            $args['--origin'] = $this->origin;
        }

        $started = microtime(true);
        $exit = Artisan::call('book:export', $args);
        $seconds = round(microtime(true) - $started, 1);

        if ($exit !== 0 || !is_file($build->tarball($this->book))) {
            $output = trim(Artisan::output());
            Log::warning('Book export failed', ['book' => $this->book, 'exit' => $exit, 'output' => $output]);
            $build->markFailed($this->book, $output !== '' ? $output : 'Export failed — see logs.');

            return;
        }

        $kind = $args['--kind'] ?? $build->builtKind($this->book);
        $build->markReady($this->book, $kind);
        Log::info('Book export built', [
            'book' => $this->book, 'kind' => $kind, 'seconds' => $seconds,
            'bytes' => filesize($build->tarball($this->book)),
        ]);
    }

    public function failed(?\Throwable $e): void
    {
        app(BookExportBuild::class)->markFailed($this->book, $e?->getMessage() ?: 'The build crashed — see logs.');
    }
}
