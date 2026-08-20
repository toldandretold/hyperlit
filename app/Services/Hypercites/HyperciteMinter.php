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

    /**
     * Revert an applied candidate: remove the spliced ↗ anchor from the citing
     * node, delete the hypercites row, and put the candidate back to `matched`
     * so it can be re-reviewed (or re-applied — a fresh mint generates fresh
     * ids). Same transaction + lock discipline as mint; refuses `stale_citing`
     * when the citing node changed since the apply (the stored post-splice
     * hash no longer matches), because blind string surgery on drifted
     * content could eat real text.
     *
     * @return array{reverted:bool, refusal?:string}
     */
    public function unmint(string $candidateId, ?int $reviewerId): array
    {
        $db = DB::connection('pgsql_admin');

        return $db->transaction(function () use ($db, $candidateId, $reviewerId) {
            $candidate = $db->table('hypercite_candidates')
                ->where('id', $candidateId)
                ->lockForUpdate()
                ->first();

            if (! $candidate) {
                return ['reverted' => false, 'refusal' => 'not_found'];
            }
            if ($candidate->status !== 'applied' || ! $candidate->hypercite_id) {
                return ['reverted' => false, 'refusal' => "not_revertable_from_{$candidate->status}"];
            }

            $citingNode = $db->table('nodes')
                ->where('book', $candidate->citing_book)
                ->where('node_id', $candidate->citing_node_id)
                ->first(['content']);
            if (! $citingNode || sha1((string) $citingNode->content) !== $candidate->citing_content_hash) {
                return ['reverted' => false, 'refusal' => 'stale_citing'];
            }

            // The anchor id lives in the hypercite row's citedIN entry.
            $hypercite = $db->table('hypercites')
                ->where('book', $candidate->cited_book)
                ->where('hyperciteId', $candidate->hypercite_id)
                ->first();
            $anchorId = null;
            foreach (json_decode((string) ($hypercite->citedIN ?? '[]'), true) ?: [] as $entry) {
                if (str_starts_with((string) $entry, "/{$candidate->citing_book}#")) {
                    $anchorId = substr((string) $entry, strlen("/{$candidate->citing_book}#"));
                    break;
                }
            }

            $oldContent = (string) $citingNode->content;
            $newContent = $oldContent;
            if ($anchorId !== null) {
                $newContent = preg_replace(
                    '/\x{2060}?<a\s[^>]*id="' . preg_quote($anchorId, '/') . '"[^>]*>[^<]*<\/a>/us',
                    '',
                    $oldContent,
                    1
                ) ?? $oldContent;
            }
            if ($newContent !== $oldContent) {
                $db->table('nodes')
                    ->where('book', $candidate->citing_book)
                    ->where('node_id', $candidate->citing_node_id)
                    ->update(['content' => $newContent, 'updated_at' => now()]);
                CharDataRecalculator::recalcForNodes($candidate->citing_book, [
                    $candidate->citing_node_id => ['old' => $oldContent, 'new' => $newContent],
                ]);
            }

            $db->table('hypercites')
                ->where('book', $candidate->cited_book)
                ->where('hyperciteId', $candidate->hypercite_id)
                ->delete();

            $nowMs = (int) round(microtime(true) * 1000);
            $db->table('library')->where('book', $candidate->citing_book)
                ->update(['annotations_updated_at' => $nowMs, 'timestamp' => $nowMs]);
            $db->table('library')->where('book', $candidate->cited_book)
                ->update(['annotations_updated_at' => $nowMs]);

            $db->table('hypercite_candidates')->where('id', $candidate->id)->update([
                'status'              => 'matched',
                'hypercite_id'        => null,
                'citing_content_hash' => sha1($newContent),
                'applied_at'          => null,
                'auto_approved'       => false,
                'reviewed_by'         => $reviewerId,
                'reviewed_at'         => now(),
                'error'               => null,
                'updated_at'          => now(),
            ]);

            Log::info('hypercites: reverted', [
                'candidate' => $candidate->id,
                'citing'    => $candidate->citing_book,
                'cited'     => $candidate->cited_book,
            ]);

            return ['reverted' => true];
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
     * Insert the hypercite anchor after the FIRST in-text citation marker for
     * this refId in the node's HTML (CitationParser records one position per
     * refId per node — the first — so this is the marker the stored offset
     * describes). Placement rule — the ↗ belongs to the SENTENCE, never
     * inside the citation's punctuation:
     *
     *   `(<a>Boss et al, 2023</a>).`        → `(Boss et al, 2023).↗`
     *   `(<a>Flint et al, 2022</a>: 81).`   → `(Flint et al, 2022: 81).↗`
     *   `(<a>A, 2020</a>; see also B 2021)` → `(A, 2020; see also B 2021)↗`
     *   `<a>Masaka (2019)</a> writing`      → `Masaka (2019)↗ writing`
     *
     * A marker INSIDE a bracket group (detected by back-scanning for an
     * unmatched opener) walks forward to the group's MATCHING close bracket —
     * page numbers, semicolon co-citations and further anchors ride along —
     * then past one trailing punctuation mark. A naive "skip one punctuation"
     * here once dropped the ↗ mid-citation, before the page number:
     * `(Flint et al, 2022:↗ 81)`. Non-bracketed markers just skip trailing
     * punctuation. The word joiner keeps the ↗ glued to whatever it lands
     * after; format matches the client's paste convention (hyperciteHandler.ts).
     */
    private function appendAfterMarker(string $content, string $refId, string $citedBook, string $hyperciteId, string $anchorId): ?string
    {
        $pattern = '/<a\s[^>]*href="#' . preg_quote($refId, '/') . '"[^>]*>.*?<\/a>/is';
        if (! preg_match($pattern, $content, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }

        $markerStart = $m[0][1];
        $insertAt = $markerStart + strlen($m[0][0]); // byte offsets — same haystack throughout

        if ($this->insideBrackets($content, $markerStart)) {
            $afterClose = $this->afterMatchingClose($content, $insertAt);
            if ($afterClose !== null) {
                $insertAt = $afterClose;
            }
        }
        // One trailing punctuation mark, plain character only — a following
        // tag (another citation's anchor) is never crossed.
        if (preg_match('/\G[,.;:]/', $content, $tail, 0, $insertAt)) {
            $insertAt += strlen($tail[0]);
        }

        $anchor = "\u{2060}<a href=\"/{$citedBook}#{$hyperciteId}\" id=\"{$anchorId}\" class=\"open-icon\">↗</a>";

        return substr($content, 0, $insertAt) . $anchor . substr($content, $insertAt);
    }

    /**
     * Is the marker inside a bracket group? Walk BACKWARD over plain text
     * (tags skipped wholesale), balancing brackets: an unmatched opener before
     * the marker means yes. Stops at a sentence boundary or after a bounded
     * window — citations don't span sentences.
     */
    private function insideBrackets(string $content, int $markerStart): bool
    {
        $depth = 0;
        $scanned = 0;
        $i = $markerStart - 1;

        while ($i >= 0 && $scanned < 300) {
            $ch = $content[$i];
            if ($ch === '>') { // skip the whole tag
                $lt = strrpos(substr($content, 0, $i), '<');
                if ($lt === false) {
                    return false;
                }
                $i = $lt - 1;
                continue;
            }
            if ($ch === ')' || $ch === ']') {
                $depth++;
            } elseif ($ch === '(' || $ch === '[') {
                if ($depth === 0) {
                    return true; // unmatched opener — we're inside it
                }
                $depth--;
            } elseif (($ch === '.' || $ch === '!' || $ch === '?') && $depth === 0) {
                return false; // previous sentence — no open bracket reaches us
            }
            $i--;
            $scanned++;
        }

        return false;
    }

    /**
     * Byte offset just past the bracket group's matching close, scanning
     * FORWARD from the marker's end (depth starts at 1; tags skipped
     * wholesale, so an anchor whose text contains parens stays balanced and a
     * multi-citation's sibling anchors are crossed safely). Null when no
     * close is found within the window — caller keeps the marker-end position.
     */
    private function afterMatchingClose(string $content, int $from): ?int
    {
        $depth = 1;
        $len = strlen($content);
        $scanned = 0;
        $i = $from;

        while ($i < $len && $scanned < 400) {
            $ch = $content[$i];
            if ($ch === '<') { // skip the whole tag
                $gt = strpos($content, '>', $i);
                if ($gt === false) {
                    return null;
                }
                $i = $gt + 1;
                continue;
            }
            if ($ch === '(' || $ch === '[') {
                $depth++;
            } elseif ($ch === ')' || $ch === ']') {
                $depth--;
                if ($depth === 0) {
                    return $i + 1;
                }
            }
            $i++;
            $scanned++;
        }

        return null;
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
