<?php

namespace App\Services\Annotations;

use App\Models\PgHypercite;
use App\Models\PgHyperlight;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Save-time recalculation of hyperlight/hypercite charData against node edits.
 *
 * WHY THE SERVER: the client only re-measures marks that are RENDERED in its
 * DOM. Annotations that aren't rendered — other users' highlights, gate-filtered
 * or hidden ones, nodes in unloaded chunks — go silently stale on every edit.
 * The server sees every node write with both the OLD and NEW content, which is
 * everything needed to relocate each annotation deterministically.
 *
 * Per annotation entry (one node's {charStart, charEnd}) on a saved node:
 *  1. Extract the annotation's actual text = old plain text sliced at the range.
 *  2. Search the NEW plain text for that fragment:
 *     - found → write the new range (nearest occurrence to the old position);
 *     - found only under whitespace-normalization → leave untouched (indices
 *       can't be mapped exactly; client display-time detection covers it);
 *     - not found at all → TOMBSTONE the entry: charStart = charEnd = -1, the
 *       deterministic "text was deleted" marker (same convention as ghost
 *       hypercite tombstones). Entries are never deleted — the record keeps its
 *       node anchor, so ghosts stay navigable.
 *  3. A tombstoned entry whose text reappears (undo) is resurrected with a
 *     freshly computed range (single-node records — the whole highlightedText
 *     is the fragment).
 *
 * Coordinates: charData indexes the client's DOM textContent, i.e. text with
 * tags gone and entities DECODED. plainOf() mirrors that (strip_tags +
 * html_entity_decode), so server offsets land in the client's coordinate space.
 *
 * Skips (unjudgeable — never touch): E2EE books (ciphertext), nodes containing
 * <latex> (KaTeX inflates live textContent), zero-length fragments.
 *
 * Writes via pgsql_admin: annotations routinely belong to users other than the
 * node's editor, so an RLS-scoped write would silently no-op.
 */
class CharDataRecalculator
{
    /**
     * Recalculate all annotations touching the given nodes.
     *
     * @param  array<string,array{old:?string,new:?string}>  $contentsByNodeId
     *         Pre-edit and post-edit content per data-node-id. old=null means
     *         the node did not exist before (fresh insert — nothing to move).
     * @return int number of entries changed (moved, tombstoned, or resurrected)
     */
    public static function recalcForNodes(string $book, array $contentsByNodeId): int
    {
        $contentsByNodeId = array_filter(
            $contentsByNodeId,
            fn ($c, $id) => $id !== '' && is_array($c),
            ARRAY_FILTER_USE_BOTH,
        );
        if (empty($contentsByNodeId) || EncryptedBookGuard::isEncrypted($book)) {
            return 0;
        }

        $nodeIds = array_keys($contentsByNodeId);
        $pgArray = '{'.implode(',', array_map(
            fn ($id) => '"'.str_replace(['\\', '"'], '', (string) $id).'"',
            $nodeIds
        )).'}';

        $changedTotal = 0;
        foreach ([PgHyperlight::class, PgHypercite::class] as $model) {
            $records = $model::on('pgsql_admin')
                ->where('book', $book)
                ->whereRaw('node_id ??| ?::text[]', [$pgArray])
                ->get();

            foreach ($records as $record) {
                $changedTotal += self::recalcRecord($record, $contentsByNodeId);
            }
        }

        return $changedTotal;
    }

    /**
     * Re-anchor ghosts whose ghost_anchor_node was just deleted: walk each one
     * up to the deleted anchor's nearest SURVIVING predecessor, so the
     * renumber-proof anchor chain never dangles. Call AFTER the node rows are
     * deleted (survivors = the table's current state). No surviving
     * predecessor → the anchor is cleared (the stored-startLine fallback takes
     * over client-side). Mirrors the client's batch.ts re-anchor pass — both
     * compute the same predecessor from the same book state, so the local and
     * server copies converge without syncing the client's local re-anchors.
     *
     * @param  array<string,mixed>  $deletedNodes  node_id => startLine, captured BEFORE the delete
     * @return int number of records re-anchored
     */
    public static function reanchorForDeletedNodes(string $book, array $deletedNodes): int
    {
        $deletedNodes = array_filter(
            $deletedNodes,
            fn ($sl, $nid) => $nid !== '' && $nid !== null && is_numeric($sl),
            ARRAY_FILTER_USE_BOTH,
        );
        if (empty($deletedNodes)) {
            return 0;
        }

        $recordSets = [
            PgHyperlight::on('pgsql_admin')
                ->where('book', $book)
                ->whereIn('ghost_anchor_node', array_keys($deletedNodes))
                ->get(),
            PgHypercite::on('pgsql_admin')
                ->where('book', $book)
                ->whereIn('ghost_anchor_node', array_keys($deletedNodes))
                ->get(),
        ];
        if ($recordSets[0]->isEmpty() && $recordSets[1]->isEmpty()) {
            return 0;
        }

        // Current (post-delete) nodes of the book, ascending by position.
        $survivors = DB::table('nodes')
            ->where('book', $book)
            ->get(['node_id', 'startLine'])
            ->filter(fn ($n) => $n->node_id && is_numeric($n->startLine))
            ->sortBy(fn ($n) => (float) $n->startLine)
            ->values();

        $changed = 0;
        foreach ($recordSets as $records) {
            foreach ($records as $record) {
                $anchorStart = (float) $deletedNodes[$record->ghost_anchor_node];
                $replacement = null;
                foreach ($survivors as $n) {
                    if ((float) $n->startLine < $anchorStart) {
                        $replacement = $n->node_id;
                    } else {
                        break;
                    }
                }
                $record->ghost_anchor_node = $replacement; // null when nothing precedes
                $record->save();
                $changed++;
            }
        }

        Log::info('CharDataRecalculator: re-anchored ghosts after anchor-node deletion', [
            'book' => $book,
            'records' => $changed,
        ]);

        return $changed;
    }

    /** The client-coordinate plain text of stored node HTML. */
    private static function plainOf(?string $content): string
    {
        if ($content === null) {
            return '';
        }

        return html_entity_decode(strip_tags($content), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    /** Whitespace-collapsed comparison form (incl. non-breaking spaces). */
    private static function comparable(string $s): string
    {
        return trim(preg_replace('/[\s\x{00A0}]+/u', ' ', $s) ?? '');
    }

    /** All byte-exact occurrences of $needle in $haystack (character offsets). */
    private static function occurrences(string $haystack, string $needle): array
    {
        $found = [];
        $offset = 0;
        while (($pos = mb_strpos($haystack, $needle, $offset, 'UTF-8')) !== false) {
            $found[] = $pos;
            $offset = $pos + 1;
        }

        return $found;
    }

    /**
     * Recalculate one record's entries. Returns the number of entries changed.
     */
    private static function recalcRecord(PgHyperlight|PgHypercite $record, array $contentsByNodeId): int
    {
        $charData = is_array($record->charData) ? $record->charData : [];
        $nodeIdArr = is_array($record->node_id) ? $record->node_id : [];
        $annotationText = (string) ($record->highlightedText ?? $record->hypercitedText ?? '');

        $changed = 0;
        foreach ($contentsByNodeId as $nodeId => $contents) {
            $range = $charData[$nodeId] ?? null;
            if (! is_array($range) || ! isset($range['charStart'])) {
                continue;
            }
            $old = $contents['old'] ?? null;
            $new = $contents['new'] ?? null;
            if ($new === null) {
                continue; // node deletion is handled by the client orphan flow
            }
            if (str_contains((string) $new, '<latex') || str_contains((string) $old, '<latex')) {
                continue; // KaTeX-rendered textContent diverges — unjudgeable
            }

            $newPlain = self::plainOf($new);
            $cs = (int) $range['charStart'];
            $ce = (int) ($range['charEnd'] ?? $cs);

            // ── Tombstoned entry: attempt resurrection (undo brought the text back) ──
            if ($cs < 0) {
                if (count($nodeIdArr) === 1 && mb_strlen(self::comparable($annotationText), 'UTF-8') >= 3) {
                    $hits = self::occurrences($newPlain, $annotationText);
                    if (count($hits) > 0) {
                        $idx = $hits[0];
                        $charData[$nodeId] = ['charStart' => $idx, 'charEnd' => $idx + mb_strlen($annotationText, 'UTF-8')];
                        $changed++;
                    }
                }

                continue;
            }

            // ── Live entry: extract the fragment from the OLD text at the range ──
            $oldPlain = self::plainOf($old);
            $fragment = ($ce > $cs && $cs < mb_strlen($oldPlain, 'UTF-8'))
                ? mb_substr($oldPlain, $cs, $ce - $cs, 'UTF-8')
                : '';
            // Corrupt/legacy range (beyond the old text): fall back to the whole
            // annotation text for single-node records.
            if (self::comparable($fragment) === '' && count($nodeIdArr) === 1) {
                $fragment = $annotationText;
            }
            if (mb_strlen(self::comparable($fragment), 'UTF-8') < 1) {
                continue; // nothing judgeable
            }

            $hits = self::occurrences($newPlain, $fragment);
            if (count($hits) > 0) {
                // Nearest occurrence to the old position wins (repeated phrases).
                usort($hits, fn ($a, $b) => abs($a - $cs) <=> abs($b - $cs));
                $idx = $hits[0];
                $newEnd = $idx + mb_strlen($fragment, 'UTF-8');
                if ($idx !== $cs || $newEnd !== $ce) {
                    $charData[$nodeId] = ['charStart' => $idx, 'charEnd' => $newEnd];
                    $changed++;
                }

                continue;
            }

            // Fragment survives only under whitespace-normalization → indices can't
            // be mapped exactly; leave untouched (client display-time detection covers it).
            if (self::comparable($fragment) !== ''
                && str_contains(self::comparable($newPlain), self::comparable($fragment))) {
                continue;
            }

            // ── Text is gone: deterministic tombstone ──
            $charData[$nodeId] = ['charStart' => -1, 'charEnd' => -1];
            $changed++;
        }

        // Refresh the stored startLine column for single-node hyperlights whose
        // node was part of this save (renumbering changes a node's startLine but
        // never its node_id; an unrendered highlight's stored copy would drift
        // forever otherwise). Hypercites have no startLine column.
        $startLineChanged = false;
        if ($record instanceof PgHyperlight && count($nodeIdArr) === 1) {
            $onlyNode = $nodeIdArr[0];
            $saved = $contentsByNodeId[$onlyNode] ?? null;
            if (is_array($saved) && array_key_exists('startLine', $saved) && $saved['startLine'] !== null
                && (string) $record->startLine !== (string) $saved['startLine']) {
                $record->startLine = (string) $saved['startLine'];
                $startLineChanged = true;
            }
        }

        if ($changed === 0 && ! $startLineChanged) {
            return 0;
        }

        $record->charData = $charData;

        // Mirror into raw_json — the read API returns it; a stale copy would
        // resurrect old ranges on the next client hydration.
        $raw = $record->raw_json; // hyperlight accessor / hypercite cast → array|null
        if (is_array($raw)) {
            $raw['charData'] = $charData;
            if ($startLineChanged) {
                $raw['startLine'] = $record->startLine;
            }
            $record->raw_json = $record instanceof PgHyperlight ? json_encode($raw) : $raw;
        }

        $record->save();

        Log::info('CharDataRecalculator: recalculated annotation ranges', [
            'book' => $record->book,
            'id' => $record->hyperlight_id ?? $record->hyperciteId ?? null,
            'entries_changed' => $changed,
        ]);

        return $changed;
    }
}
