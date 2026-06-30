<?php

namespace App\Console\Commands;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\SystemVersionMinter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;

/**
 * For each canonical_source with a pdf_url and no auto_version_book yet: create a stub
 * library row, run citation:vacuum + citation:ocr against it, then wire the canonical's
 * auto_version_book via AutoVersionResolver (which requires has_nodes=true — a
 * vacuumed-but-unOCR'd stub never gets the pointer, so --skip-ocr runs stay eligible
 * for a later OCR pass).
 *
 * See docs/canonical-sources.md and app/Services/CanonicalVersions/README.md.
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

    // Provenance constants live on the resolver (the domain home); aliased
    // here for readability.
    public const CREATOR = AutoVersionResolver::CREATOR;
    public const FOUNDATION_SOURCE = AutoVersionResolver::FOUNDATION_SOURCE;
    public const CONVERSION_METHOD = AutoVersionResolver::CONVERSION_METHOD;

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

        $stats = ['created' => 0, 'vacuum_failed' => 0, 'ocr_failed' => 0, 'deferred' => 0, 'skipped' => 0, 'errors' => 0];
        $errorSamples = [];
        $resolver = new AutoVersionResolver();
        $minter = new SystemVersionMinter();

        foreach ($query->cursor() as $canonical) {
            $this->line("→ {$canonical->id} | " . substr($canonical->title ?? '(untitled)', 0, 60));
            $this->line("   pdf_url: " . substr($canonical->pdf_url, 0, 80));

            if ($dryRun) {
                $this->line("   <fg=yellow>dry-run, skipping</>");
                $stats['skipped']++;
                continue;
            }

            try {
                // If an eligible (already-OCR'd) version exists from a previous
                // run, the resolver wires the pointer without any fetching.
                if ($resolver->assign($canonical)) {
                    $stats['created']++;
                    $this->line("   <fg=green>auto_version_book set (existing OCR'd stub)</>");
                    if ($sleep > 0) sleep($sleep);
                    continue;
                }

                $existingStub = $minter->findExistingSystemRow($canonical, self::FOUNDATION_SOURCE);
                if ($existingStub) {
                    $newBookId = $existingStub->book;
                    $this->line("   reusing existing stub: {$newBookId}");
                } else {
                    $newBookId = $minter->mintSystemRow($canonical, self::CONVERSION_METHOD, self::FOUNDATION_SOURCE);
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

                // Step 3: Wire the pointer via the resolver. It requires
                // has_nodes=true, so with --skip-ocr the pointer stays NULL
                // and the canonical remains eligible for a later OCR run
                // (previously the pointer was set on a contentless stub,
                // which silently excluded it from every future sweep).
                if ($resolver->assign($canonical)) {
                    $stats['created']++;
                    $this->line("   <fg=green>auto_version_book set</>");
                } else {
                    $stats['deferred']++;
                    $this->line("   <fg=yellow>pointer deferred — stub has no OCR'd content yet</>");
                }
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
}
