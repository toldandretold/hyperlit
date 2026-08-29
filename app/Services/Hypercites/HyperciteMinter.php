<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\AnnotationReattachmentService;
use App\Services\Annotations\CharDataRecalculator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Apply an approved hypercite candidate: insert the `hypercites` row on the
 * CITED book and splice the citing-side ↗ anchor into the citing node's HTML,
 * immediately after the in-text citation marker (`spliceAnchor` — kept as
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
 * A third refusal, `already_minted`, is ownership rather than staleness: the
 * candidate still points at a live `hypercites` row, so minting again would
 * hang a SECOND ↗ off the same citation and orphan the first (the row's
 * hypercite_id can only remember one). Revert first. It does NOT flip the
 * candidate to `failed` — the row's real state is "applied, and something
 * moved underneath it".
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
            // ── Ownership guard. Deliberately BEFORE the status check, because
            // status alone is not a safe answer to "did this already mint?": a
            // re-detect demotes an applied row to `pending` and a later one
            // promotes it back to `matched` (CandidateDetector::upsert), and a
            // status-only guard then happily mints a SECOND hypercite over the
            // live one — two ↗ on one citation, the older of the pair
            // unrevertable because this row's hypercite_id has moved on. The
            // hypercites row is the authority, not the candidate's status. ──
            if ($candidate->hypercite_id) {
                $live = $db->table('hypercites')
                    ->where('book', $candidate->cited_book)
                    ->where('hyperciteId', $candidate->hypercite_id)
                    ->exists();

                if ($live) {
                    if ($candidate->status === 'applied') {
                        return [
                            'applied'     => true,
                            'hyperciteId' => $candidate->hypercite_id,
                            'citedBook'   => $candidate->cited_book,
                            'citedNodeId' => (json_decode((string) $candidate->match_node_ids, true) ?: [null])[0],
                        ];
                    }

                    // Still owns a live hypercite from an earlier apply: revert
                    // first. Left as-is rather than flipped to `failed` — the
                    // row's real state is "applied, and the citing node moved".
                    return ['applied' => false, 'refusal' => 'already_minted'];
                }

                // Dangling pointer — the hypercite was deleted through the
                // reader, so the row owns nothing. Clear it and mint afresh.
                $db->table('hypercite_candidates')->where('id', $candidate->id)
                    ->update(['hypercite_id' => null, 'updated_at' => now()]);
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
            $newContent = $this->spliceAnchor(
                $oldContent,
                $candidate->reference_id,
                $candidate->quote_text,
                $candidate->cited_book,
                $hyperciteId,
                $anchorId,
            );
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

            $this->restampSiblings($db, $candidate, $oldContent, $newContent);

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
            // Keyed on OWNERSHIP, not status: a re-detect parks an applied row
            // at `pending` while it still owns a live hypercite, and gating on
            // `applied` left exactly those rows unrevertable — and, now that
            // mint() refuses `already_minted`, unapprovable too.
            if (! $candidate->hypercite_id) {
                return ['reverted' => false, 'refusal' => "not_revertable_from_{$candidate->status}"];
            }

            $citingNode = $db->table('nodes')
                ->where('book', $candidate->citing_book)
                ->where('node_id', $candidate->citing_node_id)
                ->first(['content']);

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

            $oldContent = (string) ($citingNode->content ?? '');
            $anchorPresent = $anchorId !== null && str_contains($oldContent, 'id="' . $anchorId . '"');

            // Drifted citing content: refuse, because blind string surgery on
            // text we no longer recognise could eat real words — UNLESS the
            // anchor is already gone, i.e. the reconvert that drifted the node
            // took the splice with it. Then there is nothing to cut and the
            // revert is pure bookkeeping. Without that escape such a row is
            // permanently stuck: unrevertable here, and unapprovable in mint()
            // because it still owns a live hypercite.
            $stale = ! $citingNode || sha1($oldContent) !== $candidate->citing_content_hash;
            if ($stale && $anchorPresent) {
                return ['reverted' => false, 'refusal' => 'stale_citing'];
            }

            $newContent = $oldContent;
            if ($anchorPresent) {
                $newContent = preg_replace(
                    '/\x{2060}?<a\s[^>]*id="' . preg_quote((string) $anchorId, '/') . '"[^>]*>[^<]*<\/a>/us',
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
                $this->restampSiblings($db, $candidate, $oldContent, $newContent);
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

    /**
     * Reject: a pure status update, preserved across re-detects as labeled
     * data. A row that still owns a minted hypercite is NOT rejectable — a
     * `rejected` row is skipped by every later re-detect, so rejecting one
     * would strand its live hypercite and its ↗ with nothing tracking them.
     * Revert first.
     */
    public function reject(string $candidateId, ?int $reviewerId): bool
    {
        return DB::connection('pgsql_admin')->table('hypercite_candidates')
            ->where('id', $candidateId)
            ->whereNull('hypercite_id')
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
    private function spliceAnchor(string $content, string $refId, ?string $quoteText, string $citedBook, string $hyperciteId, string $anchorId): ?string
    {
        $pattern = '/<a\s[^>]*href="#' . preg_quote($refId, '/') . '"[^>]*>.*?<\/a>/is';
        if (! preg_match($pattern, $content, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }

        $markerStart = $m[0][1];
        $markerEnd = $markerStart + strlen($m[0][0]); // byte offsets — same haystack throughout

        // NARRATIVE CITATION ("Author (2026) … critiques 'QUOTE' (IMT)."):
        // the marker opens the sentence and the quote comes later, so anchoring
        // to the marker would drop the ↗ mid-sentence, before the words it
        // links to. Anchor after the QUOTE's clause instead.
        $afterQuote = $this->insertOffsetAfterQuote($content, $markerEnd, $quoteText);
        $insertAt = $afterQuote ?? $this->insertOffsetAfterMarker($content, $markerStart, $markerEnd);

        $anchor = "\u{2060}<a href=\"/{$citedBook}#{$hyperciteId}\" id=\"{$anchorId}\" class=\"open-icon\">↗</a>";

        return substr($content, 0, $insertAt) . $anchor . substr($content, $insertAt);
    }

    /**
     * The usual case: the citation follows the quote, so the ↗ goes after the
     * citation's own bracket group and one trailing punctuation mark —
     * `(Flint et al, 2022: 81).↗`, never `(Flint et al, 2022:↗ 81)`.
     */
    private function insertOffsetAfterMarker(string $content, int $markerStart, int $markerEnd): int
    {
        $insertAt = $markerEnd;

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

        return $insertAt;
    }

    /**
     * Narrative-citation placement: byte offset just past the quote's own
     * clause — closing mark, an immediately following parenthetical, and one
     * punctuation mark — so `… a critique of 'IMT' (IMT).` lands the ↗ after
     * the full stop rather than beside the author's name at the sentence head.
     *
     * Null when the quote does not follow the marker (the ordinary case) or
     * cannot be located, leaving the marker-anchored path in charge.
     */
    private function insertOffsetAfterQuote(string $content, int $markerEnd, ?string $quoteText): ?int
    {
        $quoteText = $quoteText !== null ? trim($quoteText) : '';
        if ($quoteText === '') {
            return null;
        }

        // Scanning happens in PLAIN text (tags and entities can't split a
        // bracket group there), then maps back to a byte offset in the HTML.
        $map = $this->plainMap($content);
        $plain = $map['text'];
        $markerEndPlain = 0;
        foreach ($map['starts'] as $plainIdx => $htmlStart) {
            if ($htmlStart >= $markerEnd) {
                break;
            }
            $markerEndPlain = $plainIdx + 1;
        }

        $found = mb_strpos($plain, $quoteText, $markerEndPlain);
        if ($found === false) {
            $located = AnnotationReattachmentService::findInText($quoteText, mb_substr($plain, $markerEndPlain));
            if ($located === null) {
                return null;
            }
            $found = $markerEndPlain + $located[0];
            $end = $markerEndPlain + $located[1];
        } else {
            $end = $found + mb_strlen($quoteText);
        }
        if ($found < $markerEndPlain) {
            return null; // quote precedes the marker — ordinary placement
        }

        $chars = mb_str_split($plain);
        $n = count($chars);
        $p = $end;

        // The stored quote excludes its own marks; step over the closer.
        if ($p < $n && in_array($chars[$p], ["'", "\u{2019}", '"', "\u{201D}"], true)) {
            $p++;
        }
        // An immediately following parenthetical belongs to the clause: `(IMT)`.
        $q = $p;
        if ($q < $n && $chars[$q] === ' ') {
            $q++;
        }
        if ($q < $n && ($chars[$q] === '(' || $chars[$q] === '[')) {
            $depth = 0;
            for ($k = $q; $k < $n && $k - $q < 200; $k++) {
                if ($chars[$k] === '(' || $chars[$k] === '[') {
                    $depth++;
                } elseif ($chars[$k] === ')' || $chars[$k] === ']') {
                    $depth--;
                    if ($depth === 0) {
                        $p = $k + 1;
                        break;
                    }
                }
            }
        }
        // …and one trailing punctuation mark, as in the marker-anchored path.
        if ($p < $n && in_array($chars[$p], [',', '.', ';', ':'], true)) {
            $p++;
        }

        return $p > 0 ? ($map['ends'][$p - 1] ?? null) : null;
    }

    /**
     * Character-by-character map from the node's HTML to its plain text: tags
     * skipped, entities decoded, so plain offsets can be mapped back to the
     * byte offset just after the character that produced them.
     *
     * @return array{text:string, starts:int[], ends:int[]}
     */
    private function plainMap(string $html): array
    {
        $text = '';
        $starts = [];
        $ends = [];
        $len = strlen($html);
        $i = 0;

        while ($i < $len) {
            $ch = $html[$i];

            if ($ch === '<') {
                $gt = strpos($html, '>', $i);
                if ($gt === false) {
                    break;
                }
                $i = $gt + 1;
                continue;
            }

            if ($ch === '&') {
                $semi = strpos($html, ';', $i);
                if ($semi !== false && $semi - $i <= 10) {
                    $entity = substr($html, $i, $semi - $i + 1);
                    $decoded = html_entity_decode($entity, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                    if ($decoded !== $entity) {
                        foreach (mb_str_split($decoded) as $decodedChar) {
                            $text .= $decodedChar;
                            $starts[] = $i;
                            $ends[] = $semi + 1;
                        }
                        $i = $semi + 1;
                        continue;
                    }
                }
            }

            $ord = ord($ch);
            $charLen = $ord >= 0xF0 ? 4 : ($ord >= 0xE0 ? 3 : ($ord >= 0xC0 ? 2 : 1));
            $text .= substr($html, $i, $charLen);
            $starts[] = $i;
            $ends[] = $i + $charLen;
            $i += $charLen;
        }

        return ['text' => $text, 'starts' => $starts, 'ends' => $ends];
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

    /**
     * Carry the OTHER candidates on this node across our own content edit.
     *
     * Every sibling candidate measured its offsets against the pre-edit
     * content, so splicing (or removing) an anchor makes them all look
     * "changed since detection": the sibling's approve refuses 409
     * stale_citing, the operator re-detects to clear it, and that re-detect
     * demotes THIS row out of `applied` — the first step of the cascade that
     * put two ↗ on one citation in prod (Balarin/Rodríguez, GSCJ).
     *
     * Only rows whose stored hash is EXACTLY the content we just edited are
     * re-stamped: those measured the thing we changed, and an anchor
     * insertion/removal moves no citation marker and no quote text, so their
     * measurement still holds. Any other hash is genuine drift (a reconvert,
     * a user edit) and must stay stale — that is what the guards are for.
     */
    private function restampSiblings($db, object $candidate, string $oldContent, string $newContent): void
    {
        $db->table('hypercite_candidates')
            ->where('citing_book', $candidate->citing_book)
            ->where('citing_node_id', $candidate->citing_node_id)
            ->where('id', '!=', $candidate->id)
            ->where('citing_content_hash', sha1($oldContent))
            ->update([
                'citing_content_hash' => sha1($newContent),
                'updated_at'          => now(),
            ]);
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
