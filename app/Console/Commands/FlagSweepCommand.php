<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\GarbageDetector;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Sweep the library for conversion garbage — CAPTCHA/block pages saved as
 * whole books, near-empty conversions, OCR noise — and raise auto_sweep
 * conversion_flags for `library:reconvert-queue`. Detection heuristics live
 * in GarbageDetector (shared with WebArticleVerifier's block-page check).
 *
 * Scope: books with has_nodes=true that are either system auto-versions
 * (creator = canonicalizer_v1) or public — the books strangers actually read.
 * Always run --dry-run first on prod to eyeball the catch.
 */
class FlagSweepCommand extends Command
{
    protected $signature = 'library:flag-sweep
        {--dry-run : Print what would be flagged without writing flags}
        {--books= : Comma-separated book ids to sweep (default: whole scope)}
        {--auto-versions-only : Restrict to system auto-version books}';

    protected $description = 'Detect garbage conversions and raise auto_sweep conversion flags';

    public function handle(GarbageDetector $detector): int
    {
        $db = DB::connection('pgsql_admin');

        $query = $db->table('library')
            ->whereRaw("book NOT LIKE '%/%'")
            ->where('has_nodes', true)
            ->where('visibility', '!=', 'deleted');

        if ($books = $this->option('books')) {
            $query->whereIn('book', array_filter(array_map('trim', explode(',', $books))));
        } elseif ($this->option('auto-versions-only')) {
            $query->where('creator', AutoVersionResolver::CREATOR);
        } else {
            // Only books that went through an INGESTION path (import pipeline,
            // auto-version, web fetch). Hand-authored drafts and pseudo-books
            // (user-library pages, homepage node-books — type IS NULL, no
            // conversion provenance) are not conversions and never flagged.
            $query->where(function ($q) {
                $q->whereNotNull('conversion_method')
                    ->orWhereNotNull('fileType')
                    ->orWhere('type', 'web_source')
                    ->orWhere('creator', AutoVersionResolver::CREATOR);
            });
        }

        $rows = $query->orderBy('book')->get(['book', 'title', 'creator', 'conversion_method']);
        $this->info(sprintf('Sweeping %d books…', $rows->count()));

        $flagged = 0;
        $newFlags = []; // NEW open flags only — repeat sweeps of known-bad books don't re-alert
        foreach ($rows as $row) {
            $nodes = $db->table('nodes')->where('book', $row->book)
                ->orderBy('startLine')->get(['plainText']);

            $verdict = $detector->assessBook($nodes);
            if (!$verdict['flagged']) {
                continue;
            }

            $flagged++;
            $this->line(sprintf(
                '  FLAG %s  [%s]  %s',
                $row->book,
                implode(', ', $verdict['signals']),
                mb_substr(strip_tags((string) $row->title), 0, 60),
            ));

            if (!$this->option('dry-run')) {
                $flag = ConversionFlag::raise(
                    $row->book,
                    ConversionFlag::SOURCE_AUTO_SWEEP,
                    'garbage sweep: ' . implode(', ', $verdict['signals']),
                    [
                        'signals'           => $verdict['signals'],
                        'conversion_method' => $row->conversion_method,
                        'creator'           => $row->creator,
                    ],
                );
                if ($flag->wasRecentlyCreated) {
                    $newFlags[] = [
                        'book'    => $row->book,
                        'title'   => strip_tags((string) $row->title),
                        'signals' => $verdict['signals'],
                    ];
                }
            }
        }

        // ONE summary alert per run (never per book) — links to /maintainer.
        if ($newFlags !== []) {
            try {
                \Illuminate\Support\Facades\Mail::send(new \App\Mail\SweepFlagsRaisedMail($newFlags));
                $this->line(sprintf('Alert email queued (%d new flags) → %s', count($newFlags), config('mail.maintainer_alert')));
            } catch (\Throwable $e) {
                $this->warn('Alert email failed (sweep results are saved): ' . $e->getMessage());
            }
        }

        $this->info(sprintf(
            '%s%d of %d books flagged.',
            $this->option('dry-run') ? '[dry-run] ' : '',
            $flagged,
            $rows->count(),
        ));

        return self::SUCCESS;
    }
}
