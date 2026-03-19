<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class CitationVacuumCommand extends Command
{
    protected $signature = 'citation:vacuum {bookId? : Library record book ID to fetch content for} {--dry-run : Download HTML but skip processing} {--limit=0 : Max records to fetch (0 = all, used with --survey)} {--survey : List all library records with fetchable URLs}';
    protected $description = 'Fetch content from a URL and import it into the library';

    public function handle(): int
    {
        if ($this->option('survey')) {
            return $this->handleSurvey();
        }

        $bookId = $this->argument('bookId');
        if (!$bookId) {
            $this->error('bookId is required (or use --survey to scan the whole library)');
            return 1;
        }

        return $this->handleSingleFetch($bookId);
    }

    /**
     * Fetch content for a single library record.
     */
    private function handleSingleFetch(string $bookId): int
    {
        $db = DB::connection('pgsql_admin');
        $dryRun = $this->option('dry-run');

        $libraryRecord = $db->table('library')->where('book', $bookId)->first();
        if (!$libraryRecord) {
            $this->error("Library record not found: {$bookId}");
            return 1;
        }

        $this->info("Title: " . ($libraryRecord->title ?: '(untitled)'));

        $url = $libraryRecord->oa_url ?: ($libraryRecord->pdf_url ?: null);
        if (!$url) {
            $this->error('No fetchable URL (no oa_url or pdf_url) on this library record.');
            return 1;
        }

        // For PDF-only records, skip if already fetched/failed
        if (!$libraryRecord->oa_url && ($libraryRecord->pdf_url_status ?? null)) {
            $this->warn("Already processed (pdf_url_status: {$libraryRecord->pdf_url_status}). Skipping.");
            return 0;
        }

        $urlType = $libraryRecord->oa_url ? 'OA' : 'PDF';
        $this->line("{$urlType} URL: {$url}");
        $mode = $dryRun ? 'DRY-RUN' : 'FETCH';
        $this->info("Mode: {$mode}");
        $this->newLine();

        $fetchService = app(ContentFetchService::class);

        if ($dryRun) {
            $result = $fetchService->dryFetch($libraryRecord);
        } else {
            $result = $fetchService->fetch($libraryRecord);
        }

        $this->printFetchResult($result, $libraryRecord);

        return $result['status'] === 'failed' ? 1 : 0;
    }

    /**
     * Survey mode: list fetchable records, optionally fetch from them.
     */
    private function handleSurvey(): int
    {
        $db = DB::connection('pgsql_admin');
        $dryRun = $this->option('dry-run');
        $limit = (int) $this->option('limit');

        $this->info('Library survey — all records with fetchable URLs');
        $this->newLine();

        // Records with oa_url or pdf_url set
        $records = $db->table('library')
            ->where(function ($q) {
                $q->where(function ($q2) {
                    $q2->whereNotNull('oa_url')->where('oa_url', '!=', '');
                })->orWhere(function ($q2) {
                    $q2->whereNotNull('pdf_url')->where('pdf_url', '!=', '');
                });
            })
            ->select(['book', 'title', 'oa_url', 'pdf_url', 'pdf_url_status', 'has_nodes', 'is_oa', 'type'])
            ->orderBy('title')
            ->get();

        if ($records->isEmpty()) {
            $this->warn('No library records have oa_url or pdf_url set.');
            return 0;
        }

        $hasContent = $records->filter(fn($r) => $r->has_nodes);
        $downloaded = $records->filter(fn($r) => ($r->pdf_url_status ?? null) === 'downloaded' && !$r->has_nodes);
        $alreadyFailed = $records->filter(fn($r) => ($r->pdf_url_status ?? null) && ($r->pdf_url_status ?? null) !== 'downloaded' && ($r->pdf_url_status ?? null) !== 'imported');
        $needsContent = $records->filter(fn($r) => !$r->has_nodes && !($r->pdf_url_status ?? null));

        $this->info("Total with URLs: {$records->count()}");
        $this->line("  <fg=green>Already have content:</>    {$hasContent->count()}");
        $this->line("  <fg=blue>Downloaded (awaiting OCR):</> {$downloaded->count()}");
        $this->line("  <fg=red>Previously failed:</>        {$alreadyFailed->count()}");
        $this->line("  <fg=yellow>Fetchable (untried):</>     {$needsContent->count()}");
        $this->newLine();

        // If --dry-run or --limit is set, fetch from survey results
        $shouldFetch = $dryRun || $limit > 0;

        if ($shouldFetch && $needsContent->isNotEmpty()) {
            return $this->fetchFromSurvey($needsContent, $dryRun, $limit);
        }

        // Otherwise just list
        if ($needsContent->isNotEmpty()) {
            $this->info('Fetchable records:');
            $this->newLine();

            foreach ($needsContent as $r) {
                $title = $r->title ?: '(untitled)';
                $url = $r->oa_url ?: $r->pdf_url;
                $urlType = $r->oa_url ? 'OA' : 'PDF';
                $type = $r->type ?? '—';

                $this->line("  <fg=yellow>{$title}</>");
                $this->line("    Book: {$r->book}");
                $this->line("    Type: {$type} | {$urlType}: {$url}");
                $this->newLine();
            }
        }

        if ($hasContent->isNotEmpty()) {
            $this->info('Already have content:');
            $this->newLine();

            foreach ($hasContent as $r) {
                $title = $r->title ?: '(untitled)';
                $this->line("  <fg=green>{$title}</> ({$r->book})");
            }
        }

        return 0;
    }

    /**
     * Fetch content for records found via survey.
     */
    private function fetchFromSurvey($needsContent, bool $dryRun, int $limit): int
    {
        $fetchService = app(ContentFetchService::class);
        $db = DB::connection('pgsql_admin');
        $fetchCount = 0;
        $mode = $dryRun ? 'DRY-RUN' : 'FETCH';

        $this->info("Fetching from survey results ({$mode})...");
        $this->newLine();

        foreach ($needsContent as $r) {
            if ($limit > 0 && $fetchCount >= $limit) {
                break;
            }

            $title = $r->title ?: '(untitled)';
            $this->line("  <fg=cyan>[" . ($fetchCount + 1) . "] {$title}</>");

            // Re-fetch full record for the service
            $libraryRecord = $db->table('library')->where('book', $r->book)->first();
            if (!$libraryRecord) {
                $this->line("    <fg=red>Record not found — skipping</>");
                continue;
            }

            if ($dryRun) {
                $result = $fetchService->dryFetch($libraryRecord);
            } else {
                $result = $fetchService->fetch($libraryRecord);
            }

            $this->printFetchResult($result, $libraryRecord, '    ');
            $this->newLine();

            $fetchCount++;

            // Rate limiting between fetches
            sleep(1);
        }

        $this->info("Processed {$fetchCount} record(s).");
        return 0;
    }

    private function printFetchResult(array $result, object $libraryRecord, string $indent = ''): void
    {
        $statusColor = match ($result['status']) {
            'imported'    => 'green',
            'downloaded'  => 'blue',
            'dry_run'     => 'magenta',
            'skipped'     => 'yellow',
            'failed'      => 'red',
            default       => 'white',
        };

        $this->line("{$indent}<fg={$statusColor}>Status: {$result['status']}</>");
        $this->line("{$indent}  {$result['reason']}");

        if ($result['status'] === 'dry_run' && !empty($result['file_path'])) {
            $size = isset($result['content_length']) ? number_format($result['content_length']) . ' bytes' : '?';
            $type = $result['content_type'] ?? '?';
            $this->line("{$indent}  File: {$result['file_path']}");
            $this->line("{$indent}  Type: {$type} | Size: {$size}");
        }
    }
}
