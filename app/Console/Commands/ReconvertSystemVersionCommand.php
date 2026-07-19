<?php

namespace App\Console\Commands;

use App\Jobs\ProcessDocumentImportJob;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\ContentFetchService;
use App\Services\SourceImport\Content\Ar5ivFetcher;
use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Reconvert a SYSTEM-owned auto-version row IN PLACE — the updatability path for
 * the stable-pointer policy. The HTTP reconvert (ImportController::reconvert) is
 * owner-gated and can't reach canonicalizer_v1 rows, so system versions are
 * refreshed here.
 *
 * Because the book id + canonical_source_id + conversion_method are preserved, the
 * canonical's pointer (== this book id) stays valid; the import job's finalize hook
 * re-affirms it. Prior nodes are archived by the nodes_versioning_trigger, so a bad
 * refresh is revertible.
 *
 * Use after improving the ar5iv pipeline; --refetch also pulls upstream ar5iv fixes.
 */
class ReconvertSystemVersionCommand extends Command
{
    protected $signature = 'library:reconvert-system-version
                            {--book= : The system version book id to reconvert}
                            {--canonical= : Resolve the system version from this canonical id}
                            {--refetch : Re-fetch ar5iv HTML before converting (default reuses on-disk original.html)}';

    protected $description = 'Reconvert a system-owned auto-version (ar5iv HTML or an OCR-harvested PDF) in place, preserving its book id and canonical pointer. PDF versions REPLAY the cached OCR — no API cost.';

    public function handle(): int
    {
        $bookId = $this->option('book') ?: null;
        $canonicalId = $this->option('canonical') ?: null;
        $refetch = (bool) $this->option('refetch');

        $admin = DB::connection('pgsql_admin');

        if (!$bookId && $canonicalId) {
            $bookId = $admin->table('canonical_source')->where('id', $canonicalId)->value('auto_version_book');
            if (!$bookId) {
                $this->error("Canonical {$canonicalId} has no auto_version_book.");
                return 1;
            }
        }
        if (!$bookId) {
            $this->error('Provide --book=<id> or --canonical=<id>.');
            return 1;
        }

        $row = $admin->table('library')->where('book', $bookId)->first();
        if (!$row) {
            $this->error("Book {$bookId} not found.");
            return 1;
        }

        // Guard: only touch system-owned rows from the console — never a user's copy.
        if ($row->creator !== AutoVersionResolver::CREATOR) {
            $this->error("Refusing: {$bookId} is not a system row (creator={$row->creator}). Use the owner-gated HTTP reconvert for user books.");
            return 1;
        }

        $path = resource_path("markdown/{$bookId}");
        File::ensureDirectoryExists($path);

        // ar5iv rows: optionally re-fetch fresh so upstream ar5iv improvements apply too.
        if ($refetch && $row->foundation_source === AutoVersionResolver::AR5IV_FOUNDATION_SOURCE) {
            $arxivId = $this->arxivIdFromDoi($row->doi);
            if ($arxivId === null) {
                $this->error("Cannot --refetch: no arXiv id derivable from doi '{$row->doi}'.");
                return 1;
            }
            $this->line("Re-fetching ar5iv for {$arxivId}...");
            $fetch = app(Ar5ivFetcher::class)->fetch(new ArxivId($arxivId), new SourceMetadata([], 'arxiv'), $path);
            if (!$fetch->ok) {
                $this->error("ar5iv re-fetch failed ({$fetch->reason}).");
                return 1;
            }
        }

        // PDF-OCR system versions (canonical_pdf_vacuum / pdf_ocr_auto_raw): reconvert by REPLAYING
        // the cached ocr_response.json through the current pipeline — FREE (no Mistral OCR call) and
        // in-place. processLocalPdf clears stale artifacts, re-runs the pipeline, and saves nodes +
        // footnotes + references, bumping the content timestamp so open readers re-sync. Preferred
        // even if an original.html also exists on disk — the canonical content is the OCR'd PDF.
        $ocrCache = "{$path}/ocr_response.json";
        $pdfPath  = "{$path}/original.pdf";
        $isPdfOcr = str_starts_with((string) ($row->conversion_method ?? ''), 'pdf_ocr')
            || (File::exists($ocrCache) && File::exists($pdfPath));
        if ($isPdfOcr) {
            if (!File::exists($ocrCache) || !File::exists($pdfPath)) {
                $this->error("PDF-OCR book but missing ocr_response.json or original.pdf on disk for {$bookId}.");
                return 1;
            }
            $this->line("Replaying cached OCR for {$bookId} (no API cost)...");
            // Snapshot annotation anchor text BEFORE the pipeline replaces the
            // nodes — processLocalPdf re-anchors hyperlights/hypercites from it.
            app(\App\Services\Annotations\AnnotationSnapshotService::class)->snapshot($bookId, $admin);
            $result = app(ContentFetchService::class)->processLocalPdf($pdfPath, $bookId);
            if (($result['status'] ?? null) === 'imported') {
                $this->info("Reconverted PDF-OCR system version {$bookId}: {$result['reason']} "
                    . "({$result['node_count']} nodes). Canonical pointer preserved.");
                return 0;
            }
            $this->error("PDF-OCR reconvert failed for {$bookId}: " . ($result['reason'] ?? 'unknown'));
            return 1;
        }

        if (!File::exists("{$path}/original.html")) {
            $this->error("No original.html on disk for {$bookId}; re-run with --refetch.");
            return 1;
        }

        // Clear stale conversion outputs + PG content (mirror ImportController::reconvert).
        foreach (['footnotes.json', 'footnotes.jsonl', 'nodes.json', 'nodes.jsonl', 'audit.json', 'references.json', 'intermediate.html'] as $stale) {
            File::delete("{$path}/{$stale}");
        }
        // Snapshot annotation anchor text BEFORE clearing — the import job
        // re-anchors hyperlights/hypercites onto the new nodes from it.
        app(\App\Services\Annotations\AnnotationSnapshotService::class)->snapshot($bookId, $admin);
        $this->clearBookContent($admin, $bookId);

        ProcessDocumentImportJob::dispatch(
            $bookId,
            'html',
            null,
            [],
            ['creator' => AutoVersionResolver::CREATOR, 'creator_token' => null, 'valid' => true],
        );

        $this->info("Reconvert dispatched for system version {$bookId} (canonical pointer preserved).");
        return 0;
    }

    /**
     * Delete the book's content via the shared clearer (BYPASSRLS admin
     * connection — console has no RLS session). Library row, canonical link,
     * conversion_method, hyperlights/hypercites, and annotation sub-books all
     * survive; see App\Services\Import\BookContentClearer.
     */
    private function clearBookContent($admin, string $bookId): void
    {
        app(\App\Services\Import\BookContentClearer::class)->clear($bookId, $admin);
    }

    private function arxivIdFromDoi(?string $doi): ?string
    {
        if (!$doi) return null;
        if (preg_match('#^10\.48550/arxiv\.(.+)$#i', trim($doi), $m)) {
            return $m[1];
        }
        return null;
    }
}
