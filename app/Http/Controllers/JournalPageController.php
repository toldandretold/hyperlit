<?php

namespace App\Http\Controllers;

use App\Models\JournalSource;
use App\Services\JournalHarvest\JournalAboutComposer;
use App\Services\JournalHarvest\JournalHyperciteMap;
use App\Services\JournalHarvest\JournalReadableCount;
use Illuminate\Support\Facades\DB;

/**
 * Public journal pages: /j (diamond-OA registry index, static blade) and
 * /j/{slug} — a homepage-class hero page (lava lamp + shelf-backed feeds).
 * The feeds themselves are the journal's public shelf rendered with
 * sort=published|connected|lit through the existing shelf pipeline; this
 * controller only serves the hero shell + about copy + counts. See
 * app/Services/JournalHarvest/README.md and docs/journal-harvest.md.
 *
 * Count reads go through the DEFAULT connection so library visibility is the
 * caller's RLS view.
 */
class JournalPageController extends Controller
{
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

        // One definition of "readable", shared with the homepage's certified-journal
        // list — see JournalReadableCount. Still the DEFAULT connection, so the
        // count stays the caller's RLS view of `library`.
        $readable = app(JournalReadableCount::class)->for($journal->id);

        $total = DB::table('canonical_source')
            ->where('journal_source_id', $journal->id)
            ->count();

        // Feeds only exist for a PUBLIC shelf — the arranger buttons hit the
        // public render endpoint. Read via pgsql_admin (shelves is RLS'd and a
        // guest's default connection can't see other creators' rows); the
        // explicit visibility check is the gate, mirroring publicRender.
        $shelfId = null;
        if ($journal->shelf_id) {
            $shelfId = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $journal->shelf_id)
                ->where('visibility', 'public')
                ->value('id');
        }

        $description = $journal->display_name
            . ($journal->publisher ? ' (' . $journal->publisher . ')' : '')
            . ' — ' . ($journal->is_diamond ? 'diamond open access' : 'open access')
            . " journal on Hyperlit: {$readable} readable article" . ($readable === 1 ? '' : 's') . '.';

        return view('journal-home', [
            'pageType'        => 'journal',
            'pageTitle'       => $journal->display_name . ' — Hyperlit',
            'pageDescription' => $description,
            'canonicalUrl'    => url('/j/' . $journal->slug),
            'jsonLd'          => $this->buildJournalJsonLd($journal),
            'journal'         => $journal,
            'shelfId'         => $shelfId,
            'about'           => app(JournalAboutComposer::class)->compose($journal),
            'readable'        => $readable,
            'total'           => $total,
            // Both blob variants render while the keeper is being chosen —
            // drop the loser from the blade once decided (see the map service).
            'hyperciteMaps'   => [
                'all'       => app(JournalHyperciteMap::class)->svg($journal, 'all'),
                'connected' => app(JournalHyperciteMap::class)->svg($journal, 'connected'),
            ],
        ]);
    }

    private function buildJournalJsonLd(JournalSource $journal): array
    {
        return array_filter([
            '@context'  => 'https://schema.org',
            '@type'     => 'Periodical',
            'name'      => $journal->display_name,
            'issn'      => $journal->issn_l,
            'publisher' => $journal->publisher
                ? ['@type' => 'Organization', 'name' => $journal->publisher]
                : null,
            'url'       => url('/j/' . $journal->slug),
            'sameAs'    => $journal->homepage_url,
        ]);
    }
}
