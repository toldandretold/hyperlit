<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Services\Citations\AmbiguousCitationRegistry;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * /maintainer/citations — the review queue for AMBIGUOUS citation resolutions.
 *
 * The converter's antecedent walk-back links a bare-year citation to its best-guess bibliography
 * entry but, when more than one entry fits, stores the question (`data-candidates` on the anchor →
 * a pending `citation_resolutions` row via AmbiguousCitationRegistry). This console lists those
 * questions with everything a human needs to answer from the list itself — the citation's own
 * sentence, each candidate's full bibliography entry, and how often the book cites each candidate
 * properly elsewhere — plus a deep link into the reader for the cases that need more context.
 *
 * An answer PATCHES THE STORED NODES immediately (choose an entry → confirmed link; "not a
 * citation" → unlinked text) and persists in the ledger, which every later reconvert re-applies.
 *
 * Web page: admin checked in-controller, non-admins 404 (the house pattern — the page is not
 * advertised). API routes sit behind auth:sanctum + admin in routes/api.php.
 */
class CitationConsoleController extends Controller
{
    /** GET /maintainer/citations */
    public function index(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-citations');
    }

    /**
     * GET /api/maintainer/citations/ambiguous — every pending question, grouped by book,
     * ordered so the books with the most open questions surface first.
     */
    public function pending(Request $request)
    {
        $db = DB::connection('pgsql_admin');

        $rows = $db->table('citation_resolutions as cr')
            ->leftJoin('library as l', 'l.book', '=', 'cr.book')
            ->where('cr.status', 'pending')
            ->orderBy('cr.book')->orderBy('cr.created_at')
            ->get([
                'cr.id', 'cr.book', 'cr.year', 'cr.sentence', 'cr.candidates',
                'cr.href_current', 'cr.created_at', 'l.title', 'l.slug',
            ]);

        $books = $rows->groupBy('book')->map(function ($group) {
            $first = $group->first();
            return [
                'book'   => $first->book,
                'title'  => (string) ($first->title ?? $first->book),
                'slug'   => $first->slug,
                'items'  => $group->map(fn ($r) => [
                    'id'           => $r->id,
                    'year'         => $r->year,
                    'sentence'     => $r->sentence,
                    'href_current' => $r->href_current,
                    'candidates'   => json_decode($r->candidates, true) ?? [],
                ])->values(),
            ];
        })->sortByDesc(fn ($b) => count($b['items']))->values();

        return response()->json([
            'pending_books' => $books,
            'pending_total' => $rows->count(),
            'resolved_total' => (int) $db->table('citation_resolutions')
                ->where('status', 'resolved')->count(),
        ]);
    }

    /**
     * POST /api/maintainer/citations/ambiguous/{id}/resolve
     * body: { "choice": "<entry id>" } or { "choice": null } for "not a citation".
     */
    public function resolve(Request $request, string $id, AmbiguousCitationRegistry $registry)
    {
        // `choice` must be PRESENT — null is a meaningful answer ("not a citation"), so its
        // absence cannot be its encoding, or a malformed body would silently unlink.
        if (! $request->exists('choice')) {
            return response()->json(['error' => 'choice_required'], 422);
        }
        $choice = $request->input('choice');
        if ($choice !== null && (! is_string($choice) || $choice === '')) {
            return response()->json(['error' => 'choice_invalid'], 422);
        }

        $result = $registry->resolve($id, $choice, (string) $request->user()->name);

        if (isset($result['error'])) {
            return response()->json($result, $result['error'] === 'not_found' ? 404 : 422);
        }

        return response()->json($result);
    }
}
