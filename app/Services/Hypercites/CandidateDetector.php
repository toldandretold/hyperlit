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
    /**
     * How many nodes either side of a citing node are handed to QuoteDetector
     * for blockquote attribution. Only the CONTIGUOUS blockquote run starting
     * at the immediate neighbour is ever used, so this bounds the run length
     * rather than the reach — a blockquote separated from its marker by an
     * ordinary paragraph is still (correctly) not attributed.
     */
    private const NEIGHBOUR_WINDOW = 4;

    public function __construct(
        private CitationParser $parser,
        private QuoteDetector $quotes,
        private QuoteLocator $locator,
        private BestVersionService $versions,
    ) {}

    /**
     * @param ?int $deadline unix timestamp to stop taking NEW citing books at.
     *        A first run over a whole journal scans ~every bibliography (LLM +
     *        external APIs, minutes per article) and cannot fit one queue job —
     *        so the run stops itself with time to spare and the JOB dispatches
     *        its own continuation; every stage is idempotent (scanned books
     *        skip the scan, candidates upsert), so the next slice resumes.
     * @return array<string,int> counts for the run row (`stopped_early` =
     *         books not reached when the budget ran out)
     */
    public function detect(DetectionScope $scope, string $runId, ?int $deadline = null): array
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

        foreach ($citing as $i => $entry) {
            if ($deadline !== null && time() >= $deadline && $counts['articles'] > 0) {
                $counts['stopped_early'] = count($citing) - $i;
                break;
            }
            $citingBook = $entry['book'];
            $citingCanonicalId = $entry['canonical_id'];
            $counts['articles']++;

            $this->step($db, $runId, "scanning {$citingBook} — " . Str::limit((string) ($entry['title'] ?? ''), 60), $counts);

            // ── Ensure the bibliography has been resolved to canonicals ──
            // Conversion extracts bibliography ROWS but never matches them —
            // only citation:scan-bibliography stamps canonical_source_id (the
            // Source Network Harvester's stage 1; journal:harvest never runs
            // it). So the trigger is "any entry never ATTEMPTED" (all match
            // columns null — a scanned-but-unmatched entry carries
            // match_method='no_match'), not "no rows". Footnote-only books
            // scan once ever, tracked via citation_scans.
            if ($this->needsBibliographyScan($citingBook)) {
                $this->step($db, $runId, "resolving bibliography of {$citingBook} (LLM + external lookups)", $counts);
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
                // Every marker in this node — a quote belongs to the citation
                // that attributes it, so the detector needs to know which
                // OTHER citations stand between a quote and each marker.
                $allMarkerOffsets = array_map('intval', array_values($entry['citationPositions']));

                // Neighbour window, built ONCE per node rather than per marker
                // (it depends only on position). QuoteDetector walks it for a
                // contiguous blockquote run — a quotation split over several
                // <blockquote> siblings is one quote, and passing only the
                // immediate neighbour truncated it to its last paragraph.
                $idx = $order[$nodeId] ?? null;
                $citingShape = $this->nodeShape($nodesById[$nodeId] ?? null, $nodeId, $plain);
                [$prevNodes, $nextNodes] = $this->neighbourWindow($nodesById, $orderedIds, $idx);

                foreach ($entry['citationPositions'] as $refId => $markerOffset) {
                    if (! isset($refMap[$refId])) {
                        continue;
                    }
                    $cited = $refMap[$refId];
                    $occurrence[$refId] = ($occurrence[$refId] ?? -1) + 1;

                    $quote = $this->quotes->detect(
                        $plain,
                        (int) $markerOffset,
                        $citingShape,
                        $prevNodes,
                        $nextNodes,
                        // ALL markers, ours included: the detector decides which
                        // citation a quote belongs to. Co-citations share one
                        // offset ("(A 2020; B 2021)"), so both legitimately own it.
                        $allMarkerOffsets,
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
                        'match_locations'            => null,
                        'match_location_index'       => 0,
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
                        // `type` rides along for the front-matter ranking, and
                        // the fetch is cached per cited book, so it is free.
                        $citedNodes = $citedNodesCache[$cited['book']]
                            ??= $db->table('nodes')->where('book', $cited['book'])
                                ->orderBy('startLine')->get(['node_id', 'content', 'plainText', 'type'])->all();

                        // Resolve competing readings of the quote against the
                        // CITED TEXT, longest first: a single-quote house style
                        // makes a possessive plural (`learners'`) identical to a
                        // closing mark, so the citing side alone cannot say
                        // where the quote ends — but the source can. Strict
                        // evidence only (no fuzzy) while choosing; the fallback
                        // reading below still gets the full ladder.
                        $candidates = $quote['candidates'] ?? [$quote['text']];
                        $locations = [];
                        $matchedText = $quote['text'];

                        if (count($candidates) > 1) {
                            foreach ($candidates as $candidate) {
                                $found = $this->locator->locateAll(
                                    $citedNodes,
                                    $this->searchText($quote['kind'], $candidate),
                                    allowFuzzy: false,
                                    citedTitle: $cited['title'] ?? null,
                                );
                                if ($found !== []) {
                                    $locations = $found;
                                    $matchedText = $candidate;
                                    break;
                                }
                            }
                        }
                        // Nothing verified (or only one reading): the
                        // nearest-closer reading, full ladder including fuzzy.
                        if ($locations === []) {
                            $locations = $this->locator->locateAll(
                                $citedNodes,
                                $this->searchText($quote['kind'], $quote['text']),
                                citedTitle: $cited['title'] ?? null,
                            );
                        }

                        if ($locations !== []) {
                            $counts['matched']++;
                            // Each location carries its OWN stale guard: the
                            // reviewer can move the target, and mint() checks
                            // the hash of whichever node set is selected.
                            foreach ($locations as $i => $location) {
                                $locations[$i]['cited_content_hash'] =
                                    $this->hashNodes($citedNodes, $location['node_ids']);
                            }
                            $row['quote_text'] = $matchedText;
                            $row['match_locations'] = json_encode($locations);
                            $row['match_occurrences'] = count($locations);
                            $row = array_merge($row, MatchLocations::mirror($locations, 0));
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

    private function needsBibliographyScan(string $book): bool
    {
        $db = DB::connection('pgsql_admin');

        $hasUnattempted = $db->table('bibliography')
            ->where('book', $book)
            ->whereNull('match_method')
            ->whereNull('canonical_source_id')
            ->whereNull('source_id')
            ->whereNull('foundation_source')
            ->exists();
        if ($hasUnattempted) {
            return true;
        }
        if ($db->table('bibliography')->where('book', $book)->exists()) {
            return false; // every entry was attempted (or is already linked)
        }

        // No bibliography at all: footnote-carrying books get ONE scan ever
        // (classification sets is_citation; unmatched footnotes keep null
        // match columns, so re-checking those would loop). Empty books never scan.
        return $db->table('footnotes')->where('book', $book)->exists()
            && ! $db->table('citation_scans')->where('book', $book)->where('status', 'completed')->exists();
    }

    /**
     * Map the citing book's referenceIds to HELD cited works: bibliography
     * direct canonical + foundation_source stub join (the same two bibliography
     * branches HarvestEligibility's union uses), plus citation-classified
     * footnotes via their stub (footnotes have no canonical_source_id column —
     * their footnoteId IS the refId CitationParser emits for footnote-only
     * books). Self-citations are excluded.
     *
     * @return array<string, array{canonical_id:string, book:string, title:?string}>
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
        // The TITLE rides along for QuoteLocator's front-matter ranking — a
        // node containing the work's own title is its title block or a running
        // head, never the passage someone quoted.
        $held = [];
        foreach (array_unique($refToCanonical) as $cid) {
            $canonical = CanonicalSource::on('pgsql_admin')->find($cid);
            $resolved = $canonical ? $this->versions->bestPublicContentVersion($canonical) : null;
            if ($resolved) {
                $held[$cid] = [
                    'book'  => $resolved['book'],
                    'title' => $canonical->title
                        ?: $db->table('library')->where('book', $resolved['book'])->value('title'),
                ];
            }
        }

        $out = [];
        foreach ($refToCanonical as $refId => $cid) {
            if (isset($held[$cid]) && $held[$cid]['book'] !== $citingBook) {
                $out[$refId] = [
                    'canonical_id' => $cid,
                    'book'         => $held[$cid]['book'],
                    'title'        => $held[$cid]['title'],
                ];
            }
        }

        return $out;
    }

    /**
     * The neighbour nodes QuoteDetector may attribute a blockquote from: up to
     * NEIGHBOUR_WINDOW either side, in DOCUMENT order. The detector decides how
     * far the blockquote run actually extends; this just supplies the window.
     *
     * @param array<string, object> $nodesById
     * @param string[] $orderedIds
     * @return array{0: array<int, array>, 1: array<int, array>} [prev, next]
     */
    private function neighbourWindow(array $nodesById, array $orderedIds, ?int $idx): array
    {
        if ($idx === null) {
            return [[], []];
        }

        $prev = [];
        for ($k = max(0, $idx - self::NEIGHBOUR_WINDOW); $k < $idx; $k++) {
            $prev[] = $this->nodeShape($nodesById[$orderedIds[$k]] ?? null, $orderedIds[$k]);
        }

        $next = [];
        $last = min(count($orderedIds) - 1, $idx + self::NEIGHBOUR_WINDOW);
        for ($k = $idx + 1; $k <= $last; $k++) {
            $next[] = $this->nodeShape($nodesById[$orderedIds[$k]] ?? null, $orderedIds[$k]);
        }

        return [$prev, $next];
    }

    /**
     * Blockquotes search on a capped prefix; inline quotes search whole. The
     * text arriving here is ALREADY cleaned of the citing author's furniture
     * (QuoteDetector::blockquoteText), so the cap now falls on real quoted
     * words. Consequence to know: for a blockquote longer than the cap, the
     * located `match_char_data` — and so the minted hypercite's highlight on
     * the cited side — covers the prefix, not the whole passage.
     */
    private function searchText(?string $kind, string $text): string
    {
        return $kind === 'blockquote'
            ? mb_substr($text, 0, (int) config('hypercites.blockquote_search_cap', 600))
            : $text;
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

    /**
     * `content` rides along so QuoteDetector::blockquoteText can rebuild a
     * multi-paragraph blockquote's text with its paragraph separators intact —
     * `plainText` has already lost them (`get_text(strip=True)` / `strip_tags`
     * join `</p><p>` with nothing at all).
     *
     * Both blockquote checks are load-bearing: the div-editor save path writes
     * `'type' => $item['type'] ?? null` (DbNodeController), so an edited node's
     * type can legitimately be null while its content still opens <blockquote>.
     *
     * @return array{node_id:string, plainText:string, content:string, is_blockquote:bool}
     */
    private function nodeShape(?object $node, string $nodeId, ?string $decodedPlain = null): array
    {
        $plain = $decodedPlain ?? html_entity_decode(
            (string) ($node->plainText ?? ''),
            ENT_QUOTES | ENT_HTML5,
            'UTF-8'
        );
        $content = (string) ($node->content ?? '');

        return [
            'node_id'       => $nodeId,
            'plainText'     => $plain,
            'content'       => $content,
            'is_blockquote' => ($node->type ?? null) === 'blockquote'
                || str_starts_with(ltrim($content), '<blockquote'),
        ];
    }

    /**
     * Upsert on the stable key, honouring human verdicts: `rejected` rows are
     * labeled data and survive re-runs untouched; rows that still OWN a minted
     * hypercite survive while the citing node matches the hash they were
     * applied against, and once it drifts they are parked at `pending`
     * (flagged) and stay there across every later re-detect — a re-derived
     * `matched` would make a second mint on the same citation one click away.
     *
     * A chosen OCCURRENCE is a human verdict too, and is carried across by
     * carryOccurrenceChoice().
     */
    private function upsert($db, array $row): void
    {
        $existing = $db->table('hypercite_candidates')
            ->where('citing_book', $row['citing_book'])
            ->where('reference_id', $row['reference_id'])
            ->where('occurrence_index', $row['occurrence_index'])
            ->first(['id', 'status', 'citing_content_hash', 'hypercite_id',
                'match_locations', 'match_location_index']);

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
        // Keyed on OWNERSHIP (hypercite_id), not on status. A row that still
        // owns a minted hypercite must never be re-derived into an approvable
        // state: unchanged content is the usual no-op, and once the citing node
        // moves the row is parked at `pending` and flagged — and STAYS parked
        // on every later re-detect.
        //
        // The old code keyed on `status === 'applied'` and so demoted only
        // once. The very next detect saw `pending`, matched neither special
        // case, and fell through to the generic update below — which carries
        // `status = 'matched'`. A row with a live hypercite was approvable
        // again, and one click minted a SECOND ↗ onto the same citation
        // (Balarin/Rodríguez, GSCJ). Ownership is cleared only by an explicit
        // revert (HyperciteMinter::unmint).
        if ($existing->hypercite_id) {
            if ($existing->status === 'applied' && ! $hashChanged) {
                return;
            }
            $row['status'] = 'pending';
            $row['error'] = 'content_changed_since_apply';
        }

        $row = $this->carryOccurrenceChoice($row, $existing);

        $row['updated_at'] = now();
        $db->table('hypercite_candidates')->where('id', $existing->id)->update($row);
    }

    /**
     * Carry a reviewer's chosen occurrence across a re-detect.
     *
     * Detection always ranks its fresh list and mirrors index 0, which is right
     * for a new row and wrong for a reviewed one: a reviewer who stepped past
     * the title block to the body occurrence would silently be moved back to
     * the title block by the next run, with nothing in the UI to show it had
     * happened. The table's contract is that human verdicts survive a re-run —
     * that is why `rejected` early-returns above — and a picked occurrence is
     * exactly such a verdict.
     *
     * The choice is matched by PLACE, not by index: ranking is not stable
     * across runs (a reconvert can add or remove occurrences), so index 3 in
     * the old list is not index 3 in the new one. When the chosen place is gone
     * from the cited text entirely, the fresh top-ranked location stands — the
     * reviewer will see the candidate re-surface as `matched` and can re-pick.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function carryOccurrenceChoice(array $row, object $existing): array
    {
        $priorIndex = (int) ($existing->match_location_index ?? 0);
        if ($priorIndex === 0) {
            return $row;
        }

        $prior = MatchLocations::decode($existing->match_locations ?? null);
        $chosen = $prior[$priorIndex] ?? null;
        if ($chosen === null) {
            return $row;
        }

        $fresh = MatchLocations::decode($row['match_locations'] ?? null);
        $stillAt = MatchLocations::indexOfPlace($fresh, $chosen);
        if ($stillAt === null) {
            return $row;
        }

        return array_merge($row, MatchLocations::mirror($fresh, $stillAt));
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
