<?php

namespace App\Console\Commands;

use App\Models\ArchiveSource;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * citation:rescan-skipped-subs — re-scan ONLY the books that still hold a citation the scan
 * used to skip.
 *
 * Until 2026-11-14 a footnote whose FIRST work was a short form ("Pratt, 'Reconceptualizing
 * gender'; Chamindra Weerawardhana, 'Profoundly decolonizing?…', Meridians (2017)") was dropped
 * from the search queue whole, taking its fully-cited companions with it. The scan now searches
 * those companions — but hypercite detect never re-scans a book it has already scanned, so the
 * fix reaches an existing book only through an explicit re-scan.
 *
 * This is a command and not a workbench button on purpose: it is a one-off repair after a
 * pipeline fix, it spends LLM + search money per book, and it is aimed — it finds the books that
 * actually carry such a footnote and leaves the rest alone. Run from the CLI it is operator work
 * and unbilled, like any `citation:scan-bibliography`.
 *
 * The re-scan is NOT forced: existing matches are kept, only unresolved entries are worked.
 * DRY RUN BY DEFAULT. Nothing is scanned without --apply.
 */
class RescanSkippedSubCitationsCommand extends Command
{
    protected $signature = 'citation:rescan-skipped-subs
        {scope? : An archive slug (e.g. decolonising-security) or a shelf uuid; omit with --all}
        {--all : Every book, not one shelf}
        {--apply : Actually run the re-scans (default: list what would be scanned)}';

    protected $description = 'Re-scan books holding fully-cited works that were skipped behind a short-form footnote';

    public function handle(): int
    {
        $db = DB::connection('pgsql_admin');

        $scopeBooks = null;
        if (! $this->option('all')) {
            $shelfId = $this->resolveShelf((string) $this->argument('scope'));
            if ($shelfId === null) {
                $this->error('Give an archive slug or shelf uuid, or pass --all.');

                return self::FAILURE;
            }
            $scopeBooks = $db->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all();
        }

        // Cheap SQL prefilter (rows that carry sub-citations at all), exact test in PHP: jsonb
        // here is sometimes a JSON string inside jsonb, which a ->> filter would miss.
        $rows = $db->table('footnotes')
            ->where('is_citation', true)
            ->whereRaw("llm_metadata::text LIKE '%sub_citations%'")
            ->when($scopeBooks !== null, fn ($q) => $q->whereIn('book', $scopeBooks))
            ->orderBy('book')
            ->get(['book', 'llm_metadata']);

        $affected = [];
        foreach ($rows as $row) {
            if (self::hasSkippedSub($row->llm_metadata)) {
                $affected[$row->book] = ($affected[$row->book] ?? 0) + 1;
            }
        }

        if (! $affected) {
            $this->info('No book in scope holds a skipped sub-citation.');

            return self::SUCCESS;
        }

        $apply = (bool) $this->option('apply');
        $failed = 0;
        foreach ($affected as $book => $count) {
            $this->line(($apply ? 'scanning  ' : 'would scan  ') . "{$book}  ({$count} footnote" . ($count === 1 ? '' : 's') . ')');
            if (! $apply) {
                continue;
            }
            try {
                // One bad book must not end the run for the rest.
                if (Artisan::call('citation:scan-bibliography', ['target' => $book]) !== 0) {
                    $failed++;
                    $this->warn("  scan reported failure for {$book}");
                }
            } catch (\Throwable $e) {
                $failed++;
                $this->warn("  scan threw for {$book}: " . Str::limit($e->getMessage(), 200));
            }
        }

        $total = count($affected);
        $this->info($apply
            ? "Re-scanned {$total} book(s)" . ($failed ? ", {$failed} failed." : '.')
            : "Would re-scan {$total} book(s). Re-run with --apply (each scan makes paid LLM + search calls).");

        return $failed ? self::FAILURE : self::SUCCESS;
    }

    /**
     * A short-form (or ibid) footnote with a fully-cited companion that has never been searched:
     * the sub has a title, is not itself a short form, and carries no `resolution`.
     */
    public static function hasSkippedSub(mixed $rawMetadata): bool
    {
        $meta = $rawMetadata;
        for ($i = 0; $i < 2 && is_string($meta); $i++) {
            $meta = json_decode($meta, true);
        }
        if (! is_array($meta) || ! in_array($meta['type'] ?? null, ['short-form', 'ibid'], true)) {
            return false;
        }
        foreach ($meta['sub_citations'] ?? [] as $sub) {
            if (is_array($sub)
                && ! empty($sub['title'])
                && ! in_array($sub['type'] ?? null, ['short-form', 'ibid'], true)
                && empty($sub['resolution'])) {
                return true;
            }
        }

        return false;
    }

    private function resolveShelf(string $scope): ?string
    {
        if ($scope === '') {
            return null;
        }
        if (Str::isUuid($scope)) {
            return $scope;
        }
        $archive = ArchiveSource::where('slug', $scope)->first();

        return $archive?->shelf_id ? (string) $archive->shelf_id : null;
    }
}
