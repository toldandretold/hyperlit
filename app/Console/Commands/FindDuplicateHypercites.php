<?php

namespace App\Console\Commands;

use App\Services\Annotations\CharDataRecalculator;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Find (and optionally clean up) hypercites minted TWICE over the same passage
 * by the same citing book — the `↗↗` bug.
 *
 * WHAT WENT WRONG (fixed in HyperciteMinter/CandidateDetector, this sweeps the
 * damage): approving one citation rewrote its node, which staled every SIBLING
 * candidate in that paragraph; the operator re-detected to clear the 409, and
 * the re-detect demoted the already-applied row to `pending` while leaving its
 * hypercite_id set. A later detect promoted it back to `matched`, mint()'s
 * status-only idempotency guard missed, and it minted a SECOND hypercites row
 * plus a second ↗ into the same node. The candidate's hypercite_id moved to the
 * new row, so the console could never revert the older one.
 *
 * WHAT COUNTS AS A DUPLICATE: rows sharing (cited book, node_id, charData) AND
 * the same CITING book. Same passage cited by two DIFFERENT books is a genuine
 * poly hypercite and is never touched.
 *
 * SAFETY: dry-run unless --fix. A group where two or more rows are each still
 * owned by a `hypercite_candidates` row is reported but never auto-fixed —
 * that is two bibliography entries resolving to one work, and deleting either
 * side would strand a live candidate.
 *
 * USAGE:
 *   php artisan hypercites:find-duplicates                 # report everything
 *   php artisan hypercites:find-duplicates --book=<uuid>   # citing OR cited book
 *   php artisan hypercites:find-duplicates --fix           # apply
 */
class FindDuplicateHypercites extends Command
{
    protected $signature = 'hypercites:find-duplicates {--fix : Apply the cleanup (default is a dry run)} {--book= : Restrict to groups whose citing OR cited book matches}';

    protected $description = 'Find hypercites minted twice over the same passage by the same citing book, and optionally strip the duplicate ↗ and row';

    public function handle(): int
    {
        $fix = (bool) $this->option('fix');
        $bookFilter = $this->option('book');

        if (! $fix) {
            $this->info('🔍 DRY RUN — nothing will be written. Re-run with --fix to apply.');
        }

        $db = DB::connection('pgsql_admin');

        // Candidate groups: more than one hypercites row over the identical
        // (book, node_id, charData). Cheap first pass; the citing-book split
        // and the ownership check happen per group below.
        $groupsQuery = $db->table('hypercites')
            ->selectRaw('book, node_id::text as node_key, "charData"::text as char_key, count(*) as n')
            ->groupByRaw('book, node_id::text, "charData"::text')
            ->havingRaw('count(*) > 1');

        if ($bookFilter) {
            // Cited side here; the citing side is filtered per group, since it
            // lives inside citedIN rather than in a column.
            $groupsQuery->where(function ($q) use ($bookFilter) {
                $q->where('book', $bookFilter)
                    ->orWhereRaw('"citedIN"::text like ?', ['%/'.$bookFilter.'#%']);
            });
        }

        $groups = $groupsQuery->get();

        $duplicateSets = 0;
        $skippedCoOwned = 0;
        $rowsDeleted = 0;
        $anchorsStripped = 0;
        $touchedBooks = [];

        foreach ($groups as $group) {
            $rows = $db->table('hypercites')
                ->where('book', $group->book)
                ->whereRaw('node_id::text = ?', [$group->node_key])
                ->whereRaw('"charData"::text = ?', [$group->char_key])
                ->orderBy('id')
                ->get(['id', 'hyperciteId', 'citedIN', 'created_at']);

            // Split by CITING book: two different books citing one passage is a
            // real poly hypercite, not a duplicate.
            $byCitingBook = [];
            foreach ($rows as $row) {
                foreach (json_decode((string) $row->citedIN, true) ?: [] as $entry) {
                    if (! is_string($entry) || ! str_starts_with($entry, '/')) {
                        continue;
                    }
                    $hash = strpos($entry, '#');
                    if ($hash === false) {
                        continue;
                    }
                    $citingBook = substr($entry, 1, $hash - 1);
                    $byCitingBook[$citingBook][] = (object) [
                        'row'      => $row,
                        'anchorId' => substr($entry, $hash + 1),
                    ];
                }
            }

            foreach ($byCitingBook as $citingBook => $entries) {
                if (count($entries) < 2) {
                    continue;
                }
                if ($bookFilter && $citingBook !== $bookFilter && $group->book !== $bookFilter) {
                    continue;
                }

                $duplicateSets++;

                // Ownership decides the keeper. A candidate still pointing at a
                // row is the console's handle on it — keep that one, so revert
                // keeps working. Two owned rows means two bibliography entries
                // resolved to one work: real, tracked, and not ours to delete.
                $ids = array_map(fn ($e) => $e->row->hyperciteId, $entries);
                $owned = $db->table('hypercite_candidates')
                    ->where('cited_book', $group->book)
                    ->whereIn('hypercite_id', $ids)
                    ->pluck('hypercite_id')
                    ->all();

                $this->line('');
                $this->line("  cited {$group->book} · citing {$citingBook}");
                foreach ($entries as $entry) {
                    $flag = in_array($entry->row->hyperciteId, $owned, true) ? 'tracked' : 'ORPHAN';
                    $this->line("    {$entry->row->hyperciteId}  anchor {$entry->anchorId}  [{$flag}]  {$entry->row->created_at}");
                }

                if (count($owned) > 1) {
                    $skippedCoOwned++;
                    $this->warn('    ↳ two tracked candidates — review by hand, not auto-fixable');

                    continue;
                }

                $keeper = null;
                foreach ($entries as $entry) {
                    if (in_array($entry->row->hyperciteId, $owned, true)) {
                        $keeper = $entry;
                        break;
                    }
                }
                $keeper ??= $entries[0]; // none tracked — keep the oldest

                foreach ($entries as $entry) {
                    if ($entry === $keeper) {
                        continue;
                    }
                    $this->line("    ↳ drop {$entry->row->hyperciteId} (keeping {$keeper->row->hyperciteId})");

                    if (! $fix) {
                        continue;
                    }

                    $stripped = $this->stripAnchor($db, $citingBook, $entry->anchorId);
                    $anchorsStripped += $stripped;
                    $db->table('hypercites')->where('id', $entry->row->id)->delete();
                    $rowsDeleted++;
                    $touchedBooks[$citingBook] = true;
                    $touchedBooks[$group->book] = true;
                }
            }
        }

        if ($fix && $touchedBooks !== []) {
            // Clocks set DIRECTLY on pgsql_admin, never through
            // update_annotations_timestamp() — that SECURITY DEFINER function
            // opens a second connection onto the same library row and deadlocks
            // under a wrapping transaction (see HyperciteMinter's note).
            $nowMs = (int) round(microtime(true) * 1000);
            $db->table('library')->whereIn('book', array_keys($touchedBooks))
                ->update(['annotations_updated_at' => $nowMs, 'timestamp' => $nowMs]);
        }

        $this->newLine();
        if ($duplicateSets === 0) {
            $this->info('✅ No duplicate hypercites found.');

            return 0;
        }

        $this->info("Found {$duplicateSets} duplicate set(s).");
        if ($skippedCoOwned > 0) {
            $this->warn("{$skippedCoOwned} skipped as co-owned (two tracked candidates over one passage).");
        }
        if ($fix) {
            $this->info("Deleted {$rowsDeleted} hypercites row(s); stripped {$anchorsStripped} ↗ anchor(s).");
            $this->line('Readers hold these books in IndexedDB — a hard refresh (or the console\'s pane purge) is needed to see the change.');
        } else {
            $this->warn('Re-run with --fix to apply.');
        }

        return 0;
    }

    /**
     * Remove one ↗ anchor from whichever node in the citing book carries it,
     * then relocate that node's other annotations. Same regex as
     * HyperciteMinter::unmint — matched on the anchor's own element id, so it
     * can only ever cut the anchor, never surrounding prose.
     */
    private function stripAnchor($db, string $citingBook, string $anchorId): int
    {
        $needle = 'id="'.$anchorId.'"';
        $nodes = $db->table('nodes')
            ->where('book', $citingBook)
            ->where('content', 'like', '%'.$needle.'%')
            ->get(['node_id', 'content']);

        $stripped = 0;
        foreach ($nodes as $node) {
            $old = (string) $node->content;
            $new = preg_replace(
                '/\x{2060}?<a\s[^>]*id="'.preg_quote($anchorId, '/').'"[^>]*>[^<]*<\/a>/us',
                '',
                $old,
                1
            ) ?? $old;

            if ($new === $old) {
                $this->warn("      ⚠️  anchor {$anchorId} found in {$node->node_id} but did not match the cut pattern — left alone");

                continue;
            }

            $db->table('nodes')
                ->where('book', $citingBook)
                ->where('node_id', $node->node_id)
                ->update(['content' => $new, 'updated_at' => now()]);

            // The cut shifted every downstream charData offset on this node.
            CharDataRecalculator::recalcForNodes($citingBook, [
                $node->node_id => ['old' => $old, 'new' => $new],
            ]);

            // Keep the candidates that measured this node current, so the next
            // detect doesn't read our own edit as drift.
            $db->table('hypercite_candidates')
                ->where('citing_book', $citingBook)
                ->where('citing_node_id', $node->node_id)
                ->where('citing_content_hash', sha1($old))
                ->update(['citing_content_hash' => sha1($new), 'updated_at' => now()]);

            $stripped++;
        }

        return $stripped;
    }
}
