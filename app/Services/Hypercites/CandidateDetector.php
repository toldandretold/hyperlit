<?php

namespace App\Services\Hypercites;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\CitationReview\Phases\CitationParser;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Walk one collection's citation graph (a journal or a public shelf — see
 * DetectionScope) and persist `hypercite_candidates`: every in-text citation
 * in a citing book whose cited work we ALSO hold, with quote detection
 * (QuoteDetector) and an attempted location of the quote in the cited text
 * (QuoteLocator). The /maintainer/hypercites console reviews the result;
 * HyperciteMinter applies approvals.
 *
 * Match scope: cited works match against ANY held book (not just the
 * collection) — that is what makes the most-cited tab's "import this source"
 * pay off on the very next detect. `is_internal` (cited work is also in the
 * collection) is stamped per candidate for filtering.
 *
 * Runs on a queue worker (DetectHyperciteCandidatesJob). All reads/writes via
 * pgsql_admin — worker context has no RLS session.
 */
class CandidateDetector
{
    public function __construct(
        private CitationParser $parser,
        private QuoteDetector $quotes,
        private QuoteLocator $locator,
        private BestVersionService $versions,
    ) {}

    /**
     * @return array<string,int> counts for the run row
     */
    public function detect(DetectionScope $scope, string $runId): array
    {
        $db = DB::connection('pgsql_admin');

        $counts = [
            'articles' => 0, 'scanned' => 0,
            'pairs' => 0, 'candidates' => 0, 'with_quote' => 0,
            'matched' => 0, 'no_match' => 0, 'skipped_footnote_only' => 0,
        ];

        $citing = $scope->citingEntries($this->versions);

        // Cache of cited-book node lists (one cited work is typically cited by
        // many books of the same collection).
        $citedNodesCache = [];

        foreach ($citing as $entry) {
            $citingBook = $entry['book'];
            $citingCanonicalId = $entry['canonical_id'];
            $counts['articles']++;

            $this->step($db, $runId, "scanning {$citingBook} — " . Str::limit((string) ($entry['title'] ?? ''), 60), $counts);

            // ── Ensure the bibliography has been resolved to canonicals ──
            if (! $db->table('bibliography')->where('book', $citingBook)->exists()
                && ! $db->table('footnotes')->where('book', $citingBook)->where('is_citation', true)->exists()) {
                $exit = Artisan::call('citation:scan-bibliography', ['target' => $citingBook]);
                if ($exit !== 0) {
                    Log::warning('hypercites: scan-bibliography failed', ['book' => $citingBook, 'exit' => $exit]);
                    continue;
                }
                $counts['scanned']++;
            }

            // ── refId → held cited work ──
            $refMap = $this->heldCitedWorksByRefId($citingBook, $citingCanonicalId);
            if ($refMap === []) {
                continue;
            }
            $counts['pairs'] += count(array_unique(array_column($refMap, 'canonical_id')));

            // ── Parse markers + neighbouring-node context ──
            $parsed = $this->parser->parseCitationNodes($citingBook);
            if ($parsed === []) {
                continue;
            }
            $nodesById = [];
            $order = [];
            foreach ($db->table('nodes')->where('book', $citingBook)
                ->orderBy('startLine')->get(['node_id', 'content', 'plainText', 'type']) as $i => $n) {
                $nodesById[$n->node_id] = $n;
                $order[$n->node_id] = $i;
            }
            $orderedIds = array_keys($order);

            $occurrence = []; // refId => running index across nodes

            foreach ($parsed as $entry) {
                $nodeId = $entry['node_id'];
                $plain = $entry['plainText'];

                foreach ($entry['citationPositions'] as $refId => $markerOffset) {
                    if (! isset($refMap[$refId])) {
                        continue;
                    }
                    $cited = $refMap[$refId];
                    $occurrence[$refId] = ($occurrence[$refId] ?? -1) + 1;

                    $idx = $order[$nodeId] ?? null;
                    $quote = $this->quotes->detect(
                        $plain,
                        (int) $markerOffset,
                        $this->nodeShape($nodesById[$nodeId] ?? null, $nodeId, $plain),
                        $idx !== null && $idx > 0 ? $this->nodeShape($nodesById[$orderedIds[$idx - 1]], $orderedIds[$idx - 1]) : null,
                        $idx !== null && $idx < count($orderedIds) - 1 ? $this->nodeShape($nodesById[$orderedIds[$idx + 1]], $orderedIds[$idx + 1]) : null,
                    );

                    [$claimStart, $claimEnd] = $this->quotes->sentenceBounds($plain, (int) $markerOffset);

                    $row = $scope->rowColumns() + [
                        'citing_canonical_source_id' => $citingCanonicalId,
                        'cited_canonical_source_id'  => $cited['canonical_id'],
                        'citing_book'                => $citingBook,
                        'cited_book'                 => $cited['book'],
                        'is_internal'                => $scope->isInternal($cited['canonical_id'], $cited['book']),
                        'reference_id'               => $refId,
                        'occurrence_index'           => $occurrence[$refId],
                        'citing_node_id'             => $nodeId,
                        'marker_offset'              => (int) $markerOffset,
                        'claim_start'                => $claimStart,
                        'claim_end'                  => $claimEnd,
                        'has_quote'                  => $quote !== null,
                        'quote_kind'                 => $quote['kind'] ?? null,
                        'quote_text'                 => $quote['text'] ?? null,
                        'quote_node_id'              => $quote['node_id'] ?? null,
                        'citing_content_hash'        => sha1((string) ($nodesById[$nodeId]->content ?? '')),
                        'match_node_ids'             => null,
                        'match_char_data'            => null,
                        'match_method'               => null,
                        'match_score'                => null,
                        'match_occurrences'          => null,
                        'cited_content_hash'         => null,
                        'status'                     => 'pending',
                        'detection_run_id'           => $runId,
                    ];

                    if ($quote !== null) {
                        $counts['with_quote']++;
                        $citedNodes = $citedNodesCache[$cited['book']]
                            ??= $db->table('nodes')->where('book', $cited['book'])
                                ->orderBy('startLine')->get(['node_id', 'content', 'plainText'])->all();

                        $searchText = $quote['kind'] === 'blockquote'
                            ? mb_substr($quote['text'], 0, (int) config('hypercites.blockquote_search_cap', 600))
                            : $quote['text'];

                        $match = $this->locator->locate($citedNodes, $searchText);
                        if ($match !== null) {
                            $counts['matched']++;
                            $row['match_node_ids'] = json_encode($match['node_ids']);
                            $row['match_char_data'] = json_encode($match['char_data']);
                            $row['match_method'] = $match['method'];
                            $row['match_score'] = $match['score'];
                            $row['match_occurrences'] = $match['occurrences'];
                            $row['cited_content_hash'] = $this->hashNodes($citedNodes, $match['node_ids']);
                            $row['status'] = 'matched';
                        } else {
                            $counts['no_match']++;
                            $row['status'] = 'no_match';
                        }
                    }

                    $this->upsert($db, $row);
                    $counts['candidates']++;
                }
            }
        }

        return $counts;
    }

    /**
     * Map the citing book's referenceIds to HELD cited works: bibliography
     * direct canonical + foundation_source stub join (the same two bibliography
     * branches HarvestEligibility's union uses), plus citation-classified
     * footnotes via their stub (footnotes have no canonical_source_id column —
     * their footnoteId IS the refId CitationParser emits for footnote-only
     * books). Self-citations are excluded.
     *
     * @return array<string, array{canonical_id:string, book:string}>
     */
    private function heldCitedWorksByRefId(string $citingBook, ?string $citingCanonicalId): array
    {
        $db = DB::connection('pgsql_admin');

        $refToCanonical = [];

        foreach ($db->table('bibliography as b')
            ->leftJoin('library as l', 'l.book', '=', 'b.foundation_source')
            ->where('b.book', $citingBook)
            ->get(['b.referenceId', 'b.canonical_source_id', 'l.canonical_source_id as stub_canonical_id']) as $r) {
            $cid = $r->canonical_source_id ?: $r->stub_canonical_id;
            if ($cid && $cid !== $citingCanonicalId) {
                $refToCanonical[$r->referenceId] = $cid;
            }
        }

        foreach ($db->table('footnotes as f')
            ->join('library as l', 'l.book', '=', 'f.foundation_source')
            ->where('f.book', $citingBook)
            ->where('f.is_citation', true)
            ->whereNotNull('l.canonical_source_id')
            ->get(['f.footnoteId', 'l.canonical_source_id']) as $r) {
            if ($r->canonical_source_id !== $citingCanonicalId && ! isset($refToCanonical[$r->footnoteId])) {
                $refToCanonical[$r->footnoteId] = $r->canonical_source_id;
            }
        }

        if ($refToCanonical === []) {
            return [];
        }

        // Resolve each distinct cited canonical to its readable version, once.
        $held = [];
        foreach (array_unique($refToCanonical) as $cid) {
            $canonical = CanonicalSource::on('pgsql_admin')->find($cid);
            $resolved = $canonical ? $this->versions->bestPublicContentVersion($canonical) : null;
            if ($resolved) {
                $held[$cid] = $resolved['book'];
            }
        }

        $out = [];
        foreach ($refToCanonical as $refId => $cid) {
            if (isset($held[$cid]) && $held[$cid] !== $citingBook) {
                $out[$refId] = ['canonical_id' => $cid, 'book' => $held[$cid]];
            }
        }

        return $out;
    }

    /** @param string[] $nodeIds */
    private function hashNodes(array $citedNodes, array $nodeIds): string
    {
        $wanted = array_flip($nodeIds);
        $parts = [];
        foreach ($citedNodes as $n) {
            if (isset($wanted[$n->node_id])) {
                $parts[] = (string) ($n->content ?? '');
            }
        }

        return sha1(implode("\x00", $parts));
    }

    /** @return array{node_id:string, plainText:string, is_blockquote:bool} */
    private function nodeShape(?object $node, string $nodeId, ?string $decodedPlain = null): array
    {
        $plain = $decodedPlain ?? html_entity_decode(
            (string) ($node->plainText ?? ''),
            ENT_QUOTES | ENT_HTML5,
            'UTF-8'
        );

        return [
            'node_id'       => $nodeId,
            'plainText'     => $plain,
            'is_blockquote' => ($node->type ?? null) === 'blockquote'
                || str_starts_with(ltrim((string) ($node->content ?? '')), '<blockquote'),
        ];
    }

    /**
     * Upsert on the stable key, honouring human verdicts: `rejected` rows are
     * labeled data and survive re-runs untouched; `applied` rows survive while
     * the citing node still matches the hash they were applied against, and
     * flip back to pending (flagged) when a reconvert rewrote the splice site.
     */
    private function upsert($db, array $row): void
    {
        $existing = $db->table('hypercite_candidates')
            ->where('citing_book', $row['citing_book'])
            ->where('reference_id', $row['reference_id'])
            ->where('occurrence_index', $row['occurrence_index'])
            ->first(['id', 'status', 'citing_content_hash']);

        if (! $existing) {
            $row['id'] = (string) Str::uuid();
            $row['created_at'] = now();
            $row['updated_at'] = now();
            $db->table('hypercite_candidates')->insert($row);

            return;
        }

        $hashChanged = $existing->citing_content_hash !== $row['citing_content_hash'];

        if ($existing->status === 'rejected' && ! $hashChanged) {
            return;
        }
        if ($existing->status === 'applied') {
            if (! $hashChanged) {
                return;
            }
            // A reconvert rewrote the citing node under an applied hypercite:
            // surface it for re-confirmation rather than silently re-deriving.
            $row['status'] = 'pending';
            $row['error'] = 'content_changed_since_apply';
        }

        $row['updated_at'] = now();
        $db->table('hypercite_candidates')->where('id', $existing->id)->update($row);
    }

    private function step($db, string $runId, string $detail, array $counts): void
    {
        $db->table('hypercite_runs')->where('id', $runId)->update([
            'step_detail' => $detail,
            'counts'      => json_encode($counts),
            'updated_at'  => now(),
        ]);
    }
}
