<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Console\Command;

/**
 * The maintainer's queue in the terminal: every open conversion_flag (user
 * reports + library:flag-sweep) with artifacts + a suggested action, plus
 * ready-made command lines for the loop. The list logic itself lives in
 * App\Services\Conversion\ReconvertQueue (shared with the /maintainer page).
 *
 *   php artisan library:reconvert-queue                        # list
 *   php artisan library:reconvert-queue --resolve=book_x --resolution=reconverted
 *   php artisan library:reconvert-queue --dismiss=book_x
 */
class ReconvertQueueCommand extends Command
{
    protected $signature = 'library:reconvert-queue
        {--resolve= : Book id whose open flags to resolve}
        {--resolution=reconverted : Resolution when resolving (reconverted|refetched|dismissed)}
        {--dismiss= : Book id whose open flags to dismiss}';

    protected $description = 'List open conversion flags with artifacts + suggested action';

    public function handle(ReconvertQueue $queue): int
    {
        if ($book = $this->option('dismiss')) {
            $n = ConversionFlag::resolveFor($book, 'dismissed');
            $this->info("Dismissed {$n} open flag(s) for {$book}.");
            return self::SUCCESS;
        }

        if ($book = $this->option('resolve')) {
            $resolution = (string) $this->option('resolution');
            if (!in_array($resolution, ['reconverted', 'refetched', 'dismissed'], true)) {
                $this->error("Unknown --resolution '{$resolution}' (reconverted|refetched|dismissed).");
                return self::FAILURE;
            }
            $n = ConversionFlag::resolveFor($book, $resolution);
            $this->info("Resolved {$n} open flag(s) for {$book} as {$resolution}.");
            return self::SUCCESS;
        }

        $entries = $queue->openFlagsGrouped();
        if ($entries === []) {
            $this->info('Queue empty — no open conversion flags.');
            return self::SUCCESS;
        }

        $flagCount = 0;
        foreach ($entries as $entry) {
            $bookId = $entry['book'];
            $this->newLine();
            $this->line(sprintf('<options=bold>%s</> — %s', $bookId, mb_substr($entry['title'], 0, 70)));
            foreach ($entry['flags'] as $flag) {
                $flagCount++;
                $this->line(sprintf(
                    '  [%s ×%d] %s',
                    $flag['source'],
                    $flag['report_count'],
                    mb_substr((string) ($flag['reason'] ?? json_encode($flag['details']['issueTypes'] ?? [])), 0, 90),
                ));
            }
            $this->line(sprintf(
                '  method=%s  completeness=%s  artifacts=[%s]',
                $entry['conversion_method'] ?? '—',
                $entry['completeness'] ?? '—',
                implode(', ', $entry['artifacts']) ?: 'none',
            ));
            $this->line("  → suggested: <options=bold>{$entry['suggested']}</>");
            $this->line('  triage:     ' . rtrim(config('app.url'), '/') . "/maintainer?book={$bookId}");
            $this->line("  pull case:  tests/conversion/pull_case.sh {$bookId} --corpus");
            $this->line(match ($entry['suggested']) {
                'reconvert' => "  reconvert:  php artisan library:reconvert-system-version {$bookId}",
                're-fetch'  => '  re-fetch:   clear pdf_url_status + ocr cache, then reconvert (fetch ladder re-runs)',
                default     => "  inspect:    php artisan book:export {$bookId}  (then open locally)",
            });
            $this->line("  resolve:    php artisan library:reconvert-queue --resolve={$bookId} --resolution=reconverted");
        }

        $this->newLine();
        $this->info(sprintf('%d open flag(s) across %d book(s).', $flagCount, count($entries)));

        return self::SUCCESS;
    }
}
