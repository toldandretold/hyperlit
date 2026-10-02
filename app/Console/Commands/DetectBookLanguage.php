<?php

namespace App\Console\Commands;

use App\Jobs\DetectBookLanguageJob;
use App\Services\Translation\BookLanguageDetector;
use App\Services\Translation\BookTextSampler;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Detect and stamp library.language_detected for top-level books.
 *
 * Dry-run by default; --apply writes. The detected value feeds <html lang>
 * ONLY (declared library.language always wins) — never citation_language /
 * JSON-LD inLanguage, which stay declared-only.
 *
 * --stale re-runs books whose content changed since the last attempt
 * (library.timestamp, epoch ms, newer than language_detected_at) — the
 * weekly scheduled sweep that covers "the book became Chinese later".
 * A null detection still stamps language_detected_at, so undetectable
 * books are not retried until their content actually changes.
 *
 * USAGE:
 *   php artisan library:detect-language                       # dry-run, never-attempted books
 *   php artisan library:detect-language --limit=50            # dry-run sample
 *   php artisan library:detect-language --apply               # write
 *   php artisan library:detect-language --book=book_X --apply # one book
 *   php artisan library:detect-language --stale --apply       # the weekly sweep
 */
class DetectBookLanguage extends Command
{
    protected $signature = 'library:detect-language
                            {--book=* : Target specific book id(s)}
                            {--apply : Actually write (default is dry-run)}
                            {--stale : Also re-run books whose content changed since the last attempt}
                            {--limit=0 : Max books to process (0 = all)}';

    protected $description = 'Detect each book\'s language from its content and stamp library.language_detected';

    public function handle(): int
    {
        $apply = (bool) $this->option('apply');
        $stale = (bool) $this->option('stale');
        $limit = (int) $this->option('limit');
        $books = array_filter((array) $this->option('book'));

        if (! $apply) {
            $this->info('DRY RUN — pass --apply to write');
        }

        // Admin connection: operator task over the whole corpus; RLS on the
        // default connection would hide private books.
        $admin = DB::connection('pgsql_admin');
        $admin->disableQueryLog();

        $query = $admin->table('library')
            ->where('book', 'NOT LIKE', '%/%')          // top-level only
            ->where('book', 'NOT LIKE', 'shelf\_%')     // shelf render books
            ->whereNotIn('book', ['stats', 'most-recent', 'most-connected', 'most-lit'])
            ->where('has_nodes', true)
            ->where(fn ($q) => $q->whereNull('encrypted')->orWhere('encrypted', false))
            ->whereRaw("coalesce(raw_json->>'type', '') NOT IN ('shelf', 'user_home')")
            ->orderBy('book');

        if ($books) {
            $query->whereIn('book', $books);
        } elseif ($stale) {
            // Never attempted, OR content changed since the last attempt
            // (library.timestamp is epoch ms; language_detected_at is a tz stamp).
            $query->where(function ($q) {
                $q->whereNull('language_detected_at')
                    ->orWhereRaw('"timestamp" > extract(epoch from language_detected_at) * 1000');
            });
        } else {
            $query->whereNull('language_detected_at');
        }

        if ($limit > 0) {
            $query->limit($limit);
        }

        $rows = $query->get(['book', 'language', 'language_detected']);
        $this->info('Books in scope: '.$rows->count());

        $bar = $this->output->createProgressBar($rows->count());
        $stats = ['detected' => 0, 'unknown' => 0, 'changed' => 0, 'skipped' => 0];

        foreach ($rows as $row) {
            if (! DetectBookLanguageJob::eligible($row->book)) {
                $stats['skipped']++;
                $bar->advance();

                continue;
            }

            $code = BookLanguageDetector::detect(BookTextSampler::sample($row->book));
            $code === null ? $stats['unknown']++ : $stats['detected']++;
            if ($code !== $row->language_detected) {
                $stats['changed']++;
            }

            if ($apply) {
                $admin->table('library')->where('book', $row->book)->update([
                    'language_detected' => $code,
                    'language_detected_at' => now(),
                ]);
            } elseif ($rows->count() <= 100) {
                $bar->clear();
                $this->line(sprintf('  %-40s declared=%-8s detected=%s', $row->book, $row->language ?? '—', $code ?? 'null'));
                $bar->display();
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);
        $this->info(sprintf(
            '%s: %d detected, %d unknown (null), %d changed, %d skipped',
            $apply ? 'Stamped' : 'Would stamp',
            $stats['detected'], $stats['unknown'], $stats['changed'], $stats['skipped'],
        ));
        if (! $apply) {
            $this->warn('Dry run — re-run with --apply to write.');
        }

        return self::SUCCESS;
    }
}
