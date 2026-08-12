<?php

namespace App\Http\Controllers;

use App\Models\JournalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

/**
 * Public journal pages: /j (diamond-OA registry index) and /j/{slug} (one
 * journal's works, most-cited first, linking each to its best readable
 * version). Read-only over journal_sources + canonical_source; the harvest
 * populates both (see app/Services/JournalHarvest/README.md).
 *
 * Reads go through the DEFAULT connection so library visibility is the
 * caller's RLS view. A version is linked when it is visible AND has content
 * (has_nodes); versions that have not yet passed /maintainer/conversion
 * review (listed=false) are linked but marked "unreviewed" — hiding them
 * would hide the whole corpus, since only FLAGGED books have an approval
 * path, and junk gets flagged → retracted → deleted (dropping off this page)
 * rather than sitting unlisted.
 */
class JournalPageController extends Controller
{
    private const WORKS_PER_PAGE = 100;

    public function index()
    {
        $journals = JournalSource::query()
            ->where('is_diamond', true)
            ->orderByRaw('cited_by_count DESC NULLS LAST')
            ->paginate(100);

        return view('journal-index', ['journals' => $journals]);
    }

    public function show(string $slug)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (!$journal) {
            abort(404, 'Journal not found');
        }

        // One query for the whole page: canonicals + (via the registry's
        // precedence COALESCE) each work's best version's library row. RLS on
        // the join hides rows this caller may not see; has_nodes gates the link.
        $bestVersion = BestVersionService::sqlCoalesceExpression('cs');
        $works = DB::table('canonical_source as cs')
            ->leftJoin('library as l', 'l.book', '=', DB::raw("({$bestVersion})"))
            ->where('cs.journal_source_id', $journal->id)
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST')
            ->select([
                'cs.title', 'cs.author', 'cs.year', 'cs.doi',
                'cs.cited_by_count', 'cs.type',
                'l.book as version_book',
                'l.has_nodes as version_has_nodes',
                'l.listed as version_listed',
            ])
            ->paginate(self::WORKS_PER_PAGE);

        $shelf = $journal->shelf_id
            ? DB::table('shelves')->where('id', $journal->shelf_id)->first(['slug', 'creator', 'visibility'])
            : null;

        return view('journal', [
            'journal'   => $journal,
            'works'     => $works,
            'readable'  => DB::table('canonical_source as cs')
                ->join('library as l', 'l.book', '=', DB::raw("({$bestVersion})"))
                ->where('cs.journal_source_id', $journal->id)
                ->where('l.has_nodes', true)
                ->count(),
            'shelfUrl'  => ($shelf && $shelf->visibility === 'public')
                ? '/u/' . rawurlencode($shelf->creator) . '/shelf/' . rawurlencode($shelf->slug)
                : null,
        ]);
    }
}
