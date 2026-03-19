<?php

namespace App\Console\Commands;

use App\Services\ContentFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;

class CitationOcrCommand extends Command
{
    protected $signature = 'citation:ocr {bookId? : Single library record to OCR} {--survey : List all downloaded PDFs awaiting OCR} {--limit=0 : Max records to process} {--test : Download + OCR a single pdf_url end-to-end for pipeline testing}';
    protected $description = 'Run Mistral OCR on already-downloaded PDFs (use citation:vacuum to download first)';

    public function handle(): int
    {
        if ($this->option('test')) {
            return $this->handleTest();
        }

        if ($this->option('survey')) {
            return $this->handleSurvey();
        }

        $bookId = $this->argument('bookId');
        if (!$bookId) {
            $this->error('bookId is required (or use --survey to list downloaded PDFs)');
            return 1;
        }

        return $this->handleSingle($bookId);
    }

    /**
     * OCR a single book's already-downloaded PDF.
     */
    private function handleSingle(string $bookId): int
    {
        $db = DB::connection('pgsql_admin');

        $libraryRecord = $db->table('library')->where('book', $bookId)->first();
        if (!$libraryRecord) {
            $this->error("Library record not found: {$bookId}");
            return 1;
        }

        $this->info("Title: " . ($libraryRecord->title ?: '(untitled)'));

        $status = $libraryRecord->pdf_url_status ?? null;
        if ($status === 'imported') {
            $this->warn('Already OCR-imported. Skipping.');
            return 0;
        }

        $pdfPath = resource_path("markdown/{$bookId}/original.pdf");
        if (!File::exists($pdfPath)) {
            $this->error("No PDF on disk: {$pdfPath}");
            $this->line('Run citation:vacuum first to download the PDF.');
            return 1;
        }

        $this->line("PDF: {$pdfPath}");
        $this->line("Running OCR pipeline...");
        $this->newLine();

        $startTime = microtime(true);
        $fetchService = app(ContentFetchService::class);
        $result = $fetchService->processLocalPdf($pdfPath, $bookId);
        $elapsed = round(microtime(true) - $startTime, 1);

        $this->printResult($result, $elapsed);

        return $result['status'] === 'failed' ? 1 : 0;
    }

    /**
     * Survey: list and optionally process all downloaded PDFs awaiting OCR.
     */
    private function handleSurvey(): int
    {
        $db = DB::connection('pgsql_admin');
        $limit = (int) $this->option('limit');

        $this->info('OCR survey — downloaded PDFs awaiting processing');
        $this->newLine();

        $records = $db->table('library')
            ->whereNotNull('pdf_url')
            ->where('pdf_url', '!=', '')
            ->select(['book', 'title', 'pdf_url', 'pdf_url_status', 'has_nodes', 'type'])
            ->orderBy('title')
            ->get();

        if ($records->isEmpty()) {
            $this->warn('No library records have pdf_url set.');
            return 0;
        }

        $imported = $records->filter(fn($r) => ($r->pdf_url_status ?? null) === 'imported');
        $downloaded = $records->filter(fn($r) => ($r->pdf_url_status ?? null) === 'downloaded');
        $failed = $records->filter(fn($r) => ($r->pdf_url_status ?? null) && !in_array($r->pdf_url_status, ['downloaded', 'imported']));
        $untried = $records->filter(fn($r) => !($r->pdf_url_status ?? null));

        $this->info("Total with pdf_url: {$records->count()}");
        $this->line("  <fg=green>OCR imported:</>            {$imported->count()}");
        $this->line("  <fg=blue>Downloaded (ready for OCR):</> {$downloaded->count()}");
        $this->line("  <fg=red>Previously failed:</>        {$failed->count()}");
        $this->line("  <fg=yellow>Not yet downloaded:</>       {$untried->count()}");
        $this->newLine();

        if ($downloaded->isEmpty()) {
            $this->warn('No downloaded PDFs awaiting OCR. Run citation:vacuum first.');
            return 0;
        }

        if ($limit > 0) {
            return $this->processDownloaded($downloaded, $limit);
        }

        // List downloaded records
        $this->info('Ready for OCR:');
        $this->newLine();

        foreach ($downloaded as $r) {
            $title = $r->title ?: '(untitled)';
            $type = $r->type ?? '—';
            $this->line("  <fg=blue>{$title}</>");
            $this->line("    Book: {$r->book}");
            $this->line("    Type: {$type}");
            $this->newLine();
        }

        return 0;
    }

    /**
     * Process downloaded PDFs through OCR pipeline.
     */
    private function processDownloaded($downloaded, int $limit): int
    {
        $fetchService = app(ContentFetchService::class);
        $processCount = 0;

        $this->info("Running OCR on downloaded PDFs (limit: {$limit})...");
        $this->newLine();

        foreach ($downloaded as $r) {
            if ($processCount >= $limit) {
                break;
            }

            $title = $r->title ?: '(untitled)';
            $this->line("  <fg=cyan>[" . ($processCount + 1) . "] {$title}</>");

            $pdfPath = resource_path("markdown/{$r->book}/original.pdf");
            if (!File::exists($pdfPath)) {
                $this->line("    <fg=red>PDF missing on disk — skipping</>");
                $this->newLine();
                continue;
            }

            $startTime = microtime(true);
            $result = $fetchService->processLocalPdf($pdfPath, $r->book);
            $elapsed = round(microtime(true) - $startTime, 1);
            $this->printResult($result, $elapsed, '    ');
            $this->newLine();

            $processCount++;
        }

        $this->info("Processed {$processCount} record(s).");
        return 0;
    }

    /**
     * End-to-end test: download + OCR a single PDF to verify the pipeline works.
     */
    private function handleTest(): int
    {
        $db = DB::connection('pgsql_admin');

        $this->info('PDF pipeline test — trying pdf_urls until one works...');
        $this->newLine();

        $records = $db->table('library')
            ->whereNotNull('pdf_url')
            ->where('pdf_url', '!=', '')
            ->whereNull('pdf_url_status')
            ->select(['book', 'title', 'pdf_url'])
            ->orderBy('title')
            ->get();

        if ($records->isEmpty()) {
            $this->warn('No library records have untried pdf_url.');
            return 1;
        }

        $tried = 0;
        $fetchService = app(ContentFetchService::class);

        foreach ($records as $r) {
            $tried++;
            $title = $r->title ?: '(untitled)';
            $this->line("  <fg=cyan>[{$tried}] {$title}</>");
            $this->line("    Trying: {$r->pdf_url}");

            try {
                $response = Http::withHeaders([
                    'User-Agent' => 'Hyperlit/1.0 (mailto:hello@hyperlit.app)',
                ])->timeout(30)->get($r->pdf_url);

                if (!$response->successful()) {
                    $this->line("    <fg=yellow>HTTP {$response->status()} — skipping</>");
                    $this->newLine();
                    continue;
                }

                $body = $response->body();
                $size = strlen($body);

                if ($size < 1000) {
                    $this->line("    <fg=yellow>Too small ({$size} bytes) — skipping</>");
                    $this->newLine();
                    continue;
                }

                if (substr($body, 0, 5) !== '%PDF-') {
                    $this->line("    <fg=yellow>Not a PDF (bad magic bytes) — skipping</>");
                    $this->newLine();
                    continue;
                }

                $sizeFormatted = number_format($size);
                $this->line("    Downloaded ({$sizeFormatted} bytes) — PDF validated");
                $this->line("    Running full OCR pipeline...");
                $this->newLine();

                // Save validated PDF to disk, then process locally
                $pdfDir = resource_path("markdown/{$r->book}");
                if (!File::exists($pdfDir)) {
                    File::makeDirectory($pdfDir, 0755, true);
                }
                $pdfPath = "{$pdfDir}/original.pdf";
                File::put($pdfPath, $body);

                $startTime = microtime(true);
                $result = $fetchService->processLocalPdf($pdfPath, $r->book);
                $elapsed = round(microtime(true) - $startTime, 1);

                $this->printResult($result, $elapsed, '    ');
                $this->newLine();

                if ($result['status'] === 'imported') {
                    $this->info("Test passed — pipeline working end-to-end.");
                    $this->line("  Tried: {$tried} URL(s)");
                    return 0;
                }

                $this->error("Pipeline failed on a valid PDF: {$result['reason']}");
                $this->line("  Tried: {$tried} URL(s)");
                return 1;

            } catch (\Exception $e) {
                $this->line("    <fg=yellow>{$e->getMessage()} — skipping</>");
                $this->newLine();
                continue;
            }
        }

        $this->error("No working pdf_url found after trying {$tried} record(s).");
        return 1;
    }

    private function printResult(array $result, float $elapsed, string $indent = ''): void
    {
        $statusColor = match ($result['status']) {
            'imported' => 'green',
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
