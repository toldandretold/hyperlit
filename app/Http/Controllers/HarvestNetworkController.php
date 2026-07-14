<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * The standalone (non-SPA) 3D view of a harvest's knowledge network — the
 * "Explore in 3D" expansion of the Source Yield Report's embedded fork tree.
 *
 * Authorization = the REPORT book's visibility (commons reports are public,
 * user reports private — YieldReportBook::findOrMintReportRow), checked the
 * same way DatabaseToIndexedDBController does: the check_book_visibility
 * SECURITY DEFINER function computes is_owner from the RLS session vars.
 * Unauthorized/missing is always a 404 — a private report's existence must
 * not leak. Data reads go via pgsql_admin AFTER that check (the controller
 * check is the authorization boundary, same posture as SourceHarvestController).
 */
class HarvestNetworkController extends Controller
{
    /** The full-viewport Three.js page. */
    public function show(Request $request, string $rootBook)
    {
        $this->authorizeReport($request, $rootBook);

        $root = DB::connection('pgsql_admin')->table('library')
            ->where('book', $rootBook)->first(['title', 'author']);

        return view('harvest-network', [
            'rootBook'  => $rootBook,
            'rootTitle' => $root->title ?? $rootBook,
            'rootAuthor' => $root->author ?? null,
        ]);
    }

    /**
     * The harvest network as {nodes, edges} JSON, reconstructed from the
     * report row's cumulative_results (see YieldReportBook — entries carry
     * depth/parent_book since the lineage change; legacy entries default to
     * a 1-level fan from the root).
     */
    public function data(Request $request, string $rootBook): JsonResponse
    {
        $reportRow = $this->authorizeReport($request, $rootBook);

        $raw = json_decode($reportRow->raw_json ?? '', true);
        $union = is_array($raw['cumulative_results'] ?? null) ? $raw['cumulative_results'] : [];

        $db = DB::connection('pgsql_admin');
        $root = $db->table('library')->where('book', $rootBook)
            ->first(['title', 'author', 'year', 'cited_by_count']);

        // One enrichment query for entries missing year/cited_by_count
        // (legacy unions predate cited_by_count in the results shape).
        $needEnrich = array_values(array_filter(array_map(
            fn ($r) => (!isset($r['cited_by_count']) || !isset($r['year'])) ? ($r['canonical_source_id'] ?? null) : null,
            $union
        )));
        $enrich = $needEnrich === [] ? collect() : $db->table('canonical_source')
            ->whereIn('id', $needEnrich)->get(['id', 'year', 'cited_by_count'])->keyBy('id');

        $nodes = [[
            'id'             => $rootBook,
            'title'          => $root->title ?? $rootBook,
            'author'         => $root->author ?? null,
            'year'           => $root->year ?? null,
            'status'         => 'root',
            'depth'          => 0,
            'book'           => $rootBook,
            'cited_by_count' => $root->cited_by_count ?? null,
            'url'            => null,
            'journal'        => null,
            'publisher'      => null,
            'type'           => null,
            'reason'         => null,
        ]];
        $edges = [];

        // Held-book id → node id, for resolving depth ≥ 2 parents (a child's
        // parent_book is its citing work's auto_version_book).
        $byBook = [];
        foreach ($union as $r) {
            $id = $r['canonical_source_id'] ?? ($r['title'] ?? null);
            if ($id !== null && !empty($r['book'])) {
                $byBook[$r['book']] = $id;
            }
        }

        foreach ($union as $r) {
            $id = $r['canonical_source_id'] ?? ($r['title'] ?? null);
            if ($id === null) {
                continue; // no stable identity — can't be a graph node
            }
            $extra = $enrich->get($r['canonical_source_id'] ?? '');
            $nodes[] = [
                'id'             => $id,
                'title'          => $r['title'] ?? 'Untitled',
                'author'         => $r['author'] ?? null,
                'year'           => $r['year'] ?? $extra?->year,
                'status'         => $r['status'] ?? 'error',
                'depth'          => (int) ($r['depth'] ?? 1),
                'book'           => $r['book'] ?? null,
                'cited_by_count' => $r['cited_by_count'] ?? $extra?->cited_by_count,
                'url'            => $this->bestLink($r),
                // Citation details for the click panel.
                'journal'        => $r['journal'] ?? null,
                'publisher'      => $r['publisher'] ?? null,
                'type'           => $r['type'] ?? null,
                'reason'         => $r['reason'] ?? null,
            ];

            // Parent: the root, a sibling entry's held book, or (orphan —
            // parent harvested under a different root, legacy data) the root.
            $parentBook = $r['parent_book'] ?? $rootBook;
            $source = $parentBook === $rootBook
                ? $rootBook
                : ($byBook[$parentBook] ?? $rootBook);
            $edges[] = ['source' => $source === $id ? $rootBook : $source, 'target' => $id];
        }

        return response()->json(['nodes' => $nodes, 'edges' => $edges]);
    }

    /**
     * 404 unless the caller may see this root's yield report; returns the
     * report's library row (pgsql_admin) when authorized.
     */
    private function authorizeReport(Request $request, string $rootBook): object
    {
        $reportBookId = 'source-yield-report-' . $rootBook;

        // Default connection: check_book_visibility computes is_owner from the
        // RLS session vars the middleware set for THIS caller.
        $info = DB::selectOne('SELECT * FROM check_book_visibility(?)', [$reportBookId]);

        if (!$info || $info->visibility === 'deleted') {
            abort(404);
        }
        if ($info->visibility === 'private' && !$info->is_owner) {
            // Username fallback, same as DatabaseToIndexedDBController.
            $user = Auth::user();
            if (!$user || $info->creator !== $user->name) {
                abort(404); // don't leak a private report's existence
            }
        }

        $row = DB::connection('pgsql_admin')->table('library')->where('book', $reportBookId)->first();
        if (!$row) {
            abort(404);
        }
        return $row;
    }

    /** Best external URL for a work — mirror of YieldReportBook::bestLink. */
    private function bestLink(array $r): ?string
    {
        if (!empty($r['doi']))     return 'https://doi.org/' . $r['doi'];
        if (!empty($r['oa_url']))  return $r['oa_url'];
        if (!empty($r['pdf_url'])) return $r['pdf_url'];
        return null;
    }
}
