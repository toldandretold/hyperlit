<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Models\PgFootnote;
use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\PdfProcessor;
use App\Services\DocumentImport\Processors\DocxProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\BillingService;
use App\Mail\ImportCompleteMail;
use App\Mail\ImportFailedMail;
use App\Models\User;
use App\Jobs\PandocConversionJob;
use Illuminate\Support\Facades\DB;

class ProcessDocumentImportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public $timeout = 900;
    public $tries = 1;

    public function __construct(
        private string $bookId,
        private string $extension,
        private ?int $userId,
        private array $formData,
        private array $creatorInfo,
    ) {}

    public function handle(
        EpubProcessor $epubProcessor,
        MarkdownProcessor $markdownProcessor,
        HtmlProcessor $htmlProcessor,
        PdfProcessor $pdfProcessor,
        DocxProcessor $docxProcessor,
        ZipProcessor $zipProcessor,
        FileHelpers $helpers,
        BillingService $billing,
    ): void {
        $path = resource_path("markdown/{$this->bookId}");
        $inputPath = "{$path}/original.{$this->extension}";

        // Folder uploads create main-text.md directly (no original.md)
        if (!File::exists($inputPath) && $this->extension === 'md' && File::exists("{$path}/main-text.md")) {
            $inputPath = "{$path}/main-text.md";
        }

        Log::info('ProcessDocumentImportJob started', [
            'book' => $this->bookId,
            'extension' => $this->extension,
        ]);

        $progressCallback = function (int $pct, string $stage, string $detail = '') use ($path) {
            $this->writeProgress($path, 'processing', $pct, $stage, $detail);
        };

        try {
            // Set progress callbacks on processors that support them
            $epubProcessor->setProgressCallback($progressCallback);
            $markdownProcessor->setProgressCallback($progressCallback);
            $htmlProcessor->setProgressCallback($progressCallback);
            $pdfProcessor->setProgressCallback($progressCallback);

            // Run the appropriate processor
            $this->writeProgress($path, 'processing', 2, 'starting', 'Starting document processing');

            // For docx, run PandocConversionJob synchronously to avoid queue deadlock
            // (dispatching a child job from a running job blocks if there's one worker)
            if (in_array($this->extension, ['doc', 'docx'])) {
                $this->writeProgress($path, 'processing', 10, 'docx_converting', 'Converting document with Pandoc...');
                PandocConversionJob::dispatchSync($this->bookId, $inputPath);
            } else {
                $processor = match ($this->extension) {
                    'epub' => $epubProcessor,
                    'md' => $markdownProcessor,
                    'html', 'htm' => $htmlProcessor,
                    'pdf' => $pdfProcessor,
                    'zip' => $zipProcessor,
                    default => throw new \RuntimeException("Unsupported extension: {$this->extension}"),
                };

                $processor->process($inputPath, $path, $this->bookId);
            }

            // Wait for nodes.json if not yet present
            $nodesPath = "{$path}/nodes.json";
            $attempts = 0;
            while (!File::exists($nodesPath) && $attempts < 15) {
                sleep(2);
                $attempts++;
            }

            if (!File::exists($nodesPath)) {
                throw new \RuntimeException('nodes.json was not created after processing');
            }

            // Save to database
            $this->writeProgress($path, 'processing', 88, 'db_write', 'Saving nodes to database');
            $this->saveNodeChunksToDatabase($path, $this->bookId, $helpers);

            $this->writeProgress($path, 'processing', 92, 'db_footnotes', 'Saving footnotes to database');
            $this->saveFootnotesToDatabase($path, $this->bookId);

            $this->writeProgress($path, 'processing', 95, 'db_references', 'Saving references to database');
            $this->saveReferencesToDatabase($path, $this->bookId);

            // Bill OCR cost for PDF imports
            if ($this->extension === 'pdf' && $this->userId) {
                $user = User::find($this->userId);
                if ($user) {
                    $this->billOcrImport($user, $this->bookId, $path, $billing);
                }
            }

            // Build the result data
            $auditPath = "{$path}/audit.json";
            $auditData = File::exists($auditPath) ? json_decode(File::get($auditPath), true) : null;
            $hasIssues = $auditData && (
                count($auditData['gaps'] ?? []) > 0 ||
                count($auditData['unmatched_refs'] ?? []) > 0 ||
                count($auditData['unmatched_defs'] ?? []) > 0 ||
                count($auditData['duplicates'] ?? []) > 0
            );

            $statsPath = "{$path}/conversion_stats.json";
            $conversionStats = File::exists($statsPath) ? json_decode(File::get($statsPath), true) : null;

            $result = [
                'success' => true,
                'bookId' => $this->bookId,
                'footnoteAudit' => $auditData,
                'hasFootnoteIssues' => $hasIssues,
                'conversionStats' => $conversionStats,
            ];

            // Write complete status
            $this->writeProgress($path, 'complete', 100, 'complete', 'Import complete', [
                'bookId' => $this->bookId,
                'result' => $result,
            ]);

            // Send success email
            if ($this->userId) {
                $user = User::find($this->userId);
                if ($user?->email) {
                    Mail::send(new ImportCompleteMail(
                        $user->email,
                        $this->formData['title'] ?? $this->bookId,
                        $this->bookId,
                        $conversionStats,
                    ));
                }
            }

            Log::info('ProcessDocumentImportJob completed', ['book' => $this->bookId]);

        } catch (\Throwable $e) {
            Log::error('ProcessDocumentImportJob failed', [
                'book' => $this->bookId,
                'error' => $e->getMessage(),
            ]);

            $this->writeProgress($path, 'failed', 0, 'error', $e->getMessage());

            // Send failure email
            if ($this->userId) {
                $user = User::find($this->userId);
                if ($user?->email) {
                    Mail::send(new ImportFailedMail(
                        $user->email,
                        $this->formData['title'] ?? $this->bookId,
                        $this->bookId,
                        $e->getMessage(),
                    ));
                }
            }

            throw $e;
        }
    }

    /**
     * Called by Laravel when the job fails (including timeout via SIGALRM).
     * Ensures progress.json reflects the failure even when handle()'s catch block doesn't execute.
     */
    public function failed(\Throwable $exception): void
    {
        $path = resource_path("markdown/{$this->bookId}");
        $this->writeProgress($path, 'failed', 0, 'error', $exception->getMessage());

        if ($this->userId) {
            $user = User::find($this->userId);
            if ($user?->email) {
                Mail::send(new ImportFailedMail(
                    $user->email,
                    $this->formData['title'] ?? $this->bookId,
                    $this->bookId,
                    $exception->getMessage(),
                ));
            }
        }
    }

    private function writeProgress(string $path, string $status, int $percent, string $stage, string $detail, array $extra = []): void
    {
        $data = array_merge([
            'status' => $status,
            'percent' => $percent,
            'stage' => $stage,
            'detail' => $detail,
            'updated_at' => now()->toIso8601String(),
        ], $extra);

        File::put("{$path}/progress.json", json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    /**
     * All save methods use pgsql_admin to bypass RLS.
     * Queue workers don't run HTTP middleware so RLS session vars are unset.
     */
    private function db(): \Illuminate\Database\Connection
    {
        return DB::connection('pgsql_admin');
    }

    /**
     * Bulk-insert rows using PostgreSQL COPY protocol.
     * 10-50x faster than parameterized INSERT for large datasets.
     */
    private function bulkCopy(string $table, array $columns, array $rows): void
    {
        if (empty($rows)) {
            return;
        }

        $pdo = $this->db()->getPdo();
        $fields = implode(', ', array_map(fn($c) => '"' . $c . '"', $columns));

        // Process in batches of 10000 to limit memory for the formatted lines array
        foreach (array_chunk($rows, 10000) as $batch) {
            $lines = [];
            foreach ($batch as $row) {
                $values = [];
                foreach ($columns as $col) {
                    $val = $row[$col] ?? null;
                    if ($val === null) {
                        $values[] = '\\N';
                    } elseif (is_bool($val)) {
                        $values[] = $val ? 't' : 'f';
                    } else {
                        $val = (string) $val;
                        // COPY text format escaping
                        $val = str_replace('\\', '\\\\', $val);
                        $val = str_replace("\t", '\\t', $val);
                        $val = str_replace("\n", '\\n', $val);
                        $val = str_replace("\r", '\\r', $val);
                        $values[] = $val;
                    }
                }
                $lines[] = implode("\t", $values);
            }
            $pdo->pgsqlCopyFromArray($table, $lines, "\t", '\\N', $fields);
        }
    }

    private function saveNodeChunksToDatabase(string $path, string $bookId, FileHelpers $helpers): void
    {
        $nodesPath = "{$path}/nodes.json";

        if (!File::exists($nodesPath)) {
            Log::warning('nodes.json not found for database save', ['book' => $bookId]);
            return;
        }

        $nodesData = json_decode(File::get($nodesPath), true);
        $totalNodes = count($nodesData);

        // Disable versioning trigger during bulk import — this is fresh data, no history needed
        $this->db()->statement('ALTER TABLE nodes DISABLE TRIGGER nodes_versioning_trigger');

        try {
            // Only delete if this book already has nodes (re-import). Skip for fresh imports.
            if ($this->db()->table('nodes')->where('book', $bookId)->exists()) {
                $this->writeProgress(resource_path("markdown/{$bookId}"), 'processing', 88, 'db_write', "Deleting old nodes");
                $this->db()->table('nodes')->where('book', $bookId)->delete();
                $this->db()->table('nodes')->where('book', 'LIKE', "{$bookId}/%")->delete();
            }

            $insertData = [];
            $now = now();
            $nodesPerChunk = 100;

            foreach ($nodesData as $index => $chunk) {
                $newStartLine = ($index + 1) * 100;
                $chunkIndex = floor($index / $nodesPerChunk);
                $newChunkId = $chunkIndex * 100;
                $nodeId = $helpers->generateNodeId($bookId);
                $content = $helpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

                $rawJson = $chunk;
                $rawJson['startLine'] = $newStartLine;
                $rawJson['chunk_id'] = $newChunkId;
                $rawJson['node_id'] = $nodeId;
                $rawJson['content'] = $content;

                $insertData[] = [
                    'book' => $bookId,
                    'startLine' => $newStartLine,
                    'chunk_id' => $newChunkId,
                    'node_id' => $nodeId,
                    'content' => $content,
                    'footnotes' => json_encode($chunk['footnotes'] ?? []),
                    'plainText' => $chunk['plainText'] ?? '',
                    'type' => $chunk['type'] ?? 'p',
                    'raw_json' => json_encode($rawJson),
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }

            $this->writeProgress(resource_path("markdown/{$bookId}"), 'processing', 89, 'db_write', "Inserting {$totalNodes} nodes");

            $columns = ['book', 'startLine', 'chunk_id', 'node_id', 'content', 'footnotes', 'plainText', 'type', 'raw_json', 'created_at', 'updated_at'];
            $this->bulkCopy('nodes', $columns, $insertData);
        } finally {
            $this->db()->statement('ALTER TABLE nodes ENABLE TRIGGER nodes_versioning_trigger');
        }

        \App\Jobs\QueueBookEmbeddings::dispatch($bookId);

        $renumberedJson = [];
        foreach ($insertData as $record) {
            $renumberedJson[] = json_decode($record['raw_json'], true);
        }
        File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    private function saveFootnotesToDatabase(string $path, string $bookId): void
    {
        $footnotesPath = "{$path}/footnotes.json";
        if (!File::exists($footnotesPath)) {
            return;
        }

        $footnotesData = json_decode(File::get($footnotesPath), true);
        if (empty($footnotesData)) {
            return;
        }

        $library = $this->db()->table('library')->where('book', $bookId)->first();
        if (!$library) {
            Log::warning('Cannot save footnotes: parent library not found', ['book' => $bookId]);
            return;
        }

        $now = now();
        $totalFootnotes = count($footnotesData);
        $this->writeProgress($path, 'processing', 91, 'db_footnotes', "Preparing {$totalFootnotes} footnotes");

        // Build all insert arrays in one pass
        $footnoteInserts = [];
        $libraryInserts = [];
        $nodeInserts = [];
        $enrichedForJson = [];

        foreach ($footnotesData as $footnote) {
            $footnoteId = $footnote['footnoteId'] ?? null;
            $content = $footnote['content'] ?? '';
            if (!$footnoteId) {
                continue;
            }

            $subBookId = SubBookIdHelper::build($bookId, $footnoteId);
            $uuid = (string) Str::uuid();
            $plainText = strip_tags($content);
            $safeHtml = strip_tags($content, '<a><em><strong><i><b>');
            $nodeHtml = '<p data-node-id="' . e($uuid) . '" no-delete-id="please" '
                . 'style="min-height:1.5em;">' . $safeHtml . '</p>';

            $previewNodes = [[
                'book' => $subBookId,
                'chunk_id' => 0,
                'startLine' => 1.0,
                'node_id' => $uuid,
                'content' => $nodeHtml,
                'footnotes' => [],
                'hyperlights' => [],
                'hypercites' => [],
            ]];

            $footnoteInserts[] = [
                'book' => $bookId,
                'footnoteId' => $footnoteId,
                'content' => $content,
                'sub_book_id' => $subBookId,
                'preview_nodes' => json_encode($previewNodes),
                'created_at' => $now,
                'updated_at' => $now,
            ];

            $libraryInserts[] = [
                'book' => $subBookId,
                'creator' => $library->creator,
                'creator_token' => $library->creator_token,
                'visibility' => $library->visibility,
                'listed' => false,
                'title' => "Annotation: {$footnoteId}",
                'type' => 'sub_book',
                'has_nodes' => true,
                'raw_json' => json_encode([]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => $now,
                'created_at' => $now,
            ];

            $nodeInserts[] = [
                'book' => $subBookId,
                'node_id' => $uuid,
                'chunk_id' => 0,
                'startLine' => 1,
                'content' => $nodeHtml,
                'plainText' => $plainText,
                'raw_json' => json_encode([]),
                'created_at' => $now,
                'updated_at' => $now,
            ];

            $enrichedForJson[] = [
                'footnoteId' => $footnoteId,
                'content' => $content,
                'preview_nodes' => $previewNodes,
            ];
        }

        // Only delete if this book already has footnotes (re-import)
        $hasExisting = $this->db()->table('footnotes')->where('book', $bookId)->exists();

        $this->db()->statement('ALTER TABLE nodes DISABLE TRIGGER nodes_versioning_trigger');
        try {
            if ($hasExisting) {
                $this->writeProgress($path, 'processing', 92, 'db_footnotes', "Clearing old footnotes");
                $this->db()->table('footnotes')->where('book', $bookId)->delete();
                $this->db()->table('library')->where('book', 'LIKE', "{$bookId}/Fn%")->where('type', 'sub_book')->delete();
                $this->db()->table('nodes')->where('book', 'LIKE', "{$bookId}/Fn%")->delete();
            }

            // Bulk insert all three tables via COPY
            $this->writeProgress($path, 'processing', 93, 'db_footnotes', "Inserting {$totalFootnotes} footnotes");

            $this->bulkCopy('footnotes', ['book', 'footnoteId', 'content', 'sub_book_id', 'preview_nodes', 'created_at', 'updated_at'], $footnoteInserts);
            $this->bulkCopy('library', ['book', 'creator', 'creator_token', 'visibility', 'listed', 'title', 'type', 'has_nodes', 'raw_json', 'timestamp', 'updated_at', 'created_at'], $libraryInserts);
            $this->bulkCopy('nodes', ['book', 'node_id', 'chunk_id', 'startLine', 'content', 'plainText', 'raw_json', 'created_at', 'updated_at'], $nodeInserts);
        } finally {
            $this->db()->statement('ALTER TABLE nodes ENABLE TRIGGER nodes_versioning_trigger');
        }

        $this->writeProgress($path, 'processing', 94, 'db_footnotes', "Saved {$totalFootnotes} footnotes");

        File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    private function saveReferencesToDatabase(string $path, string $bookId): void
    {
        $referencesPath = "{$path}/references.json";
        if (!File::exists($referencesPath)) {
            return;
        }

        $referencesData = json_decode(File::get($referencesPath), true);
        if (empty($referencesData)) {
            return;
        }

        $this->db()->table('bibliography')->where('book', $bookId)->delete();

        $now = now();
        $insertData = [];
        foreach ($referencesData as $ref) {
            $referenceId = $ref['referenceId'] ?? null;
            if (!$referenceId) {
                continue;
            }

            $insertData[] = [
                'book' => $bookId,
                'referenceId' => $referenceId,
                'source_id' => $ref['source_id'] ?? null,
                'content' => $ref['content'] ?? '',
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        $deduped = [];
        foreach ($insertData as $row) {
            $deduped[$row['referenceId']] = $row;
        }
        $insertData = array_values($deduped);

        $this->bulkCopy('bibliography', ['book', 'referenceId', 'source_id', 'content', 'created_at', 'updated_at'], $insertData);
    }

    private function billOcrImport(User $user, string $bookId, string $path, BillingService $billing): void
    {
        $ocrJson = "{$path}/ocr_response.json";
        if (!File::exists($ocrJson)) {
            return;
        }

        $ocrData = json_decode(File::get($ocrJson), true);
        $totalPages = count($ocrData['pages'] ?? []);
        if ($totalPages <= 0) {
            return;
        }

        $pricing = config('services.llm.pricing.mistral-ocr-latest', []);
        $perKPages = $pricing['per_1k_pages'] ?? null;
        if (!$perKPages) {
            return;
        }

        $cost = $totalPages / 1000 * $perKPages;

        $billing->charge(
            $user,
            round($cost, 4),
            "PDF Import: {$bookId}",
            'ocr',
            [[
                'label' => "OCR ({$totalPages} pages)",
                'category' => 'ocr',
                'quantity' => $totalPages,
                'unit' => 'pages',
                'unit_cost' => $perKPages / 1000,
                'amount' => round($cost, 4),
            ]],
            ['book' => $bookId],
        );
    }
}
