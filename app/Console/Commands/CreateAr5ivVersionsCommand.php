<?php

namespace App\Console\Commands;

use App\Jobs\ProcessDocumentImportJob;
use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\SystemVersionMinter;
use App\Services\SourceImport\Content\Ar5ivFetcher;
use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;

/**
 * For each arXiv canonical_source (DOI under 10.48550/arXiv.*) with no
 * auto_version_book yet: mint a SYSTEM-owned library row, fetch arXiv's own
 * ar5iv/LaTeXML rendering, and dispatch the HTML conversion pipeline. The
 * canonical's auto_version_book is wired by the import job's pointer-sync hook
 * once nodes land (conversion_method='ar5iv_html' is a SYSTEM_CONVERSION_METHOD).
 *
 * The sibling of `library:create-auto-versions` (PDF vacuum+OCR) for arXiv works,
 * whose genuine machine copy is ar5iv HTML, not an OCR'd PDF.
 *
 * See app/Services/CanonicalVersions/README.md.
 */
class CreateAr5ivVersionsCommand extends Command
{
    protected $signature = 'library:create-ar5iv-versions
                            {--canonical= : Process one canonical_source row by id}
                            {--limit=0 : Max canonicals to process (0 = unlimited)}
                            {--dry-run : Print plan only, no writes, no fetches}
                            {--sleep=2 : Seconds to sleep between canonicals}';

    protected $description = 'For each arXiv canonical with no auto_version_book, mint a system ar5iv version: fetch ar5iv HTML and run the conversion pipeline, wiring canonical.auto_version_book.';

    public function handle(SystemVersionMinter $minter): int
    {
        $canonicalId = $this->option('canonical') ?: null;
        $limit = (int) $this->option('limit');
        $dryRun = (bool) $this->option('dry-run');
        $sleep = (int) $this->option('sleep');

        // arXiv works are identified by their arXiv DOI (10.48550/arXiv.<id>).
        $query = CanonicalSource::query()
            ->whereRaw("LOWER(doi) LIKE '10.48550/arxiv.%'")
            ->whereNull('auto_version_book');

        if ($canonicalId) {
            $query->where('id', $canonicalId);
        }

        $total = (clone $query)->count();
        $this->info("arXiv canonicals eligible for ar5iv auto-version: {$total}" . ($dryRun ? ' (dry-run)' : ''));
        if ($total === 0) return 0;

        if ($limit > 0) $query->limit($limit);

        $stats = ['dispatched' => 0, 'wired_existing' => 0, 'no_arxiv_id' => 0, 'fetch_failed' => 0, 'skipped' => 0, 'errors' => 0];
        $errorSamples = [];
        $resolver = new AutoVersionResolver();

        foreach ($query->cursor() as $canonical) {
            $this->line("→ {$canonical->id} | " . substr($canonical->title ?? '(untitled)', 0, 60));
            $this->line("   doi: {$canonical->doi}");

            if ($dryRun) {
                $this->line("   <fg=yellow>dry-run, skipping</>");
                $stats['skipped']++;
                continue;
            }

            try {
                // An eligible ar5iv (or other system) row may already exist from a
                // prior run — wire the pointer with zero fetching.
                $existing = $minter->findExistingSystemRow($canonical, AutoVersionResolver::AR5IV_FOUNDATION_SOURCE);
                if ($existing && $existing->has_nodes) {
                    if ($resolver->assign($canonical)) {
                        $stats['wired_existing']++;
                        $this->line("   <fg=green>auto_version_book set (existing ar5iv row)</>");
                    }
                    if ($sleep > 0) sleep($sleep);
                    continue;
                }

                $arxivId = $this->arxivIdFromDoi($canonical->doi);
                if ($arxivId === null) {
                    $stats['no_arxiv_id']++;
                    $this->warn("   could not derive arXiv id from doi; skipping");
                    continue;
                }

                $systemBookId = $existing->book ?? $minter->mintSystemRow(
                    $canonical,
                    AutoVersionResolver::AR5IV_CONVERSION_METHOD,
                    AutoVersionResolver::AR5IV_FOUNDATION_SOURCE,
                );
                $this->line("   system row: {$systemBookId}");

                // Fetch ar5iv HTML into the system book's own dir.
                $dir = resource_path("markdown/{$systemBookId}");
                File::ensureDirectoryExists($dir);
                $fetch = app(Ar5ivFetcher::class)->fetch(new ArxivId($arxivId), new SourceMetadata([], 'arxiv'), $dir);
                if (!$fetch->ok) {
                    $stats['fetch_failed']++;
                    $this->warn("   ar5iv fetch failed ({$fetch->reason}); leaving stub for retry");
                    continue;
                }

                // Convert via the shared pipeline. userId=null skips billing/email;
                // the finalize hook wires auto_version_book once nodes land.
                ProcessDocumentImportJob::dispatch(
                    $systemBookId,
                    'html',
                    null,
                    [
                        'title'  => $canonical->title,
                        'author' => $canonical->author,
                        'year'   => $canonical->year,
                        'url'    => (new ArxivId($arxivId))->url(),
                    ],
                    ['creator' => AutoVersionResolver::CREATOR, 'creator_token' => null, 'valid' => true],
                );
                $stats['dispatched']++;
                $this->line("   <fg=green>conversion dispatched</>");
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
     * Recover the arXiv id from an arXiv DOI: '10.48550/arXiv.2511.04683' → '2511.04683'.
     * Case-insensitive on the prefix (OpenAlex lowercases DOIs).
     */
    private function arxivIdFromDoi(?string $doi): ?string
    {
        if (!$doi) return null;
        if (preg_match('#^10\.48550/arxiv\.(.+)$#i', trim($doi), $m)) {
            return $m[1];
        }
        return null;
    }
}
