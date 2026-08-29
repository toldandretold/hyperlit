<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Repair library rows whose synthesised BibTeX carries the IMPORT year instead
 * of the work's publication year.
 *
 * WHY THEY EXIST: buildBibtexEntry (resources/js/utilities/bibtexProcessor.ts)
 * used to stamp `new Date().getFullYear()` into every entry it built, and it is
 * rebuilt whenever a book's title changes. So a 2024 article imported in 2026
 * ends up with `year = {2026}` — and since the hypercite ↗ panel formats
 * library.bibtex, it rendered "(2026)" right next to the citing book's own
 * bibliography entry (which reads canonical_source) saying "(2024)". The
 * generator no longer invents a year; this fixes the rows it already wrote.
 *
 * TRUTH ORDER: library.year, else canonical_source.year via
 * library.canonical_source_id. A row with neither is left alone and counted —
 * there is nothing to correct it to, and replacing a wrong year with a
 * different guess is not an improvement.
 *
 * USAGE:
 *   php artisan library:fix-bibtex-year               # report
 *   php artisan library:fix-bibtex-year --book=<id>   # one book
 *   php artisan library:fix-bibtex-year --fix         # apply
 */
class FixLibraryBibtexYear extends Command
{
    protected $signature = 'library:fix-bibtex-year {--fix : Apply the rewrite (default is a dry run)} {--book= : Restrict to one book}';

    protected $description = 'Rewrite library.bibtex year fields that disagree with the row\'s real publication year';

    public function handle(): int
    {
        $fix = (bool) $this->option('fix');
        $bookFilter = $this->option('book');

        if (! $fix) {
            $this->info('🔍 DRY RUN — nothing will be written. Re-run with --fix to apply.');
        }

        $db = DB::connection('pgsql_admin');

        $query = $db->table('library as l')
            ->leftJoin('canonical_source as cs', 'cs.id', '=', 'l.canonical_source_id')
            ->whereNotNull('l.bibtex')
            ->where('l.bibtex', 'like', '%year%')
            ->select(['l.book', 'l.bibtex', 'l.year as lib_year', 'cs.year as canon_year']);

        if ($bookFilter) {
            $query->where('l.book', $bookFilter);
        }

        $changed = 0;
        $agreed = 0;
        $unknowable = 0;
        $samples = [];

        foreach ($query->cursor() as $row) {
            if (! preg_match('/year\s*=\s*[{"](\d{3,4})["}]/', (string) $row->bibtex, $m)) {
                continue;
            }
            $current = $m[1];

            $truth = $this->firstYear($row->lib_year) ?? $this->firstYear($row->canon_year);
            if ($truth === null) {
                $unknowable++;

                continue;
            }
            if ($truth === $current) {
                $agreed++;

                continue;
            }

            $changed++;
            if (count($samples) < 15) {
                $samples[] = "  {$row->book}: {$current} → {$truth}";
            }

            if ($fix) {
                $newBibtex = preg_replace(
                    '/(year\s*=\s*[{"])\d{3,4}(["}])/',
                    '${1}'.$truth.'${2}',
                    (string) $row->bibtex,
                    1
                );
                $db->table('library')->where('book', $row->book)->update([
                    'bibtex'     => $newBibtex,
                    'updated_at' => now(),
                ]);
            }
        }

        $this->newLine();
        foreach ($samples as $sample) {
            $this->line($sample);
        }
        if ($changed > count($samples)) {
            $this->line('  … and '.($changed - count($samples)).' more');
        }

        $this->newLine();
        $this->info("{$agreed} already correct · {$changed} ".($fix ? 'rewritten' : 'to rewrite')." · {$unknowable} with no known year (left alone)");
        if ($changed > 0 && ! $fix) {
            $this->warn('Re-run with --fix to apply.');
        }

        return 0;
    }

    /** First 3–4 digit year in a value that may be "2024", 2024, or "2024-05-16". */
    private function firstYear(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return preg_match('/\d{3,4}/', (string) $value, $m) ? $m[0] : null;
    }
}
