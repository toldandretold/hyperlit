<?php

namespace App\Http\Controllers;

use App\Models\ArchiveSource;
use App\Services\Archives\ArchiveReadableCount;
use App\Services\Archives\CertifiedArchivesQuery;
use Illuminate\Support\Facades\DB;

/**
 * Public archive pages: /a (certified archives, static list) and /a/{slug} —
 * a homepage-class hero page like /j/{slug}, minus the journal machinery. The
 * feeds ARE the archive's public shelf rendered with sort=published|connected|
 * lit through the existing shelf pipeline; this controller serves the hero
 * shell + the maintainer's hand-written about copy + the readable count. See
 * docs/web-scrape-import.md.
 */
class ArchivePageController extends Controller
{
    public function index(CertifiedArchivesQuery $certified)
    {
        return view('archive-index', ['archives' => $certified->forHomepage()]);
    }

    public function show(string $slug, ArchiveReadableCount $readableCount)
    {
        $archive = ArchiveSource::where('slug', $slug)->first();
        if (!$archive) {
            abort(404, 'Archive not found');
        }

        // Feeds only exist for a PUBLIC shelf — the arranger buttons hit the
        // public render endpoint. Read via pgsql_admin (shelves is RLS'd and a
        // guest's default connection can't see other creators' rows); the
        // explicit visibility check is the gate, mirroring publicRender.
        $shelfId = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $archive->shelf_id)
            ->where('visibility', 'public')
            ->value('id');

        $readable = $shelfId ? $readableCount->for($archive->id, $shelfId) : 0;

        $description = $archive->display_name
            . " — a hypertext archive on Hyperlit: {$readable} readable document"
            . ($readable === 1 ? '' : 's') . '.';

        return view('archive-home', [
            // 'journal' deliberately: the archive page IS the journal-page
            // component set (hero, journalSearch, shelf feed tabs) — a new
            // page type would need adding to every ButtonRegistry pages list
            // for zero behavioural difference.
            'pageType'        => 'journal',
            'pageTitle'       => $archive->display_name . ' — Hyperlit',
            'pageDescription' => $description,
            'canonicalUrl'    => url('/a/' . $archive->slug),
            'jsonLd'          => $this->buildArchiveJsonLd($archive),
            'archive'         => $archive,
            'shelfId'         => $shelfId,
            'readable'        => $readable,
        ]);
    }

    private function buildArchiveJsonLd(ArchiveSource $archive): array
    {
        return array_filter([
            '@context' => 'https://schema.org',
            '@type'    => 'Collection',
            'name'     => $archive->display_name,
            'url'      => url('/a/' . $archive->slug),
        ]);
    }
}
