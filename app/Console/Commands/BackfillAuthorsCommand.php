<?php

namespace App\Console\Commands;

use App\Services\LibraryCardGenerator;
use App\Services\OpenAlex\WorksApi;
use App\Support\AuthorList;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Repair author lists truncated by the old harvest normalisers, which sliced
 * every external lookup to its first 3 authors ("A; B; C") with no marker —
 * the string read as a complete list and every display and citation built
 * from it was wrong. The FULL structured list survived in
 * canonical_source.authorships (OpenAlex-created canonicals only); this
 * command re-derives the flat strings from it.
 *
 * Phase A: canonical_source.author from authorships jsonb.
 * Phase B: linked library rows — ONLY where library.author provably carries
 *          the machine-truncated 3-name form (or the canonical's own old
 *          value), so hand-edited authors are never clobbered (--force
 *          overrides). Each updated row's bibtex author field is patched too,
 *          but only through a brace-safe path: patchBibtexFields strips braces
 *          from values and its parser stops at the first inner brace, so any
 *          bibtex whose author field contains "{" is left alone and reported.
 * Phase C (--refetch): canonicals with NO structured authorships but a DOI are
 *          re-fetched from OpenAlex; author and authorships are refreshed
 *          (canonical_source has no bibtex column — its citation bibtex is
 *          synthesised at search time), then Phase B runs for their linked rows.
 *
 * Idempotent; dry-run read-only. After a large run: ANALYZE library.
 *
 * Test coverage: tests/Canonical/BackfillAuthorsTest.php
 */
class BackfillAuthorsCommand extends Command
{
    protected $signature = 'library:backfill-authors
                            {--refetch : Refetch canonicals with empty authorships from OpenAlex by DOI}
                            {--force : Overwrite linked library.author even when it does not look machine-truncated}
                            {--limit= : Max canonical rows to process per phase}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = 'Re-derive full "; "-joined author strings from canonical_source.authorships (and optionally OpenAlex) onto canonical and library rows.';

    private int $canonicalsUpdated = 0;
    private int $libraryUpdated = 0;
    private int $bibtexPatched = 0;
    private int $bibtexSkipped = 0;
    private int $refetched = 0;
    private int $refetchMisses = 0;

    public function handle(LibraryCardGenerator $cards, WorksApi $worksApi): int
    {
        $dryRun = (bool) $this->option('dry-run');
        $force  = (bool) $this->option('force');
        $limit  = $this->option('limit') !== null ? max(1, (int) $this->option('limit')) : null;

        $db = DB::connection('pgsql_admin');

        // ---- Phase A + B: canonicals that already hold the structured list.
        $query = $db->table('canonical_source')
            ->whereRaw("jsonb_typeof(authorships) = 'array'")
            ->whereRaw('jsonb_array_length(authorships) > 0')
            ->orderBy('id')
            ->select(['id', 'author', 'authorships']);
        if ($limit !== null) {
            $query->limit($limit);
        }

        $samples = [];
        foreach ($query->cursor() as $row) {
            $names = $this->namesFromAuthorships($row->authorships);
            if ($names === []) {
                continue;
            }
            $full = implode('; ', $names);
            if ($full === (string) $row->author) {
                // Canonical already correct — linked rows may still carry the
                // truncated copy (verifyAndLink wrote it before an earlier run
                // fixed the canonical), so Phase B still runs.
                $this->propagateToLibrary($db, $cards, $row->id, $names, (string) $row->author, $full, $force, $dryRun);
                continue;
            }

            if (count($samples) < 5) {
                $samples[] = [$row->author, $full];
            }
            if (!$dryRun) {
                $db->table('canonical_source')->where('id', $row->id)
                    ->update(['author' => $full, 'updated_at' => now()]);
            }
            $this->canonicalsUpdated++;
            $this->propagateToLibrary($db, $cards, $row->id, $names, (string) $row->author, $full, $force, $dryRun);
        }

        // ---- Phase C: no structured list, but a DOI to refetch by.
        if ($this->option('refetch')) {
            $this->refetchPhase($db, $cards, $worksApi, $force, $dryRun, $limit);
        }

        foreach ($samples as [$before, $after]) {
            $this->line("  {$before}  →  {$after}");
        }
        $suffix = $dryRun ? ' (dry-run — nothing written)' : '';
        $this->info("Canonicals updated: {$this->canonicalsUpdated}{$suffix}");
        $this->info("Library rows updated: {$this->libraryUpdated}");
        $this->info("Bibtex author fields patched: {$this->bibtexPatched}, skipped (brace-protected or unparseable): {$this->bibtexSkipped}");
        if ($this->option('refetch')) {
            $this->info("Refetched from OpenAlex: {$this->refetched}, misses: {$this->refetchMisses}");
        }
        if (!$dryRun && ($this->canonicalsUpdated > 0 || $this->libraryUpdated > 0)) {
            $this->comment('Large run? Consider: ANALYZE library; ANALYZE canonical_source;');
        }

        return 0;
    }

    /** @return list<string> */
    private function namesFromAuthorships(mixed $authorships): array
    {
        $decoded = is_string($authorships) ? json_decode($authorships, true) : $authorships;
        if (!is_array($decoded)) {
            return [];
        }

        $names = [];
        foreach ($decoded as $entry) {
            $name = is_array($entry) ? trim((string) ($entry['name'] ?? '')) : '';
            if ($name !== '') {
                $names[] = $name;
            }
        }

        return $names;
    }

    /**
     * Phase B for one canonical: update linked library rows whose author is
     * provably the machine-written value, and safely patch their bibtex.
     *
     * @param list<string> $names
     */
    private function propagateToLibrary($db, LibraryCardGenerator $cards, string $canonicalId, array $names, string $oldCanonicalAuthor, string $full, bool $force, bool $dryRun): void
    {
        $query = $db->table('library')
            ->where('canonical_source_id', $canonicalId)
            ->where('author', '!=', $full);

        if (!$force) {
            // The forms the truncating writers produced: the first-3 slice, or
            // whatever the canonical row itself said (verifyAndLink copies it).
            $machineForms = array_values(array_unique(array_filter([
                implode('; ', array_slice($names, 0, 3)),
                $oldCanonicalAuthor,
            ], fn ($v) => $v !== '')));
            $query->whereIn('author', $machineForms);
        }

        foreach ($query->cursor() as $row) {
            $update = ['author' => $full];

            if (!empty($row->bibtex)) {
                $patched = $this->safelyPatchBibtexAuthor($cards, (string) $row->bibtex, $full);
                if ($patched !== null) {
                    $update['bibtex'] = $patched;
                    $this->bibtexPatched++;
                } else {
                    $this->bibtexSkipped++;
                }
            }

            if (!$dryRun) {
                $db->table('library')->where('book', $row->book)->update($update);
            }
            $this->libraryUpdated++;
        }
    }

    /**
     * Patch the bibtex author field ONLY when it is safe through the known
     * hazards of patchBibtexFields (its brace-stripper and first-inner-brace
     * parser corrupt protected names). Returns the patched bibtex, or null to
     * leave the entry untouched.
     */
    private function safelyPatchBibtexAuthor(LibraryCardGenerator $cards, string $bibtex, string $full): ?string
    {
        // A brace inside the current author value means protected names —
        // patchBibtexFields would strip/truncate them. Leave those alone.
        if (preg_match('/author\s*=\s*[{"](.*?)["}](?=\s*,|\s*})/si', $bibtex, $m) && str_contains($m[1], '{')) {
            return null;
        }

        $newAuthor = AuthorList::toBibtexField($full);
        $patched = $cards->patchBibtexFields($bibtex, ['author' => $newAuthor]);

        // patchBibtexFields returns its input verbatim when the entry is
        // unparseable — treat "nothing changed" as a skip, not a success.
        return $patched !== $bibtex ? $patched : null;
    }

    private function refetchPhase($db, LibraryCardGenerator $cards, WorksApi $worksApi, bool $force, bool $dryRun, ?int $limit): void
    {
        $query = $db->table('canonical_source')
            ->where(function ($q) {
                $q->whereNull('authorships')
                    ->orWhereRaw("jsonb_typeof(authorships) != 'array'")
                    ->orWhereRaw('jsonb_array_length(authorships) = 0');
            })
            ->whereNotNull('doi')
            ->orderBy('id')
            ->select(['id', 'author', 'doi']);
        if ($limit !== null) {
            $query->limit($limit);
        }

        foreach ($query->cursor() as $row) {
            $normalised = $worksApi->fetchByDoi((string) $row->doi);
            // Polite pacing on top of the client's own rate handling.
            usleep(150_000);

            if ($normalised === null || empty($normalised['author'])) {
                $this->refetchMisses++;
                continue;
            }
            $this->refetched++;

            $names = array_map(
                fn ($a) => trim((string) ($a['name'] ?? '')),
                is_array($normalised['authorships'] ?? null) ? $normalised['authorships'] : []
            );
            $names = array_values(array_filter($names, fn ($n) => $n !== ''));
            $full = $normalised['author'];

            if (!$dryRun) {
                // canonical_source has no bibtex column — its citation bibtex
                // is synthesised at search time from these flat fields.
                $db->table('canonical_source')->where('id', $row->id)->update([
                    'author'      => $full,
                    'authorships' => json_encode($normalised['authorships'] ?? []),
                    'updated_at'  => now(),
                ]);
            }
            if ($full !== (string) $row->author) {
                $this->canonicalsUpdated++;
            }

            $this->propagateToLibrary($db, $cards, $row->id, $names, (string) $row->author, $full, $force, $dryRun);
        }
    }
}
