<?php

namespace App\Services\CitationStudy;

use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Binds text-keyed ground-truth entries to the referenceIds the import
 * actually produced. Run once per book, immediately after import; after
 * binding, all downstream joins are exact id joins.
 *
 * referenceIds cannot be predicted pre-import (process_references.py derives
 * them from a Python set — hash-seed dependent), which is why ground truth is
 * keyed by normalised reference text and bound here.
 */
class GroundTruthBinder
{
    private const FUZZY_FLOOR = 0.85;

    /**
     * Bind a book's ground truth. Returns a summary; throws on any unmatched
     * entry or non-unique binding (a corpus with ambiguous ground truth must
     * not run).
     */
    public function bind(CorpusManifest $manifest, array $book): array
    {
        $slug = $book['slug'];
        $bookId = $manifest->bookIdFor($slug);
        $groundTruth = $manifest->loadGroundTruth($book);

        $rows = DB::connection('pgsql_admin')
            ->table('bibliography')
            ->where('book', $bookId)
            ->get(['referenceId', 'content']);

        // Footnote-style (Chicago) books keep citations in `footnotes`, not
        // `bibliography` — the review keys those claims by footnoteId, so
        // ground truth binds against footnote content instead. Mirrors the
        // pipeline's own footnote-only mode.
        if ($rows->isEmpty()) {
            $rows = DB::connection('pgsql_admin')
                ->table('footnotes')
                ->where('book', $bookId)
                ->get(['footnoteId as referenceId', 'content']);
        }

        if ($rows->isEmpty()) {
            throw new RuntimeException("'{$slug}': no bibliography or footnote rows for {$bookId} — import the book first.");
        }

        $bib = [];
        foreach ($rows as $row) {
            $bib[] = [
                'referenceId' => $row->referenceId,
                'normalized' => GroundTruthText::normalise($row->content),
                'content' => $row->content,
            ];
        }

        $unmatched = [];
        $bindings = [];     // referenceId => gt_id bound at BIB level (claim_snippet null)

        // Bib-level entries bind 1:1 — each DB row is consumable exactly once.
        // Exact-equality assignments happen first so that Chicago short-form
        // footnotes ("Kincaid, On the Origins") can't steal the full first
        // citation's row via containment, and duplicate short forms ("Wolfe,
        // Evaporating Genres, 21" twice) pair off instead of colliding.
        $bibLevel = [];
        $snippetLevel = [];
        foreach ($groundTruth['entries'] as $i => $entry) {
            if (($entry['claim_snippet'] ?? null) === null) {
                $bibLevel[] = $i;
            } else {
                $snippetLevel[] = $i;
            }
        }

        $available = $bib; // rows not yet consumed by a bib-level binding
        $assign = function (int $entryIdx, string $refId) use (&$groundTruth, &$bindings, &$available) {
            $groundTruth['entries'][$entryIdx]['bound_reference_id'] = $refId;
            $bindings[$refId] = $groundTruth['entries'][$entryIdx]['gt_id'];
            $available = array_values(array_filter($available, fn ($r) => $r['referenceId'] !== $refId));
        };

        // Pass 1: exact normalized equality.
        $pending = [];
        foreach ($bibLevel as $entryIdx) {
            $target = $groundTruth['entries'][$entryIdx]['bib_text_normalized'];
            $hit = null;
            foreach ($available as $row) {
                if ($row['normalized'] === $target) {
                    $hit = $row['referenceId'];
                    break;
                }
            }
            if ($hit !== null) {
                $assign($entryIdx, $hit);
            } else {
                $pending[] = $entryIdx;
            }
        }

        // Pass 2: containment, then fuzzy, against the remaining rows only.
        foreach ($pending as $entryIdx) {
            $target = $groundTruth['entries'][$entryIdx]['bib_text_normalized'];
            $refId = $this->matchEntry($target, $available);
            if ($refId === null) {
                $unmatched[] = $groundTruth['entries'][$entryIdx]['gt_id'];
                $groundTruth['entries'][$entryIdx]['bound_reference_id'] = null;
                continue;
            }
            $assign($entryIdx, $refId);
        }

        // Snippet-level entries (swap/distortion) deliberately share their
        // target's referenceId — match against ALL rows, consuming none.
        foreach ($snippetLevel as $entryIdx) {
            $target = $groundTruth['entries'][$entryIdx]['bib_text_normalized'];
            $refId = $this->matchEntry($target, $bib);
            if ($refId === null) {
                $unmatched[] = $groundTruth['entries'][$entryIdx]['gt_id'];
            }
            $groundTruth['entries'][$entryIdx]['bound_reference_id'] = $refId;
        }

        // Bibliography rows with no ground-truth label would silently dilute
        // the intact class — surface them.
        $labelledRefs = array_keys($bindings);
        $unlabelled = array_values(array_filter(
            array_map(fn ($b) => $b['referenceId'], $bib),
            fn ($ref) => !in_array($ref, $labelledRefs, true)
        ));

        $groundTruth['binding'] = [
            'bound_at' => now()->toIso8601String(),
            'book_id' => $bookId,
            'unmatched' => $unmatched,
            'unlabelled_reference_ids' => $unlabelled,
        ];
        $manifest->saveGroundTruth($book, $groundTruth);

        if ($unmatched !== []) {
            throw new RuntimeException(
                "'{$slug}': " . count($unmatched) . ' ground-truth entries did not match any bibliography row: '
                . implode(', ', $unmatched)
            );
        }

        return [
            'slug' => $slug,
            'book_id' => $bookId,
            'bib_rows' => count($bib),
            'bound' => count($groundTruth['entries']),
            'unlabelled_reference_ids' => $unlabelled,
        ];
    }

    private function matchEntry(string $normalizedTarget, array $bib): ?string
    {
        // Exact containment either way first (import may trim or append text).
        foreach ($bib as $row) {
            if ($row['normalized'] === $normalizedTarget
                || ($normalizedTarget !== '' && str_contains($row['normalized'], $normalizedTarget))
                || ($row['normalized'] !== '' && str_contains($normalizedTarget, $row['normalized']))
            ) {
                return $row['referenceId'];
            }
        }
        // Fuzzy fallback: best token-Jaccard above the floor.
        $best = null;
        $bestScore = 0.0;
        foreach ($bib as $row) {
            $score = GroundTruthText::jaccard($normalizedTarget, $row['normalized']);
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $row['referenceId'];
            }
        }
        return $bestScore >= self::FUZZY_FLOOR ? $best : null;
    }
}
