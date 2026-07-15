<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * The docuverse — a standalone (non-SPA) 3D map of every work in the database
 * that is CONNECTED to another work, wired by three edge layers the viewer
 * toggles (a fresh fetch per change — the graph is built server-side per
 * selection, so the client never downloads layers it isn't showing):
 *
 *   hypercite          — reader-made text↔text links (hypercites.citedIN);
 *                        human by construction, always trustworthy
 *   citation_verified  — bibliography rows whose canonical match the author
 *                        confirmed (reference_verified_at)
 *   citation_auto      — canonically RESOLVED but unconfirmed matches, from
 *                        BOTH bibliography rows AND footnote-borne citations
 *                        (footnotes.foundation_source → canonical; academic
 *                        footnote-cited books keep their references here, not
 *                        in bibliography)
 *
 * A node is a WORK: a canonical_source (merged with its held versions) or an
 * independent library record with no canonical identity. Anything with no
 * edge in the selected layers is NOT on the map.
 *
 * FOCUS mode (/3d/{bookId}, ?focus=): the same graph scoped to THAT BOOK'S
 * network — the works it draws on transitively (directed reachability, the
 * harvest-tree shape) plus its direct citers. See focusEdges() for why it is
 * NOT the connected component (giant-component degeneration).
 * The yield report links here: the harvest confirmed the book into a network.
 *
 * Visibility: library/bibliography/hypercites are read on the DEFAULT
 * connection, so RLS filters rows to exactly what this caller may see
 * (public + their own). canonical_source is public citation metadata.
 */
class DocuverseController extends Controller
{
    private const LAYERS = ['hypercite', 'citation_verified', 'citation_auto'];

    public function show(Request $request, ?string $rootBook = null)
    {
        $focusTitle = null;
        if ($rootBook !== null) {
            // RLS-visible or the page doesn't exist for this caller.
            $row = DB::table('library')->where('book', $rootBook)->first(['title']);
            if (!$row) {
                abort(404);
            }
            $focusTitle = strip_tags($row->title ?? $rootBook);
        }

        return view('docuverse', ['focusBook' => $rootBook, 'focusTitle' => $focusTitle]);
    }

    public function data(Request $request): JsonResponse
    {
        // All three layers default ON. Verification is a rare manual act —
        // near-every citation is auto-matched, so a default that excluded
        // citation_auto rendered NO citations at all on a default view.
        $layers = array_values(array_intersect(
            self::LAYERS,
            array_filter(explode(',', (string) $request->query('layers', 'hypercite,citation_verified,citation_auto')))
        ));
        if ($layers === []) {
            return response()->json(['nodes' => [], 'edges' => [], 'layers' => []]);
        }

        // Focus mode builds ALL kinds regardless of the selected layers: the
        // book's network MEMBERSHIP is a property of the graph, not of what
        // the viewer chose to display (hypercites-only must still know which
        // works are in the citation network). Selected layers filter the
        // RESPONSE at the end; the global view still builds selected-only.
        $focusRequested = (string) $request->query('focus', '') !== '';
        $build = $focusRequested ? self::LAYERS : $layers;

        // RLS-filtered (default connection): only books this caller may see.
        // Sub-books (book_x/Fn…) are folded into their root work.
        $books = DB::table('library')
            ->whereRaw("book NOT LIKE '%/%'")
            ->get(['book', 'title', 'author', 'year', 'canonical_source_id', 'cited_by_count', 'doi', 'oa_url']);
        $bookRows = $books->keyBy('book');

        // book id → graph node id (its canonical when linked, else itself).
        $nodeIdForBook = fn (string $book): ?string => ($row = $bookRows->get($book))
            ? ($row->canonical_source_id ?: $book)
            : null;

        $edges = [];
        $addEdge = function (?string $source, ?string $target, string $kind) use (&$edges): void {
            if (!$source || !$target || $source === $target) {
                return;
            }
            $edges["{$source}→{$target}:{$kind}"] = ['source' => $source, 'target' => $target, 'kind' => $kind];
        };

        // ── Citation layers ──
        $wantVerified = in_array('citation_verified', $build, true);
        $wantAuto = in_array('citation_auto', $build, true);
        if ($wantVerified || $wantAuto) {
            // Direct canonical link + the foundation-source stub pathway
            // (both RLS-filtered; l.canonical_source_id resolves a stub to its
            // canonical, else the stub book itself is the target work).
            $bib = DB::table('bibliography as b')
                ->leftJoin('library as l', 'l.book', '=', 'b.foundation_source')
                ->where(function ($q) {
                    $q->whereNotNull('b.canonical_source_id')->orWhereNotNull('b.foundation_source');
                })
                ->get(['b.book', 'b.canonical_source_id', 'b.foundation_source', 'b.reference_verified_at', 'l.canonical_source_id as stub_canonical']);

            foreach ($bib as $r) {
                $kind = $r->reference_verified_at ? 'citation_verified' : 'citation_auto';
                if (($kind === 'citation_verified' && !$wantVerified) || ($kind === 'citation_auto' && !$wantAuto)) {
                    continue;
                }
                $target = $r->canonical_source_id
                    ?: ($r->stub_canonical ?: ($r->foundation_source && $bookRows->has($r->foundation_source) ? $r->foundation_source : null));
                $addEdge($nodeIdForBook($this->rootBook($r->book)), $target, $kind);
            }

            // Footnote-borne citations — academic footnote texts (Publishing
            // Beyond the Market et al.) carry their references here, NOT in
            // `bibliography`, resolving to a canonical via the foundation_source
            // stub exactly like the bib branch. Omitting this made footnote-cited
            // books show ZERO citation edges (only hypercites) despite a full
            // harvest. Footnotes carry no verified marker → always auto; this
            // mirrors HarvestEligibility::reachedCanonicalIdsSubquery so the
            // docuverse and the harvest agree on what "connected" means.
            if ($wantAuto) {
                $fn = DB::table('footnotes as f')
                    ->leftJoin('library as l', 'l.book', '=', 'f.foundation_source')
                    ->where('f.is_citation', true)
                    ->whereNotNull('f.foundation_source')
                    ->get(['f.book', 'f.foundation_source', 'l.canonical_source_id as stub_canonical']);

                foreach ($fn as $r) {
                    $target = $r->stub_canonical
                        ?: ($bookRows->has($r->foundation_source) ? $r->foundation_source : null);
                    $addEdge($nodeIdForBook($this->rootBook($r->book)), $target, 'citation_auto');
                }
            }
        }

        // ── Hypercite layer ──
        if (in_array('hypercite', $build, true)) {
            $rows = DB::table('hypercites')
                ->whereRaw('"citedIN" IS NOT NULL AND "citedIN"::text NOT IN (\'[]\', \'null\')')
                ->get(['book', 'citedIN']);
            foreach ($rows as $r) {
                $targets = json_decode($r->citedIN, true);
                if (!is_array($targets)) {
                    continue;
                }
                $source = $nodeIdForBook($this->rootBook($r->book));
                foreach ($targets as $url) {
                    // Entries look like "/book_123…#hypercite_abc" (sub-book paths fold to root).
                    $path = parse_url((string) $url, PHP_URL_PATH) ?: '';
                    $targetBook = $this->rootBook(ltrim($path, '/'));
                    if ($targetBook === '') {
                        continue;
                    }
                    // RLS already hid invisible books from $bookRows → edge drops.
                    $addEdge($source, $nodeIdForBook($targetBook), 'hypercite');
                }
            }
        }

        $edges = array_values($edges);

        // ── Focus: scope to THIS BOOK'S network, not its whole component ──
        $focusNodeId = null;
        if (($focusBook = (string) $request->query('focus', '')) !== '') {
            $focusBook = $this->rootBook($focusBook);
            if (!$bookRows->has($focusBook)) {
                abort(404); // invisible or nonexistent — don't leak
            }
            $focusNodeId = $nodeIdForBook($focusBook);
            $edges = $this->focusEdges($edges, $focusNodeId);
            // Membership was computed over ALL kinds; the viewer only gets
            // the layers they selected.
            $edges = array_values(array_filter(
                $edges,
                fn (array $e) => in_array($e['kind'], $layers, true),
            ));
        }

        // ── Connected-only node set ──
        $nodeIds = [];
        foreach ($edges as $e) {
            $nodeIds[$e['source']] = true;
            $nodeIds[$e['target']] = true;
        }

        // Canonical metadata for canonical-backed nodes (public metadata; the
        // held-version pointer makes the node openable in the library).
        $canonicalIds = array_values(array_filter(array_keys($nodeIds), fn ($id) => !$bookRows->has($id)));
        $canonicals = $canonicalIds === [] ? collect() : DB::connection('pgsql_admin')
            ->table('canonical_source')->whereIn('id', $canonicalIds)
            ->get()->keyBy('id');

        // A canonical is ONE sphere no matter how many versions the library
        // holds — the panel lists them all. Caller-visible versions only
        // (RLS-filtered); the canonical's version pointers are the fallback.
        $versionsByCanonical = $books->whereNotNull('canonical_source_id')->groupBy('canonical_source_id');

        $nodes = [];
        foreach (array_keys($nodeIds) as $id) {
            if ($bookRows->has($id)) {
                $b = $bookRows->get($id);
                $nodes[] = [
                    'id' => $id, 'kind' => 'book',
                    'title' => strip_tags($b->title ?? $id), 'author' => $b->author,
                    'year' => $b->year, 'cited_by_count' => $b->cited_by_count,
                    'book' => $id,
                    'versions' => [],
                    'url' => $b->doi ? ('https://doi.org/' . $b->doi) : $b->oa_url,
                ];
            } elseif ($c = $canonicals->get($id)) {
                $versions = ($versionsByCanonical->get($id) ?? collect())
                    ->map(fn ($b) => ['book' => $b->book, 'title' => strip_tags($b->title ?? $b->book)])
                    ->values()->all();
                $held = $versions[0]['book']
                    ?? ($c->commons_version_book ?: ($c->author_version_book ?: ($c->publisher_version_book ?: $c->auto_version_book)));
                $nodes[] = [
                    'id' => $id, 'kind' => $held ? 'held' : 'canonical',
                    'title' => strip_tags($c->title ?? 'Untitled'), 'author' => $c->author,
                    'year' => $c->year, 'cited_by_count' => $c->cited_by_count,
                    'book' => $held,
                    'versions' => $versions,
                    'url' => $c->doi ? ('https://doi.org/' . $c->doi) : ($c->oa_url ?: $c->pdf_url),
                ];
            }
            // else: an edge endpoint that resolved to nothing readable — its
            // edges get dropped client-side by the missing-node guard.
        }

        return response()->json([
            'nodes' => $nodes,
            'edges' => $edges,
            'layers' => $layers,
            'focus' => $focusNodeId,
        ]);
    }

    /**
     * The focus book's OWN network. Membership:
     *   1. transitive DRAWS-ON reach over CITATION edges only (source→target
     *      — the harvest / yield-report tree shape);
     *   2. plus everything touching the focus directly, either direction, any
     *      kind (direct citers, the book's own hypercite partners).
     * Kept edges: those with BOTH endpoints in the membership — hypercites
     * between network members display; they never EXTEND the network.
     *
     * Two degenerations this shape exists to prevent: the undirected connected
     * component (any co-cited work merges components → the whole docuverse),
     * and hypercite traversal (hypercite edges point cited→citing — the
     * REVERSE of citation edges — so walking them lets the reach escape
     * through any hypercited work and pull the docuverse back in).
     */
    private function focusEdges(array $edges, string $start): array
    {
        // 1. Citation-directed transitive reach.
        $citesFrom = [];
        foreach ($edges as $e) {
            if ($e['kind'] !== 'hypercite') {
                $citesFrom[$e['source']][] = $e['target'];
            }
        }
        $members = [$start => true];
        $queue = [$start];
        while ($queue !== []) {
            $node = array_shift($queue);
            foreach ($citesFrom[$node] ?? [] as $target) {
                if (!isset($members[$target])) {
                    $members[$target] = true;
                    $queue[] = $target;
                }
            }
        }

        // 2. One hop around the focus itself, any kind, either direction.
        foreach ($edges as $e) {
            if ($e['source'] === $start) {
                $members[$e['target']] = true;
            }
            if ($e['target'] === $start) {
                $members[$e['source']] = true;
            }
        }

        // 3. Only edges INSIDE the membership.
        return array_values(array_filter(
            $edges,
            fn (array $e) => isset($members[$e['source']]) && isset($members[$e['target']]),
        ));
    }

    /** Fold a sub-book path (book_x/Fn1/…) onto its root work. */
    private function rootBook(string $book): string
    {
        return explode('/', $book)[0];
    }
}
