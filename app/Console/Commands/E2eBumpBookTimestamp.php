<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Bump a book's library.timestamp to "now" (epoch ms) so the NEXT client load
 * sees its local IndexedDB copy as stale and takes the clear + full-redownload
 * path. Support seam for the page-load performance e2e suite
 * (tests/e2e/specs/performance/user-page-load.spec.js) — its WARM-BUT-STALE
 * scenario needs to force that path deterministically without editing a real
 * book (which would also trip the server-side home-book regeneration and
 * pollute the measurement).
 *
 *   php artisan e2e:bump-book-timestamp {bookId}
 *
 * Local-env only, and uses the BYPASSRLS pgsql_admin connection (same
 * rationale as SeedE2eFixtures — no HTTP session token in a CLI context).
 */
class E2eBumpBookTimestamp extends Command
{
    protected $signature = 'e2e:bump-book-timestamp {bookId : library.book id to mark newer-than-local}';

    protected $description = 'Bump library.timestamp to now for one book (e2e perf-suite stale-cache seam; local only)';

    public function handle(): int
    {
        if (!app()->environment('local')) {
            $this->error('Refusing: e2e:bump-book-timestamp is a local-env test seam.');
            return self::FAILURE;
        }

        $bookId = $this->argument('bookId');
        $nowMs = (int) round(microtime(true) * 1000);

        $updated = DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $bookId)
            ->update(['timestamp' => $nowMs]);

        if ($updated === 0) {
            $this->error("No library row with book = {$bookId}");
            return self::FAILURE;
        }

        $this->info("library.timestamp for {$bookId} set to {$nowMs}");
        return self::SUCCESS;
    }
}
