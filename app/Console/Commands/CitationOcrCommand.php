<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;

class CitationOcrCommand extends Command
{
    protected $signature = 'citation:ocr {bookId? : Single library record to OCR} {--survey : List all records with pdf_url but no content} {--limit=0 : Max records to process} {--dry-run : Download PDF but skip OCR}';
    protected $description = 'Download PDFs and run Mistral OCR to import content into the library';

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

        $pdfUrl = $libraryRecord->pdf_url ?? null;
        if (!$pdfUrl) {
            $this->error('No pdf_url on this library record.');
            return 1;
        }

        $this->line("PDF URL: {$pdfUrl}");
        $mode = $dryRun ? 'DRY-RUN' : 'OCR';
        $this->info("Mode: {$mode}");
        $this->newLine();

        if ($dryRun) {
            return $this->dryRunDownload($pdfUrl, $bookId);
        }

        $startTime = microtime(true);
        $fetchService = app(ContentFetchService::class);
        $result = $fetchService->fetchPdf($pdfUrl, $bookId);
        $elapsed = round(microtime(true) - $startTime, 1);

        $this->printFetchResult($result, $elapsed);

        return $result['status'] === 'failed' ? 1 : 0;
    }

    private function dryRunDownload(string $pdfUrl, string $bookId): int
    {
        $this->line("Downloading PDF...");

        try {
            $response = Http::withHeaders([
                'User-Agent' => 'Hyperlit/1.0 (mailto:hello@hyperlit.app)',
            ])->timeout(60)->get($pdfUrl);

            if (!$response->successful()) {
                $this->error("HTTP {$response->status()} fetching {$pdfUrl}");
                return 1;
            }

            $body = $response->body();
            $path = resource_path("markdown/{$bookId}");

            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $pdfPath = "{$path}/original.pdf";
            File::put($pdfPath, $body);

            $size = number_format(strlen($body));
            $contentType = $response->header('Content-Type') ?? 'unknown';

            $this->line("<fg=magenta>Status: dry_run</>");
            $this->line("  PDF saved (dry-run, OCR skipped)");
            $this->line("  File: {$pdfPath}");
            $this->line("  Type: {$contentType} | Size: {$size} bytes");

            return 0;

        } catch (\Exception $e) {
            $this->error("Download failed: {$e->getMessage()}");
            return 1;
        }
    }

    private function handleSurvey(): int
    {
        $db = DB::connection('pgsql_admin');
        $dryRun = $this->option('dry-run');
        $limit = (int) $this->option('limit');

        $this->info('Library survey — records with pdf_url (no oa_url, no content)');
        $this->newLine();

        // Records with pdf_url set, no oa_url, and no content yet
        $records = $db->table('library')
            ->whereNotNull('pdf_url')
            ->where('pdf_url', '!=', '')
            ->where(function ($q) {
                $q->whereNull('oa_url')->orWhere('oa_url', '');
            })
            ->select(['book', 'title', 'pdf_url', 'has_nodes', 'type'])
            ->orderBy('title')
            ->get();

        if ($records->isEmpty()) {
            $this->warn('No library records have pdf_url set (without oa_url).');
            return 0;
        }

        $hasContent = $records->filter(fn($r) => $r->has_nodes);
        $needsContent = $records->filter(fn($r) => !$r->has_nodes);

        $this->info("Total with pdf_url: {$records->count()}");
        $this->line("  <fg=green>Already have content:</>  {$hasContent->count()}");
        $this->line("  <fg=yellow>Need OCR (no content):</> {$needsContent->count()}");
        $this->newLine();

        // If --dry-run or --limit is set, process from survey results
        $shouldProcess = $dryRun || $limit > 0;

        if ($shouldProcess && $needsContent->isNotEmpty()) {
            return $this->processFromSurvey($needsContent, $dryRun, $limit);
        }

        // Otherwise just list
        if ($needsContent->isNotEmpty()) {
            $this->info('Records needing OCR:');
            $this->newLine();

            foreach ($needsContent as $r) {
                $title = $r->title ?: '(untitled)';
                $type = $r->type ?? '—';

                $this->line("  <fg=yellow>{$title}</>");
                $this->line("    Book: {$r->book}");
                $this->line("    Type: {$type} | PDF: {$r->pdf_url}");
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

    private function processFromSurvey($needsContent, bool $dryRun, int $limit): int
    {
        $fetchService = app(ContentFetchService::class);
        $processCount = 0;
        $mode = $dryRun ? 'DRY-RUN' : 'OCR';

        $this->info("Processing from survey results ({$mode})...");
        $this->newLine();

        foreach ($needsContent as $r) {
            if ($limit > 0 && $processCount >= $limit) {
                break;
            }

            $title = $r->title ?: '(untitled)';
            $this->line("  <fg=cyan>[" . ($processCount + 1) . "] {$title}</>");

            if ($dryRun) {
                $this->dryRunDownload($r->pdf_url, $r->book);
            } else {
                $startTime = microtime(true);
                $result = $fetchService->fetchPdf($r->pdf_url, $r->book);
                $elapsed = round(microtime(true) - $startTime, 1);
                $this->printFetchResult($result, $elapsed, '    ');
            }

            $this->newLine();
            $processCount++;

            // Rate limiting between fetches
            sleep(1);
        }

        $this->info("Processed {$processCount} record(s).");
        return 0;
    }

    private function printFetchResult(array $result, float $elapsed, string $indent = ''): void
    {
        $statusColor = match ($result['status']) {
            'imported' => 'green',
            'dry_run'  => 'magenta',
            'skipped'  => 'yellow',
            'failed'   => 'red',
            default    => 'white',
        };

        $this->line("{$indent}<fg={$statusColor}>Status: {$result['status']}</>");
        $this->line("{$indent}  {$result['reason']}");

        if (isset($result['node_count'])) {
            $this->line("{$indent}  Nodes: {$result['node_count']}");
        }

        $this->line("{$indent}  Time: {$elapsed}s");
    }
}
