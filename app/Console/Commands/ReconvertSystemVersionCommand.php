<?php

namespace App\Console\Commands;

use App\Jobs\ProcessDocumentImportJob;
use App\Services\CanonicalVersions\AutoVersionResolver;
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

    protected $description = 'Reconvert a system-owned auto-version (e.g. an ar5iv version) in place, preserving its book id and canonical pointer.';

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

        if (!File::exists("{$path}/original.html")) {
            $this->error("No original.html on disk for {$bookId}; re-run with --refetch.");
            return 1;
        }

        // Clear stale conversion outputs + PG content (mirror ImportController::reconvert).
        foreach (['footnotes.json', 'footnotes.jsonl', 'nodes.json', 'nodes.jsonl', 'audit.json', 'references.json', 'intermediate.html'] as $stale) {
            File::delete("{$path}/{$stale}");
        }
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
     * Delete the book's content (nodes/footnotes/bibliography) + footnote sub-books,
     * via the BYPASSRLS admin connection (console has no RLS session). The library
     * row itself, its canonical link, and conversion_method are left intact so the
     * pointer stays valid through the rewrite.
     */
    private function clearBookContent($admin, string $bookId): void
    {
        $admin->table('nodes')->where('book', $bookId)->delete();
        $admin->table('footnotes')->where('book', $bookId)->delete();
        $admin->table('bibliography')->where('book', $bookId)->delete();
        $admin->table('nodes')->where('book', 'LIKE', "{$bookId}/%")->delete();
        $admin->table('library')->where('book', 'LIKE', "{$bookId}/%")->where('type', 'sub_book')->delete();
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
