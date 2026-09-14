<?php

namespace App\Services\Citations;

use App\Services\Annotations\AnnotationReattachmentService;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Carry a book's CITATION RESOLUTION across a reconvert.
 *
 * `BookContentClearer` deletes the book's `bibliography` and `footnotes` rows, and the import job
 * re-inserts them from the conversion artifacts with every resolution column NULL. Everything
 * `citation:scan-bibliography` established — which canonical each reference IS, the LLM's parse of
 * the reference string, the foundation-source stub, the verification verdict — is thrown away, and
 * the next hypercite detect buys the whole thing again: an LLM extraction per reference plus the
 * OpenAlex/Crossref waves, minutes per article, for a corpus that is being reconverted precisely
 * because the CONVERTER changed.
 *
 * It was never invalidated, only discarded. A reference resolves on the strength of its own text —
 * "Amin, S. (1982). After the New International Economic Order…" is the same work however the
 * converter rendered the paragraph around it — so the resolution is carried, not repurchased.
 *
 * Same shape and the same two seams as AnnotationSnapshotService / AnnotationReattachmentService:
 * snapshot before the clear (BookReconverter, ReconvertSystemVersionCommand), restore after the new
 * rows land (ProcessDocumentImportJob, ContentFetchService). One class rather than two because the
 * matching here is a key lookup with a text fallback, not a relocation algorithm.
 *
 * Written to resources/markdown/{book}/citation_resolution_snapshot.json — the conversion's own
 * artifact dir, so it travels in `book:export` bundles, and a fresh import (no snapshot) no-ops.
 *
 * Restore reads/writes on pgsql_admin: it runs from queue workers and console commands with no RLS
 * session, where the default connection matches zero rows and the UPDATE silently no-ops.
 */
class ResolutionSnapshotService
{
    public const FILENAME = 'citation_resolution_snapshot.json';

    /**
     * Bibliography columns worth carrying. `content` is NOT among them — the new conversion's
     * rendering of the reference paragraph is the fresher text and is the whole point of the
     * reconvert. It is snapshotted alongside, purely so an entry whose KEY drifted can be
     * re-matched by its text.
     */
    private const BIB_COLUMNS = [
        'canonical_source_id', 'source_id', 'foundation_source',
        'match_method', 'match_score', 'match_diagnostics', 'llm_metadata',
        'reference_match_method', 'reference_verified_at', 'reference_verified_by',
    ];

    /**
     * Footnote resolution columns, all nullable, same gap-fill rule as the bibliography's.
     * `foundation_source` is the load-bearing one: it is what the hypercite detector joins on for a
     * footnote-only book, and without it that book yields ZERO candidates — permanently, because
     * `citation_scans` survives the clear and has already spent such a book's one-scan-ever budget.
     */
    private const FOOTNOTE_COLUMNS = [
        'source_id', 'foundation_source',
        'match_method', 'match_score', 'match_diagnostics', 'llm_metadata',
    ];

    /**
     * Non-nullable boolean verdicts, which cannot use the gap-fill rule: `footnotes.is_citation` is
     * `boolean NOT NULL DEFAULT false`, so a freshly re-inserted row reads `false` rather than
     * "unset" and a null test would never fire. Carried one way only — snapshot true, new row false
     * → restore. The reverse needs no carry (the default already says false) and the reverse rule
     * would let stale data un-classify something this conversion established.
     *
     * @var array<string, list<string>>
     */
    private const FLAG_COLUMNS = [
        'bibliography' => [],
        'footnotes'    => ['is_citation'],
    ];

    /**
     * Snapshot iff the book has any resolution worth carrying. Returns true if written.
     *
     * $db must be a connection that can SEE the rows (admin from console/jobs).
     */
    public function snapshot(string $bookId, ConnectionInterface $db): bool
    {
        $bibliography = $this->resolvedRows($db, $bookId, 'bibliography', 'referenceId', self::BIB_COLUMNS);
        $footnotes = $this->resolvedRows($db, $bookId, 'footnotes', 'footnoteId', self::FOOTNOTE_COLUMNS);

        if ($bibliography === [] && $footnotes === []) {
            return false;
        }

        $dir = resource_path("markdown/{$bookId}");
        File::ensureDirectoryExists($dir);
        File::put($dir . '/' . self::FILENAME, json_encode([
            'book'         => $bookId,
            'taken_at'     => now()->toIso8601String(),
            'bibliography' => $bibliography,
            'footnotes'    => $footnotes,
        ], JSON_INVALID_UTF8_SUBSTITUTE));

        return true;
    }

    /**
     * Restore whatever the snapshot holds onto the freshly-inserted rows, then retire it.
     *
     * @return array{skipped?:string, bibliography?:array<string,int>, footnotes?:array<string,int>}
     */
    public function restore(string $bookId): array
    {
        $path = self::pathFor($bookId);
        if (! $path) {
            return ['skipped' => 'no snapshot'];
        }

        $snapshot = json_decode((string) File::get($path), true) ?: [];
        $db = DB::connection('pgsql_admin');

        $report = [
            'bibliography' => $this->restoreTable(
                $db, $bookId, 'bibliography', 'referenceId',
                $snapshot['bibliography'] ?? [], self::BIB_COLUMNS
            ),
            'footnotes' => $this->restoreTable(
                $db, $bookId, 'footnotes', 'footnoteId',
                $snapshot['footnotes'] ?? [], self::FOOTNOTE_COLUMNS
            ),
        ];

        self::markUsed($bookId);

        return $report;
    }

    /**
     * Rows carrying at least one resolution column.
     *
     * An entry that was never attempted has nothing to carry, and this predicate is deliberately
     * the inverse of CandidateDetector's `needsBibliographyScan` test — restoring exactly these
     * rows is what keeps the next detect from re-running the scan. `match_method = 'no_match'`
     * COUNTS: "we looked and found nothing" is a result, and dropping it re-buys the search that
     * produced it.
     *
     * @param  list<string> $columns
     * @return list<array<string,mixed>>
     */
    private function resolvedRows(
        ConnectionInterface $db,
        string $bookId,
        string $table,
        string $keyColumn,
        array $columns
    ): array {
        $flags = self::FLAG_COLUMNS[$table] ?? [];

        return $db->table($table)
            ->where('book', $bookId)
            ->where(function ($q) use ($columns, $flags) {
                // whereNotNull for the resolution columns, never truthiness: a `match_score` of 0.0
                // and a `match_method` of 'no_match' are both real results. The flags are the
                // exception — they are NOT NULL with a default, so presence is their true value.
                foreach ($columns as $c) {
                    $q->orWhereNotNull($c);
                }
                foreach ($flags as $f) {
                    $q->orWhere($f, true);
                }
            })
            ->get(array_merge([$keyColumn, 'content'], $columns, $flags))
            ->map(fn ($r) => (array) $r)
            ->values()
            ->all();
    }

    /**
     * Write the snapshot's columns back onto the new rows.
     *
     * Matching is two-pass. The key first: `referenceId` is a CONTENT-derived `authoryear` string
     * from `generate_ref_keys`, not a row id, so the same source text produces the same key and the
     * overwhelming majority match exactly. Then, for whatever is left, the normalized reference
     * TEXT — which catches the cases where the key legitimately moved (a glued blob the new
     * converter split, an a/b/c collision suffix that reordered).
     *
     * A column is only written where the NEW row is null. A fresh conversion can legitimately carry
     * its own `source_id` from `references.json`, and stale snapshot data must never win over
     * something this conversion just established.
     *
     * @param  list<array<string,mixed>> $rows
     * @param  list<string>              $columns
     * @return array<string,int>         {restored, by_key, by_text, unmatched}
     */
    private function restoreTable(
        ConnectionInterface $db,
        string $bookId,
        string $table,
        string $keyColumn,
        array $rows,
        array $columns
    ): array {
        $report = ['restored' => 0, 'by_key' => 0, 'by_text' => 0, 'unmatched' => 0];
        if ($rows === []) {
            return $report;
        }

        $flags = self::FLAG_COLUMNS[$table] ?? [];
        $current = $db->table($table)->where('book', $bookId)
            ->get(array_merge([$keyColumn, 'content'], $columns, $flags));

        $byKey = [];
        /** @var array<string, list<object>> $byText */
        $byText = [];
        foreach ($current as $row) {
            $byKey[$row->$keyColumn] = $row;
            $byText[self::fingerprint((string) ($row->content ?? ''))][] = $row;
        }

        // Keys already consumed by an exact match can't also be claimed by the text pass — two
        // snapshot entries whose text normalizes identically (the same work cited twice, keyed
        // a/b) would otherwise both land on the first row.
        $claimed = [];

        $pending = [];
        foreach ($rows as $old) {
            $key = (string) ($old[$keyColumn] ?? '');
            if ($key !== '' && isset($byKey[$key])) {
                $this->applyColumns($db, $bookId, $table, $keyColumn, $byKey[$key], $old, $columns, $flags, $report);
                $claimed[$key] = true;
                $report['by_key']++;

                continue;
            }
            $pending[] = $old;
        }

        foreach ($pending as $old) {
            $fp = self::fingerprint((string) ($old['content'] ?? ''));
            $match = null;
            foreach ($byText[$fp] ?? [] as $row) {
                if (! isset($claimed[$row->$keyColumn])) {
                    $match = $row;
                    break;
                }
            }
            if ($match === null || $fp === '') {
                $report['unmatched']++;

                continue;
            }
            $this->applyColumns($db, $bookId, $table, $keyColumn, $match, $old, $columns, $flags, $report);
            $claimed[$match->$keyColumn] = true;
            $report['by_text']++;
        }

        return $report;
    }

    /**
     * @param  list<string>              $columns nullable resolution columns (gap-fill)
     * @param  list<string>              $flags   NOT NULL booleans (restore-when-true)
     * @param  array<string,mixed>       $old
     * @param  array<string,int>         $report
     */
    private function applyColumns(
        ConnectionInterface $db,
        string $bookId,
        string $table,
        string $keyColumn,
        object $new,
        array $old,
        array $columns,
        array $flags,
        array &$report
    ): void {
        $update = [];
        foreach ($columns as $c) {
            if (($old[$c] ?? null) !== null && ($new->$c ?? null) === null) {
                $update[$c] = $old[$c];
            }
        }
        foreach ($flags as $f) {
            if (! empty($old[$f]) && empty($new->$f)) {
                $update[$f] = true;
            }
        }
        if ($update === []) {
            return;
        }

        $db->table($table)
            ->where('book', $bookId)
            ->where($keyColumn, $new->$keyColumn)
            ->update($update + ['updated_at' => now()]);

        $report['restored']++;
    }

    /** The snapshot path for a book (null if none exists). */
    public static function pathFor(string $bookId): ?string
    {
        $path = resource_path("markdown/{$bookId}/" . self::FILENAME);

        return File::exists($path) ? $path : null;
    }

    /** Rename a consumed snapshot so a retry can still find the material. */
    public static function markUsed(string $bookId): void
    {
        $path = self::pathFor($bookId);
        if ($path) {
            File::move($path, preg_replace('/\.json$/', '.used.json', $path));
        }
    }

    /**
     * Normalized form used to re-match an entry whose key drifted. Reuses the reattachment
     * service's normalizer — the same quote/dash/zero-width/whitespace folding the annotation
     * relocation depends on, so "text that reads the same" means one thing across the codebase.
     */
    private static function fingerprint(string $content): string
    {
        return AnnotationReattachmentService::normalize(strip_tags($content))['text'];
    }
}
