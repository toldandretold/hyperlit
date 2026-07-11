<?php

namespace App\Console\Commands;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Console\Command;

/**
 * For each canonical_source with a pdf_url and no auto_version_book yet: create a stub
 * library row, fetch + OCR its content, then wire the canonical's auto_version_book.
 * The per-canonical body lives in AutoVersionCreator (shared with the Source Network
 * Harvester job); this command is the CLI loop + reporting around it.
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

    public function handle(AutoVersionCreator $creator): int
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

        foreach ($query->cursor() as $canonical) {
            $this->line("→ {$canonical->id} | " . substr($canonical->title ?? '(untitled)', 0, 60));
            $this->line("   pdf_url: " . substr($canonical->pdf_url, 0, 80));

            if ($dryRun) {
                $this->line("   <fg=yellow>dry-run, skipping</>");
                $stats['skipped']++;
                continue;
            }

            $result = $creator->create($canonical, $skipOcr);

            switch ($result['status']) {
                case 'assigned_existing':
                    $stats['created']++;
                    $this->line("   <fg=green>auto_version_book set (existing converted stub)</>");
                    break;
                case 'assigned':
                    $stats['created']++;
                    $this->line("   <fg=green>auto_version_book set</> ({$result['book']})");
                    break;
                case 'fetch_failed':
                    $stats['vacuum_failed']++;
                    $this->warn("   fetch failed: {$result['reason']}; leaving stub in place");
                    break;
                case 'ocr_failed':
                    $stats['ocr_failed']++;
                    $this->warn("   ocr failed: {$result['reason']}; leaving downloaded PDF, will retry later");
                    break;
                case 'deferred':
                    $stats['deferred']++;
                    $this->line("   <fg=yellow>pointer deferred — stub has no OCR'd content yet</>");
                    break;
                default: // error
                    $stats['errors']++;
                    if (count($errorSamples) < 5) {
                        $errorSamples[] = "{$canonical->id}: " . ($result['reason'] ?? 'unknown error');
                    }
                    $this->error("   error: " . ($result['reason'] ?? 'unknown error'));
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
