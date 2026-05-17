<?php

namespace App\Console\Commands;

use App\Models\CanonicalSource;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * For each canonical_source with a pdf_url and no auto_version_book yet: create a stub
 * library row, run citation:vacuum + citation:ocr against it, then wire the canonical's
 * auto_version_book to point at the resulting "auto-raw" version.
 *
 * See docs/canonical-sources.md.
 */
class CreateAutoVersionsCommand extends Command
{
    protected $signature = 'library:create-auto-versions
                            {--canonical= : Process one canonical_source row by id}
                            {--limit=0 : Max canonicals to process (0 = unlimited)}
                            {--skip-ocr : Vacuum the PDF but do not run OCR}
                            {--dry-run : Print plan only, no writes, no fetches}
                            {--sleep=2 : Seconds to sleep between canonicals}';

    protected $description = 'For each canonical_source with a pdf_url and no auto_version_book, create a system-generated version: vacuum the PDF, run Mistral OCR, link the new library row back as canonical.auto_version_book.';

    public const CREATOR = 'canonicalizer_v1';
    public const FOUNDATION_SOURCE = 'canonical_pdf_vacuum';
    public const CONVERSION_METHOD = 'pdf_ocr_auto_raw';

    public function handle(): int
    {
        $canonicalId = $this->option('canonical') ?: null;
        $limit = (int) $this->option('limit');
        $skipOcr = (bool) $this->option('skip-ocr');
        $dryRun = (bool) $this->option('dry-run');
        $sleep = (int) $this->option('sleep');

        $query = CanonicalSource::query()
            ->whereNotNull('pdf_url')
            ->where('pdf_url', '!=', '')
            ->whereNull('auto_version_book');

        if ($canonicalId) {
            $query->where('id', $canonicalId);
        }

        $total = (clone $query)->count();
        $this->info("Canonicals eligible for auto-version: {$total}" . ($dryRun ? ' (dry-run)' : ''));
        if ($total === 0) return 0;

        if ($limit > 0) $query->limit($limit);

        $stats = ['created' => 0, 'vacuum_failed' => 0, 'ocr_failed' => 0, 'skipped' => 0, 'errors' => 0];
        $errorSamples = [];

        foreach ($query->cursor() as $canonical) {
            $this->line("→ {$canonical->id} | " . substr($canonical->title ?? '(untitled)', 0, 60));
            $this->line("   pdf_url: " . substr($canonical->pdf_url, 0, 80));

            if ($dryRun) {
                $this->line("   <fg=yellow>dry-run, skipping</>");
                $stats['skipped']++;
                continue;
            }

            try {
                $existingStub = $this->findExistingStub($canonical);
                if ($existingStub) {
                    $newBookId = $existingStub->book;
                    $this->line("   reusing existing stub: {$newBookId}");

                    // If the stub already has nodes, just wire the pointer and move on.
                    if ($existingStub->has_nodes) {
                        $canonical->auto_version_book = $newBookId;
                        $canonical->save();
                        $stats['created']++;
                        $this->line("   <fg=green>auto_version_book set (existing OCR'd stub)</>");
                        if ($sleep > 0) sleep($sleep);
                        continue;
                    }
                } else {
                    $newBookId = $this->createStubLibraryRow($canonical);
                    $this->line("   created stub library row: {$newBookId}");
                }

                // Step 1: Vacuum — download the PDF
                $this->line("   running citation:vacuum...");
                $vacuumExit = Artisan::call('citation:vacuum', ['bookId' => $newBookId]);
                if ($vacuumExit !== 0) {
                    $this->warn("   vacuum failed (exit {$vacuumExit}); leaving stub in place");
                    $stats['vacuum_failed']++;
                    continue;
                }
                $this->line("   vacuum ok");

                // Step 2: OCR (optional)
                if (!$skipOcr) {
                    $this->line("   running citation:ocr...");
                    $ocrExit = Artisan::call('citation:ocr', ['bookId' => $newBookId]);
                    if ($ocrExit !== 0) {
                        $this->warn("   ocr failed (exit {$ocrExit}); leaving downloaded PDF, will retry later");
                        $stats['ocr_failed']++;
                        continue;
                    }
                    $this->line("   ocr ok");
                }

                // Step 3: Wire the canonical to its new auto-version
                $canonical->auto_version_book = $newBookId;
                $canonical->save();

                $stats['created']++;
                $this->line("   <fg=green>auto_version_book set</>");
            } catch (\Throwable $e) {
                $stats['errors']++;
                if (count($errorSamples) < 5) {
                    $errorSamples[] = "{$canonical->id}: " . $e->getMessage();
                }
                $this->error("   error: " . $e->getMessage());
            }

            if ($sleep > 0) sleep($sleep);
        }

        $this->newLine();
        $this->info('Summary:');
        foreach ($stats as $k => $v) {
            $this->line(sprintf('  %-15s %d', $k, $v));
        }
        if (!empty($errorSamples)) {
            $this->warn('Sample errors:');
            foreach ($errorSamples as $e) $this->line('  ' . $e);
        }

        return 0;
    }

    /**
     * Find an existing auto-version stub for this canonical, if one was created on a
     * previous run that didn't finish OCR. Detected by foundation_source + canonical_source_id.
     */
    private function findExistingStub(CanonicalSource $canonical): ?object
    {
        return DB::connection('pgsql_admin')
            ->table('library')
            ->where('canonical_source_id', $canonical->id)
            ->where('foundation_source', self::FOUNDATION_SOURCE)
            ->select('book', 'has_nodes', 'pdf_url_status')
            ->first();
    }

    /**
     * Create a library row that points at the canonical and carries the canonical's
     * pdf_url so citation:vacuum can fetch it. Returns the new book id.
     */
    private function createStubLibraryRow(CanonicalSource $canonical): string
    {
        $bookId = (string) Str::uuid();
        $now = now();

        DB::connection('pgsql_admin')->table('library')->insert([
            'book'                   => $bookId,
            'title'                  => $canonical->title,
            'author'                 => $canonical->author,
            'year'                   => $canonical->year,
            'journal'                => $canonical->journal,
            'publisher'              => $canonical->publisher,
            'abstract'               => $canonical->abstract,
            'type'                   => $canonical->type,
            'language'               => $canonical->language,
            'doi'                    => $canonical->doi,
            'openalex_id'            => $canonical->openalex_id,
            'is_oa'                  => $canonical->is_oa,
            'oa_status'              => $canonical->oa_status,
            'oa_url'                 => $canonical->oa_url,
            'pdf_url'                => $canonical->pdf_url,
            'work_license'           => $canonical->work_license,
            'cited_by_count'         => $canonical->cited_by_count,
            'has_nodes'              => false,
            'visibility'             => 'public',
            'listed'                 => false,
            'creator'                => self::CREATOR,
            'creator_token'          => null,
            'foundation_source'      => self::FOUNDATION_SOURCE,
            'conversion_method'      => self::CONVERSION_METHOD,
            'is_publisher_uploaded'  => false,
            'canonical_source_id'    => $canonical->id,
            'canonical_match_score'  => 1.0,
            'canonical_match_method' => 'auto_version_creation',
            'canonical_matched_at'   => $now,
            'canonical_matched_by'   => self::CREATOR,
            'raw_json'               => json_encode([
                'auto_version' => true,
                'source'       => 'canonical_pdf_vacuum',
                'canonical_id' => $canonical->id,
            ]),
            'created_at'             => $now,
            'updated_at'             => $now,
        ]);

        return $bookId;
    }
}
