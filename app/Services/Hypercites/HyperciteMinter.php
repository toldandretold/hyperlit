<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\CharDataRecalculator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Apply an approved hypercite candidate: insert the `hypercites` row on the
 * CITED book and splice the citing-side ↗ anchor into the citing node's HTML,
 * immediately after the in-text citation marker (`appendAfterMarker` — kept as
 * a private method so a `replaceMarker` variant can slot in later without
 * touching the row logic; replacing would first need a story for preserving
 * the marker's open-the-bibliography-entry click behaviour).
 *
 * Everything runs in one pgsql_admin transaction with the candidate row locked
 * (`FOR UPDATE`), so a double-click or a batch racing a single approve cannot
 * mint twice. Two stale guards refuse (409 at the controller) when a node's
 * live content no longer matches what detection measured — the stored offsets
 * would land the hypercite on the wrong text:
 *   stale_citing — the citing node changed (reconvert/edit) since detection;
 *   stale_cited  — the matched cited node(s) changed.
 * A refusal flips the candidate to `failed` with the code in `error`; a
 * re-detect re-measures and clears it.
 *
 * No undo-after-apply in v1: remove a wrong hypercite through the reader
 * (delete the hypercite), then reject the candidate so a re-run skips it.
 */
class HyperciteMinter
{
    /**
     * @return array{applied:bool, refusal?:string, hyperciteId?:string, anchorId?:string,
     *               citedBook?:string, citedNodeId?:string}
     */
    public function mint(string $candidateId, ?int $reviewerId, bool $auto = false): array
    {
        $db = DB::connection('pgsql_admin');

        return $db->transaction(function () use ($db, $candidateId, $reviewerId, $auto) {
            $candidate = $db->table('hypercite_candidates')
                ->where('id', $candidateId)
                ->lockForUpdate()
                ->first();

            if (! $candidate) {
                return ['applied' => false, 'refusal' => 'not_found'];
            }
            if ($candidate->status === 'applied' && $candidate->hypercite_id) {
                return [
                    'applied'     => true,
                    'hyperciteId' => $candidate->hypercite_id,
                    'citedBook'   => $candidate->cited_book,
                    'citedNodeId' => (json_decode((string) $candidate->match_node_ids, true) ?: [null])[0],
                ];
            }
            if ($candidate->status !== 'matched') {
                return ['applied' => false, 'refusal' => "not_appliable_from_{$candidate->status}"];
            }

            // ── Stale guards ──
            $citingNode = $db->table('nodes')
                ->where('book', $candidate->citing_book)
                ->where('node_id', $candidate->citing_node_id)
                ->first(['content']);
            if (! $citingNode || sha1((string) $citingNode->content) !== $candidate->citing_content_hash) {
                return $this->refuse($db, $candidate, 'stale_citing');
            }

            $matchNodeIds = json_decode((string) $candidate->match_node_ids, true) ?: [];
            $matchCharData = json_decode((string) $candidate->match_char_data, true) ?: [];
            if ($matchNodeIds === [] || $matchCharData === []) {
                return $this->refuse($db, $candidate, 'no_match_data');
            }
            $citedNodes = $db->table('nodes')
                ->where('book', $candidate->cited_book)
                ->whereIn('node_id', $matchNodeIds)
                ->orderBy('startLine')
                ->get(['node_id', 'content']);
            if ($citedNodes->count() !== count($matchNodeIds)) {
                return $this->refuse($db, $candidate, 'stale_cited');
            }
            $liveHash = sha1($citedNodes->map(fn ($n) => (string) ($n->content ?? ''))->implode("\x00"));
            if ($liveHash !== $candidate->cited_content_hash) {
                return $this->refuse($db, $candidate, 'stale_cited');
            }

            // ── Citing-side splice, after the marker ──
            $hyperciteId = 'hypercite_' . Str::random(8);
            $anchorId = 'hypercite_' . Str::random(8);
            $oldContent = (string) $citingNode->content;
            $newContent = $this->appendAfterMarker($oldContent, $candidate->reference_id, $candidate->cited_book, $hyperciteId, $anchorId);
            if ($newContent === null) {
                return $this->refuse($db, $candidate, 'marker_not_found');
            }

            // ── Cited-side row ──
            $reviewerName = $reviewerId
                ? $db->table('users')->where('id', $reviewerId)->value('name')
                : null;
            $creator = $reviewerName ?: 'hypercite_detector';

            $db->table('hypercites')->insert([
                'book'               => $candidate->cited_book,
                'hyperciteId'        => $hyperciteId,
                'node_id'            => json_encode($matchNodeIds),
                'charData'           => json_encode($matchCharData),
                'citedIN'            => json_encode(["/{$candidate->citing_book}#{$anchorId}"]),
                'hypercitedText'     => Str::limit((string) $candidate->quote_text, 300),
                'relationshipStatus' => 'couple',
                'creator'            => $creator,
                'creator_token'      => null,
                'access_granted'     => json_encode($reviewerName ? [$reviewerName => 'co-author'] : []),
                'time_since'         => now()->timestamp,
                'raw_json'           => json_encode([]),
                'created_at'         => now(),
                'updated_at'         => now(),
            ]);

            $db->table('nodes')
                ->where('book', $candidate->citing_book)
                ->where('node_id', $candidate->citing_node_id)
                ->update(['content' => $newContent, 'updated_at' => now()]);

            // Relocate every other annotation on the spliced node — the anchor
            // shifted all downstream charData offsets.
            CharDataRecalculator::recalcForNodes($candidate->citing_book, [
                $candidate->citing_node_id => ['old' => $oldContent, 'new' => $newContent],
            ]);

            // ── Sync: both books' annotation clocks; the citing book's content
            // clock too, so clients refetch the spliced node. Set directly on
            // pgsql_admin rather than via update_annotations_timestamp(): that
            // SECURITY DEFINER function exists to let the RLS'd DEFAULT
            // connection bump books the caller doesn't own — we're already
            // admin — and calling it here would touch the same library row
            // from a second connection, which deadlocks under a wrapping test
            // transaction (the afterEach-admin-delete class of deadlock). ──
            $nowMs = (int) round(microtime(true) * 1000);
            $db->table('library')->where('book', $candidate->citing_book)
                ->update(['annotations_updated_at' => $nowMs, 'timestamp' => $nowMs]);
            $db->table('library')->where('book', $candidate->cited_book)
                ->update(['annotations_updated_at' => $nowMs]);

            // ── Candidate bookkeeping. citing_content_hash is re-stamped to the
            // POST-splice content so the next detect sees the applied row as
            // current rather than "changed since apply". ──
            $db->table('hypercite_candidates')->where('id', $candidate->id)->update([
                'status'              => 'applied',
                'hypercite_id'        => $hyperciteId,
                'citing_content_hash' => sha1($newContent),
                'reviewed_by'         => $reviewerId,
                'reviewed_at'         => now(),
                'applied_at'          => now(),
                'auto_approved'       => $auto,
                'error'               => null,
                'updated_at'          => now(),
            ]);

            Log::info('hypercites: minted', [
                'candidate'   => $candidate->id,
                'hyperciteId' => $hyperciteId,
                'citing'      => $candidate->citing_book,
                'cited'       => $candidate->cited_book,
                'auto'        => $auto,
            ]);

            return [
                'applied'     => true,
                'hyperciteId' => $hyperciteId,
                'anchorId'    => $anchorId,
                'citedBook'   => $candidate->cited_book,
                'citedNodeId' => $matchNodeIds[0],
            ];
        });
    }

    /** Reject: a pure status update, preserved across re-detects as labeled data. */
    public function reject(string $candidateId, ?int $reviewerId): bool
    {
        return DB::connection('pgsql_admin')->table('hypercite_candidates')
            ->where('id', $candidateId)
            ->whereIn('status', ['pending', 'matched', 'no_match', 'failed'])
            ->update([
                'status'      => 'rejected',
                'reviewed_by' => $reviewerId,
                'reviewed_at' => now(),
                'updated_at'  => now(),
            ]) > 0;
    }

    /**
     * Insert the hypercite anchor immediately after the FIRST in-text citation
     * marker for this refId in the node's HTML (CitationParser records one
     * position per refId per node — the first — so this is the marker the
     * stored offset describes). The word joiner keeps the ↗ glued to the
     * marker; format matches the client's paste convention
     * (hyperciteHandler.ts), not the Archivist's legacy <sup> wrapper.
     */
    private function appendAfterMarker(string $content, string $refId, string $citedBook, string $hyperciteId, string $anchorId): ?string
    {
        $pattern = '/<a\s[^>]*href="#' . preg_quote($refId, '/') . '"[^>]*>.*?<\/a>/is';
        if (! preg_match($pattern, $content, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }

        $insertAt = $m[0][1] + strlen($m[0][0]); // byte offsets — both from the same haystack
        $anchor = "\u{2060}<a href=\"/{$citedBook}#{$hyperciteId}\" id=\"{$anchorId}\" class=\"open-icon\">↗</a>";

        return substr($content, 0, $insertAt) . $anchor . substr($content, $insertAt);
    }

    private function refuse($db, object $candidate, string $code): array
    {
        $db->table('hypercite_candidates')->where('id', $candidate->id)->update([
            'status'     => 'failed',
            'error'      => $code,
            'updated_at' => now(),
        ]);

        return ['applied' => false, 'refusal' => $code];
    }
}
