<?php

namespace App\Console\Commands;

use App\Models\PgHyperlight;
use Illuminate\Console\Command;

/**
 * Purge Phantom "HL_overlap" Hyperlight Records
 *
 * PURPOSE:
 * Deletes hyperlights rows whose hyperlight_id is the literal string
 * "HL_overlap" — these are NOT real highlights.
 *
 * WHY THIS IS NEEDED:
 * The renderer (applyHighlights) splits overlapping highlights into disjoint
 * <mark> segments and gives every multi-coverage segment the synthetic id
 * "HL_overlap". Before the positionCollector fix (2026-06-12), the edit-save
 * path keyed position records by mark.id, so editing any node containing
 * overlapping highlights CREATED a phantom "HL_overlap" record and synced it
 * to the server. Rendered back, the phantom inflates data-highlight-count
 * (triggering the dim-at-3+ hover styling on only part of a highlight),
 * stamps a junk HL_overlap class on marks, and shows up as an extra entry
 * when the highlight is clicked.
 *
 * The client now refuses to create them (positionCollector.ts) and refuses to
 * render them (applyHighlights guard), so deleting the rows is safe — nothing
 * references "HL_overlap" as a real identity. Stale copies in users' local
 * IndexedDB are rendered inert by the client-side guard.
 *
 * USAGE:
 * php artisan hyperlights:purge-overlap-phantoms --dry-run   # Preview
 * php artisan hyperlights:purge-overlap-phantoms             # Delete all
 * php artisan hyperlights:purge-overlap-phantoms {book}      # One book only
 */
class PurgeOverlapPhantomHyperlights extends Command
{
    protected $signature = 'hyperlights:purge-overlap-phantoms {book?} {--dry-run}';

    protected $description = 'Delete phantom hyperlights rows named "HL_overlap" (residue of the pre-fix overlap save bug)';

    public function handle(): int
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');

        $query = PgHyperlight::where('hyperlight_id', 'HL_overlap');
        if ($book) {
            $query->where('book', $book);
        }

        $phantoms = $query->get(['id', 'book', 'startLine', 'highlightedText', 'creator', 'created_at']);

        if ($phantoms->isEmpty()) {
            $this->info('✅ No phantom HL_overlap records found.');
            return self::SUCCESS;
        }

        $this->table(
            ['id', 'book', 'startLine', 'text (trunc)', 'creator', 'created_at'],
            $phantoms->map(fn ($p) => [
                $p->id,
                $p->book,
                $p->startLine,
                mb_substr((string) $p->highlightedText, 0, 50),
                $p->creator,
                $p->created_at,
            ])->all()
        );

        if ($dryRun) {
            $this->info("🔍 DRY RUN — {$phantoms->count()} phantom record(s) would be deleted.");
            return self::SUCCESS;
        }

        $deleted = PgHyperlight::whereIn('id', $phantoms->pluck('id'))->delete();
        $this->info("🗑️  Deleted {$deleted} phantom HL_overlap record(s).");

        return self::SUCCESS;
    }
}
