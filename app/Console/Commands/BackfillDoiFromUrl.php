<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/**
 * One-off: for library rows where library.doi is empty but library.url contains a
 * DOI (e.g. https://www.tandfonline.com/doi/pdf/10.1080/00472338285390361), extract
 * the DOI and populate library.doi so the canonical matcher can link the row.
 *
 * Pre-existed this command's life: legacy imports that captured the DOI inside the
 * URL field rather than the dedicated column. Without this fix, those rows look
 * un-canonicalisable and don't surface in CanonicalRegistry::findVersionsByIdentifier.
 *
 * See docs/canonical-sources.md for the wider system.
 */
class BackfillDoiFromUrl extends Command
{
    protected $signature = 'library:backfill-doi
                            {--book= : Process one library row by book id}
                            {--limit=0 : Max rows to process (0 = unlimited)}
                            {--canonicalize : After populating DOI, run the matcher on the row}
                            {--dry-run : Print what would change, write nothing}
                            {--sleep=0 : Seconds between rows (cushion if --canonicalize is on)}';

    protected $description = 'Extract DOIs from library.url and populate library.doi where missing.';

    public function handle(): int
    {
        $bookId       = $this->option('book') ?: null;
        $limit        = (int) $this->option('limit');
        $canonicalize = (bool) $this->option('canonicalize');
        $dryRun       = (bool) $this->option('dry-run');
        $sleep        = (int) $this->option('sleep');

        // Admin connection bypasses RLS so the backfill sees the whole library.
        $query = DB::connection('pgsql_admin')->table('library');

        if ($bookId) {
            $query->where('book', $bookId);
        } else {
            $query->whereNotIn('book', ['stats', 'most-recent', 'most-connected', 'most-lit']);
            // Sub-books have a slash in the book id; canonical identity is top-level.
            $query->where('book', 'NOT LIKE', '%/%');
            // Only consider rows that look fixable.
            $query->where(function ($q) {
                $q->whereNull('doi')->orWhere('doi', '');
            });
            $query->whereNotNull('url');
            $query->whereRaw("url ~* '10\\.\\d{4,9}/'");
        }

        $query->orderBy('timestamp', 'desc');

        $totalCandidates = (clone $query)->count();
        $this->info("Rows in scope: {$totalCandidates}" . ($dryRun ? ' (dry-run)' : ''));

        if ($limit > 0) {
            $query->limit($limit);
        }

        $rows = $query->select('book', 'doi', 'url')->get();
        $bar  = $this->output->createProgressBar($rows->count());
        $bar->start();

        $stats = [
            'extracted'           => 0,
            'written'             => 0,
            'skipped_no_doi'      => 0,
            'skipped_already_set' => 0,
            'canonicalize_ok'     => 0,
            'canonicalize_fail'   => 0,
            'error'               => 0,
        ];
        $errorSamples = [];

        foreach ($rows as $row) {
            try {
                // Defensive: even when --book is set, never overwrite a non-empty doi.
                if (!empty($row->doi)) {
                    $stats['skipped_already_set']++;
                    $bar->advance();
                    continue;
                }

                $doi = $this->extractDoi((string) $row->url);
                if ($doi === null) {
                    $stats['skipped_no_doi']++;
                    if ($this->getOutput()->isVerbose()) {
                        $bar->clear();
                        $this->line("  {$row->book}: no DOI pattern in url={$row->url}");
                        $bar->display();
                    }
                    $bar->advance();
                    continue;
                }

                $stats['extracted']++;

                if ($this->getOutput()->isVerbose()) {
                    $bar->clear();
                    $this->line("  {$row->book}: extracted doi='{$doi}' from url='{$row->url}'");
                    $bar->display();
                }

                if (!$dryRun) {
                    DB::connection('pgsql_admin')->table('library')
                        ->where('book', $row->book)
                        ->update(['doi' => $doi]);
                    $stats['written']++;

                    if ($canonicalize) {
                        $exit = Artisan::call('library:canonicalize', ['--book' => $row->book]);
                        if ($exit === 0) {
                            $stats['canonicalize_ok']++;
                        } else {
                            $stats['canonicalize_fail']++;
                            if (count($errorSamples) < 5) {
                                $errorSamples[] = "{$row->book}: canonicalize exit={$exit}";
                            }
                        }
                    }
                }
            } catch (\Throwable $e) {
                $stats['error']++;
                if (count($errorSamples) < 5) {
                    $errorSamples[] = "{$row->book}: " . $e->getMessage();
                }
            }

            $bar->advance();
            if ($sleep > 0) sleep($sleep);
        }

        $bar->finish();
        $this->newLine(2);

        $this->info('Summary:');
        foreach ($stats as $key => $count) {
            $this->line(sprintf('  %-22s %d', $key, $count));
        }
        if (!empty($errorSamples)) {
            $this->warn('Sample errors:');
            foreach ($errorSamples as $err) {
                $this->line('  ' . $err);
            }
        }

        return 0;
    }

    /**
     * Pull a DOI out of a URL. CrossRef-style: prefix "10." + 4–9 digits + "/" + body.
     * Body excludes '?' and '#' so query/fragment don't bleed in; trailing punctuation
     * stripped so a comma or period sitting next to the DOI in some sloppy URL doesn't
     * stick to it.
     */
    private function extractDoi(string $url): ?string
    {
        if (!preg_match('#10\.\d{4,9}/[A-Za-z0-9._\-:;()/]+#', $url, $m)) {
            return null;
        }
        return rtrim($m[0], '.,;:)') ?: null;
    }
}
