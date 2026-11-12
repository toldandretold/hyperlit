<?php

namespace App\Http\Controllers;

use App\Models\ArchiveSource;
use App\Services\Archives\ArchiveIdentity;
use App\Services\Archives\ArchiveReadableCount;
use App\Services\Archives\CertifiedArchivesQuery;
use Illuminate\Support\Facades\Cache;
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

    public function show(string $slug, ArchiveReadableCount $readableCount, ArchiveIdentity $identity)
    {
        $archive = ArchiveSource::where('slug', $slug)->first();
        if (!$archive) {
            abort(404, 'Archive not found');
        }

        // An owner-minted archive borrows its shelf's LIVE name/description
        // (ArchiveIdentity). Resolved onto the in-memory model only — never
        // saved — so the blade and JSON-LD read one set of fields.
        // Resolve BOTH before assigning: about() keys off a NULL display_name.
        [$name, $about] = [$identity->name($archive), $identity->about($archive)];
        $ownerMinted = $identity->isOwnerMinted($archive);
        $archive->display_name = $name;
        $archive->about = $about;

        // The shelf's owner edits an owner-minted archive in place (title =
        // shelf name, about = shelf description, saved via PATCH /api/shelves).
        // A maintainer archive's copy is edited in the shelf-import console.
        $viewer = auth()->user();
        $canEdit = $ownerMinted && $viewer && $viewer->name === $identity->creator($archive);

        // Feeds only exist for a PUBLIC shelf — the arranger buttons hit the
        // public render endpoint. Read via pgsql_admin (shelves is RLS'd and a
        // guest's default connection can't see other creators' rows); the
        // explicit visibility check is the gate, mirroring publicRender.
        $shelfId = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $archive->shelf_id)
            ->where('visibility', 'public')
            ->value('id');

        // Viewer-independent public count (see ArchiveReadableCount::forPublic
        // — the RLS-per-request twin on journals cost seconds per page view on
        // prod; a visitor still only ever hears about public documents).
        $readable = $shelfId ? $readableCount->forPublic($archive->id, $shelfId) : 0;

        // The shelf's nominated OVERVIEW book (ShelfOverview) — a course intro
        // / reading-list readme. It is not one of the readings, so it leaves
        // the count. Whether it also stands in as this page's ABOUT is the
        // owner's choice (page setting `overview_as_about`, default OFF — see
        // below): by default the page keeps its own, directly-editable about.
        $overview = $shelfId ? \App\Services\Shelves\ShelfOverview::publicBook($shelfId) : null;
        if ($overview) {
            $readable = max(0, $readable - 1);
        }

        // Owner-minted archives get a real About BOOK (rich text, full editor —
        // ArchiveAboutBook). Minted on the owner's visit, only while the shelf
        // is PUBLIC (it's seeded from the description). Visitors see it once
        // it says something; until then the shelf description stands in.
        $aboutBookId = null;
        $aboutNodes = [];
        if ($ownerMinted) {
            $aboutBook = app(\App\Services\Archives\ArchiveAboutBook::class);
            if ($canEdit && $shelfId) {
                $shelfRow = DB::connection('pgsql_admin')->table('shelves')
                    ->where('id', $archive->shelf_id)->first(['id', 'name', 'description', 'creator']);
                if ($shelfRow) {
                    $aboutBook->ensure($shelfRow);
                }
            }
            $nodes = $aboutBook->nodes($archive->shelf_id);
            if ($nodes && ($canEdit || ($shelfId && \App\Services\Archives\ArchiveAboutBook::hasContent($nodes)))) {
                $aboutBookId = \App\Services\Archives\ArchiveAboutBook::bookId($archive->shelf_id);
                $aboutNodes = $nodes;
            }
        }

        // Page customization — the user page's vocabulary (userPageEditor +
        // UserPageSettingsValidator), stored on the About book's library row.
        // Every value is re-validated before it reaches the blade.
        $pageSettings = $ownerMinted ? app(\App\Services\Archives\ArchiveAboutBook::class)->settings($archive->shelf_id) : [];
        $imageNameOk = fn ($v) => is_string($v) && preg_match('/^[A-Za-z0-9._-]{1,255}$/', $v);
        $mediaBook = $ownerMinted ? \App\Services\Archives\ArchiveAboutBook::bookId($archive->shelf_id) : null;
        $logoImage = $imageNameOk($pageSettings['logo_image'] ?? null) ? $pageSettings['logo_image'] : null;
        $backgroundImage = $imageNameOk($pageSettings['background_image'] ?? null) ? $pageSettings['background_image'] : null;
        $backgroundArt = in_array($pageSettings['background_art'] ?? null, \App\Services\UserPageSettingsValidator::BACKGROUND_ARTS, true)
            ? $pageSettings['background_art'] : null;
        $showMap = $ownerMinted && $shelfId && (($pageSettings['show_map'] ?? null) !== false);

        // Opted in: the overview book renders as the about — read-only here
        // (it is edited at its own URL), capped, with a link to the whole text.
        $overviewNodes = [];
        $overviewTruncated = false;
        if ($overview && ($pageSettings['overview_as_about'] ?? null) === true) {
            $overviewNodes = DB::connection('pgsql_admin')->table('nodes')
                ->where('book', $overview->book)
                ->orderBy('startLine')
                ->limit(self::OVERVIEW_NODE_CAP + 1)
                ->get(['startLine', 'node_id', 'content'])
                ->all();
            $overviewTruncated = count($overviewNodes) > self::OVERVIEW_NODE_CAP;
            $overviewNodes = array_slice($overviewNodes, 0, self::OVERVIEW_NODE_CAP);
        }

        // Connection map: the hypercite network of the shelf's PUBLIC books
        // (JournalHyperciteMap, same figure as the user/journal pages). Cached
        // flexibly like the user page's — rebuilt deferred when stale.
        $hyperciteMap = null;
        if ($showMap) {
            $mapCached = Cache::flexible(self::mapCacheKey($archive->id), [900, 86400], function () use ($shelfId, $name, $overview) {
                $corpus = DB::connection('pgsql_admin')->table('shelf_items as si')
                    ->join('library as l', 'l.book', '=', 'si.book')
                    ->where('si.shelf_id', $shelfId)
                    ->where('l.visibility', 'public')
                    ->where('l.has_nodes', true)
                    ->where('l.book', 'NOT LIKE', '%/%')
                    ->when($overview, fn ($q) => $q->where('l.book', '!=', $overview->book))
                    ->get(['l.book', 'l.title', 'l.author', 'l.year', 'l.slug'])
                    ->keyBy('book')
                    ->map(fn ($r) => ['title' => (string) $r->title, 'author' => $r->author, 'year' => $r->year, 'slug' => $r->slug])
                    ->all();

                return ['svg' => app(\App\Services\JournalHarvest\JournalHyperciteMap::class)->buildSvgForBooks(
                    $corpus,
                    'Hypercite network of ' . $name,
                    ['noun' => 'document', 'plural' => 'documents', 'beyond' => 'beyond this archive'],
                )];
            });
            $hyperciteMap = $mapCached['svg'] ?? null;
        }

        // The blade renders about UNESCAPED (links belong in archive copy).
        // The write path already sanitizes; this covers rows saved before it did.
        // An owner-minted archive's about is the shelf description — PLAIN
        // text, which the blade escapes instead (aboutIsPlain).
        if (!$ownerMinted) {
            $archive->about = \App\Services\Security\NodeHtmlSanitizer::clean($archive->about);
        }

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
            'aboutIsPlain'    => $ownerMinted,
            'aboutBookId'     => $aboutBookId,
            'overviewNodes'   => $overviewNodes,
            'overviewUrl'     => $overview ? \App\Helpers\BookSlugHelper::canonicalPath($overview->book, $overview->slug ?: null) : null,
            'overviewTruncated' => $overviewTruncated,
            'mediaBook'       => $mediaBook,
            'logoImage'       => $logoImage,
            'backgroundImage' => $backgroundImage,
            'backgroundArt'   => $backgroundArt,
            'hyperciteMap'    => $hyperciteMap,
            'pageSettings'    => $canEdit ? array_intersect_key($pageSettings, array_flip(['logo_image', 'background_image', 'background_art', 'show_map', 'overview_as_about'])) : null,
            'aboutNodes'      => $aboutNodes,
            'archiveEdit'     => $canEdit ? [
                'shelfId'     => $archive->shelf_id,
                'name'        => $name,
                'mediaBook'   => $mediaBook,
            ] : null,
        ]);
    }

    /** How much of a nominated overview book the archive page shows inline. */
    private const OVERVIEW_NODE_CAP = 120;

    public static function mapCacheKey(string $archiveId): string
    {
        // Stores RENDERED markup — bump the version when the figure changes.
        return "archive-hypercite-map:{$archiveId}:v1";
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
