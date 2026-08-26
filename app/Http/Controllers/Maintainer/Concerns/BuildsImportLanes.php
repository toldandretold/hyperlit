<?php

namespace App\Http\Controllers\Maintainer\Concerns;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Support\Facades\DB;

/**
 * The article/lane payload shared by /maintainer/journal-import and
 * /maintainer/shelf-import: fold version rows (one per `library` sibling,
 * joined on canonical_source_id so ALL lanes appear) into articles with lanes
 * nested, each lane carrying its acquisition evidence. Extracted verbatim from
 * JournalImportController so the two consoles render one payload shape from
 * one implementation.
 */
trait BuildsImportLanes
{
    /** Lane identity: which foundation_source minted a row, and what to call it in the UI. */
    private static array $laneLabels = [
        'canonical_pdf_vacuum' => 'pdf',
        'journal_html'         => 'html',
        'ar5iv_latexml'        => 'ar5iv',
    ];

    /**
     * Fold canonical×library rows into an articles list with lanes nested.
     * Rows must carry the column set both consoles select (canonical_id,
     * title…, plus the lane's library columns). Lanes with no book or a
     * deleted row are skipped.
     *
     * @param iterable<object> $rows
     * @param array<string, array{count?:int, note?:?string}> $flagged
     * @return array<int, array<string, mixed>>
     */
    private function foldArticles(iterable $rows, array $flagged, ReconvertQueue $queue): array
    {
        $articles = [];
        foreach ($rows as $r) {
            if (! isset($articles[$r->canonical_id])) {
                $articles[$r->canonical_id] = [
                    'canonical_id'   => $r->canonical_id,
                    'title'          => $r->title,
                    'author'         => $r->author,
                    'year'           => $r->year,
                    'volume'         => $r->volume,
                    'issue'          => $r->issue,
                    'doi'            => $r->doi,
                    'cited_by_count' => $r->cited_by_count,
                    'is_oa'          => (bool) $r->is_oa,
                    'fetchable'      => (bool) ($r->oa_url || $r->pdf_url || $r->doi),
                    'version_book'   => $r->auto_version_book,
                    'lanes'          => [],
                ];
            }

            if (! $r->book || ($r->visibility ?? null) === 'deleted') {
                continue;
            }

            $articles[$r->canonical_id]['lanes'][] = [
                'book'              => $r->book,
                'lane'              => self::$laneLabels[$r->foundation_source] ?? ($r->foundation_source ?: 'other'),
                'foundation_source' => $r->foundation_source,
                'conversion_method' => $r->conversion_method,
                'has_nodes'         => (bool) $r->has_nodes,
                'listed'            => (bool) $r->listed,
                'visibility'        => $r->visibility,
                'completeness'      => $r->completeness,
                'completeness_reason' => $r->completeness_reason,
                'pdf_url_status'    => $r->pdf_url_status,
                'is_version'        => $r->book === $r->auto_version_book,
                // Has content, is not public, and cannot make itself public: the authenticity gate
                // did not confirm it, so no sweep will ever promote it. Distinct from a plain
                // `unlisted` sibling, which is unlisted precisely BECAUSE another lane won — that
                // one is correct and needs nobody. This one is waiting on a person.
                'needs_approval'    => (bool) $r->has_nodes
                    && ! $r->listed
                    && $r->book !== $r->auto_version_book
                    && ! in_array($r->conversion_method, AutoVersionResolver::SYSTEM_CONVERSION_METHODS, true),
                'open_flags'        => $flagged[$r->book]['count'] ?? 0,
                'maintainer_note'   => $flagged[$r->book]['note'] ?? null,
                'artifacts'         => $queue->artifactsFor($r->book),
                'fetch_trace'       => $this->fetchTrace($r->book),
                'created_at'        => $r->lane_created_at,
            ];
        }

        return array_values($articles);
    }

    /**
     * Open conversion-flag counts keyed by book. Default connection, matching
     * ReconvertQueue::openFlagsGrouped — flags are not RLS'd, and reading them through the
     * admin connection here would only diverge from how the rest of the app sees them.
     */
    private function openFlagCountsByBook(): array
    {
        $out = [];
        // The maintainer's own note comes back with the count: it is written into the open flags'
        // details and rides the case bundle into dev, so the page has to be able to show what is
        // already there rather than silently offering an empty box over an existing note.
        foreach (DB::table('conversion_flags')->where('status', 'open')->get(['book', 'details']) as $flag) {
            $details = is_array($flag->details) ? $flag->details : (json_decode((string) $flag->details, true) ?: []);
            $out[$flag->book]['count'] = ($out[$flag->book]['count'] ?? 0) + 1;
            $out[$flag->book]['note'] ??= $details['maintainer_note'] ?? null;
        }

        return $out;
    }

    /**
     * The lane's acquisition evidence: which OA copy won, what the body gate said, how complete
     * the copy looked. Written on every fetch() exit path but surfaced nowhere until now.
     */
    private function fetchTrace(string $book): ?array
    {
        $path = resource_path("markdown/{$book}/fetch_trace.json");
        if (! is_file($path)) {
            return null;
        }

        $data = json_decode((string) file_get_contents($path), true);
        if (! is_array($data)) {
            return null;
        }

        return array_intersect_key($data, array_flip([
            'candidates', 'won_host', 'won_source', 'won_version', 'won_license',
            'completeness', 'completeness_reason', 'body_verdict', 'body_reason', 'traced_at',
        ]));
    }
}
