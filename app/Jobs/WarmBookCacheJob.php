<?php

namespace App\Jobs;

use App\Services\BookCache;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

/**
 * (Re)build a book's file cache off the request path.
 *
 * Dispatched on a cache MISS so the triggering read still serves from the live Postgres
 * path without paying the rebuild. `BookCache::warm()` is idempotent and lock-guarded, so
 * duplicate dispatches collapse to a single rebuild. Best-effort: warm() swallows its own
 * errors (the read already succeeded live).
 */
class WarmBookCacheJob implements ShouldQueue, ShouldBeUnique
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /** Collapse a burst of misses for the same book into one queued job. */
    public function uniqueId(): string
    {
        return $this->bookId;
    }

    /** Release the uniqueness lock shortly after dispatch; warm() itself is lock-guarded. */
    public int $uniqueFor = 60;

    public function __construct(public string $bookId)
    {
    }

    public function handle(BookCache $cache): void
    {
        $cache->warm($this->bookId);
    }
}
