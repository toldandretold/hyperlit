<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Http\Controllers\Maintainer\Concerns\BuildsImportLanes;
use App\Jobs\JournalImportActionJob;
use App\Models\ArchiveSource;
use App\Models\JournalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\ReconvertQueue;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * /maintainer/shelf-import — the journal-import console generalized to a SHELF:
 * assess the works collected on any public shelf (above all the "Cited by:"
 * shelves the hypercite console's bulk import fills) with the same three-pane
 * workflow — article list with sibling LANES nested, the produced book framed
 * beside its original source, promote / reconvert / flag actions.
 *
 * Deliberately a thin sibling of JournalImportController, not a scope rewrite
 * of it: the lane payload comes from the shared BuildsImportLanes trait, the
 * article actions dispatch the SAME JournalImportActionJob (null-journal-safe
 * for all three), and promote/resolve/runStatus are already book- or run-keyed
 * so the frontend keeps calling the journal-import endpoints. Only `articles`
 * and `run` needed shelf-scoped variants. Journal-registry actions (enumerate,
 * import_all) have no meaning here and are refused.
 *
 * URL identity: `/maintainer/shelf-import/{uuid}` — shelf slugs are only
 * unique per creator, same reasoning as the hypercite console. A journal slug
 * is accepted as a convenience alias and redirects to that journal's
 * "Cited by:" shelf when one exists.
 *
 * Web routes: admin checked in-controller, non-admins 404 (house pattern).
 * API routes sit behind auth:sanctum + admin in routes/api.php.
 */
class ShelfImportController extends Controller
{
    use BuildsImportLanes;

    /** The article actions a shelf scope can fire — no journal-registry actions. */
    private const ACTIONS = ['import', 'reconvert_html', 'refetch_html'];

    /** Public shelf by uuid, or null. Same rule as HyperciteConsoleController::shelfScope. */
    private function publicShelf(string $id): ?object
    {
        if (! Str::isUuid($id)) {
            return null;
        }

        return DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('visibility', 'public')
            ->first();
    }

    /** GET /maintainer/shelf-import — pick a shelf. */
    public function index(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-shelf-import', ['shelfId' => null, 'shelfName' => null]);
    }

    /**
     * GET /maintainer/shelf-import/{id} — work one shelf. `{id}` is a shelf
     * uuid; slugs redirect as a readable-URL convenience, tried in order:
     * an ARCHIVE slug (archive_sources → its shelf), a public SHELF slug
     * (only when exactly one public shelf carries it — shelf slugs are
     * unique per creator, not globally), then a journal SLUG (that
     * journal's "Cited by:" shelf, when the hypercite console made one).
     */
    public function show(Request $request, string $id)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            $shelfId = $this->shelfIdForSlug($id);
            if ($shelfId) {
                return redirect("/maintainer/shelf-import/{$shelfId}");
            }
            abort(404);
        }

        return view('maintainer-shelf-import', ['shelfId' => $shelf->id, 'shelfName' => $shelf->name]);
    }

    /** Resolve a slug to a public shelf's uuid: archive slug, unique public shelf slug, journal slug. */
    private function shelfIdForSlug(string $slug): ?string
    {
        $archive = ArchiveSource::where('slug', $slug)->first();
        if ($archive) {
            $shelfId = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $archive->shelf_id)
                ->where('visibility', 'public')
                ->value('id');
            if ($shelfId) {
                return $shelfId;
            }
        }

        $bySlug = DB::connection('pgsql_admin')->table('shelves')
            ->where('slug', $slug)
            ->where('visibility', 'public')
            ->limit(2)
            ->pluck('id');
        if ($bySlug->count() === 1) {
            return $bySlug->first();
        }

        return $this->citedShelfForJournalSlug($slug)?->id;
    }

    /** The "Cited by:" shelf minted for a journal's hypercite-console imports, if any. */
    private function citedShelfForJournalSlug(string $slug): ?object
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return null;
        }

        return DB::connection('pgsql_admin')->table('shelves')
            ->where('creator', AutoVersionResolver::CREATOR)
            ->where('name', HarvestShelf::CITED_NAME_PREFIX . Str::limit((string) $journal->display_name, 230, '…'))
            ->where('visibility', 'public')
            ->first();
    }

    /**
     * GET /api/maintainer/shelf-import/shelves — the index payload: every
     * public shelf with its size and how much of it is canonical-linked
     * (assessable). System collection shelves float to the top — they are what
     * this console exists for — then by size.
     */
    public function shelves(Request $request)
    {
        $db = DB::connection('pgsql_admin');
        $systemPrefixes = [HarvestShelf::CITED_NAME_PREFIX, HarvestShelf::JOURNAL_NAME_PREFIX, HarvestShelf::NAME_PREFIX, HarvestShelf::CASE_NAME_PREFIX];

        $rows = $db->table('shelves as s')
            ->leftJoin('shelf_items as si', 'si.shelf_id', '=', 's.id')
            ->leftJoin('library as l', 'l.book', '=', 'si.book')
            ->where('s.visibility', 'public')
            ->groupBy('s.id', 's.name', 's.slug', 's.creator')
            ->select([
                's.id', 's.name', 's.slug', 's.creator',
                $db->raw('COUNT(si.book) as item_count'),
                $db->raw('COUNT(l.canonical_source_id) as linked_count'),
            ])
            ->get()
            ->map(fn ($s) => [
                'id'           => $s->id,
                'name'         => $s->name,
                'slug'         => $s->slug,
                'creator'      => $s->creator,
                'item_count'   => (int) $s->item_count,
                'linked_count' => (int) $s->linked_count,
                'is_system'    => (bool) collect($systemPrefixes)->first(fn ($p) => str_starts_with((string) $s->name, $p)),
            ])
            ->sortBy([['is_system', 'desc'], ['item_count', 'desc']])
            ->values();

        return response()->json(['shelves' => $rows]);
    }

    /**
     * GET /api/maintainer/shelf-import/{id}/articles — the shelf's works with
     * every imported LANE nested, same payload shape as journal-import's
     * `articles` (main.ts renders both). The work-list is the DISTINCT
     * canonicals behind the shelf's books; the lane query then joins on
     * canonical_source_id so siblings that are NOT on the shelf still appear —
     * comparing lanes is the workflow. Canonical-less shelf items (the normal
     * case for book:import-cases vacuum shelves) are appended as synthetic
     * standalone articles — one per book, nothing to fetch, no promote — so
     * the batch is still reviewable here lane by lane.
     */
    public function articles(Request $request, string $id, ReconvertQueue $queue)
    {
        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            return response()->json(['message' => 'Shelf not found (or not public).'], 404);
        }

        $db = DB::connection('pgsql_admin');

        $itemCount = $db->table('shelf_items')->where('shelf_id', $shelf->id)->count();
        $canonicalIds = $this->shelfCanonicalIds($shelf->id);
        $unlinked = $itemCount - $db->table('shelf_items as si')
            ->join('library as l', 'l.book', '=', 'si.book')
            ->where('si.shelf_id', $shelf->id)
            ->whereNotNull('l.canonical_source_id')
            ->count();

        $rows = $db->table('canonical_source as cs')
            ->leftJoin('library as l', 'l.canonical_source_id', '=', 'cs.id')
            ->whereIn('cs.id', $canonicalIds)
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST')
            ->orderBy('cs.id')
            ->select([
                'cs.id as canonical_id', 'cs.title', 'cs.author', 'cs.year', 'cs.volume', 'cs.issue',
                'cs.doi', 'cs.cited_by_count', 'cs.is_oa', 'cs.oa_url', 'cs.pdf_url',
                'cs.auto_version_book',
                'l.book', 'l.has_nodes', 'l.listed', 'l.visibility', 'l.conversion_method',
                'l.foundation_source', 'l.completeness', 'l.completeness_reason',
                'l.pdf_url_status', 'l.created_at as lane_created_at',
            ])
            ->get();

        // Canonical-less shelf books (case bundles, hand imports): synthesize one
        // standalone "article" per book so a book:import-cases vacuum shelf is
        // reviewable here. canonical_id 'book:<id>' is deliberately NOT a uuid —
        // run()'s import validation refuses it, exactly right for a book with
        // nothing to re-fetch (fetchable computes false from the null doi/urls).
        // auto_version_book = the book itself: no false "needs approval" flag,
        // and ★ promote (canonical-only) stays disabled via is_version.
        $standalone = $db->table('shelf_items as si')
            ->join('library as l', 'l.book', '=', 'si.book')
            ->where('si.shelf_id', $shelf->id)
            ->whereNull('l.canonical_source_id')
            ->where('l.visibility', '!=', 'deleted')
            ->orderBy('si.added_at')
            ->get([
                'l.book', 'l.title', 'l.author', 'l.year', 'l.volume', 'l.issue',
                'l.has_nodes', 'l.listed', 'l.visibility', 'l.conversion_method',
                'l.foundation_source', 'l.completeness', 'l.completeness_reason',
                'l.pdf_url_status', 'l.created_at as lane_created_at',
            ])
            ->map(fn ($l) => (object) [
                'canonical_id'        => 'book:' . $l->book,
                'title'               => $l->title ?: $l->book,
                'author'              => $l->author,
                'year'                => $l->year,
                'volume'              => $l->volume,
                'issue'               => $l->issue,
                'doi'                 => null,
                'cited_by_count'      => null,
                'is_oa'               => false,
                'oa_url'              => null,
                'pdf_url'             => null,
                'auto_version_book'   => $l->book,
                'book'                => $l->book,
                'has_nodes'           => $l->has_nodes,
                'listed'              => $l->listed,
                'visibility'          => $l->visibility,
                'conversion_method'   => $l->conversion_method,
                'foundation_source'   => $l->foundation_source,
                'completeness'        => $l->completeness,
                'completeness_reason' => $l->completeness_reason,
                'pdf_url_status'      => $l->pdf_url_status,
                'lane_created_at'     => $l->lane_created_at,
            ]);

        $articles = $this->foldArticles($rows->concat($standalone), $this->openFlagCountsByBook(), $queue);

        return response()->json([
            'shelf' => [
                'id'             => $shelf->id,
                'name'           => $shelf->name,
                'slug'           => $shelf->slug,
                'creator'        => $shelf->creator,
                'item_count'     => $itemCount,
                'unlinked_count' => max(0, $unlinked),
                'public_page'    => "/u/{$shelf->creator}/shelf/{$shelf->slug}",
            ],
            'articles' => $articles,
        ]);
    }

    /** The distinct canonicals behind a shelf's books. */
    private function shelfCanonicalIds(string $shelfId): \Illuminate\Support\Collection
    {
        return DB::connection('pgsql_admin')->table('shelf_items as si')
            ->join('library as l', 'l.book', '=', 'si.book')
            ->where('si.shelf_id', $shelfId)
            ->whereNotNull('l.canonical_source_id')
            ->distinct()
            ->pluck('l.canonical_source_id');
    }

    /**
     * POST /api/maintainer/shelf-import/{id}/run — fire one ARTICLE action and
     * return its run id. Same validation, collision guard and job as
     * journal-import's run(); the run row carries shelf_id instead of
     * journal_source_id (the job is null-journal-safe for all three actions).
     * Journal-registry actions are refused: a shelf has no OpenAlex source to
     * enumerate and no eligibility queue to walk.
     */
    public function run(Request $request, string $id)
    {
        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            return response()->json(['message' => 'Shelf not found (or not public).'], 404);
        }

        $action = (string) $request->input('action', 'import');
        if (in_array($action, ['enumerate', 'import_all'], true)) {
            return response()->json([
                'message' => "\"{$action}\" is a journal-registry action — not available for a shelf.",
            ], 422);
        }
        if (! in_array($action, self::ACTIONS, true)) {
            return response()->json(['message' => "Unknown action \"{$action}\"."], 422);
        }

        $lanes = (string) $request->input('lanes', 'both');
        if (! in_array($lanes, ['pdf', 'html', 'both'], true)) {
            return response()->json(['message' => 'lanes must be pdf, html or both.'], 422);
        }

        $db = DB::connection('pgsql_admin');
        $canonicalId = $request->input('canonical_id');
        $book = $request->input('book');

        // Validate the target up front so the operator gets a real error instead of a run row
        // that fails a second later on the worker.
        if ($action === 'import') {
            $onShelf = $canonicalId
                && Str::isUuid((string) $canonicalId)
                && $this->shelfCanonicalIds($shelf->id)->contains($canonicalId);
            if (! $onShelf) {
                return response()->json(['message' => 'canonical_id must be a work of this shelf.'], 422);
            }
        } else {
            $lane = $book ? $db->table('library')->where('book', $book)->first() : null;
            if (! $lane) {
                return response()->json(['message' => 'Lane not found.'], 404);
            }
            if ($lane->foundation_source !== HtmlLaneCreator::FOUNDATION_SOURCE) {
                return response()->json([
                    'message' => 'Reconvert/re-fetch here is the HTML lane\'s path; a PDF lane reconverts from its own source.',
                ], 422);
            }
            $canonicalId = $lane->canonical_source_id;
        }

        // Per-target collision guard — the actions replace a book's nodes, so two at once would
        // interleave writes. No scope-wide clause: a shelf has no shelf-wide actions.
        $inFlight = $db->table('journal_import_runs')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->where(fn ($q) => $q->where('canonical_source_id', $canonicalId)->orWhere('book', $book))
            ->first();
        if ($inFlight) {
            return response()->json([
                'run_id'          => $inFlight->id,
                'already_running' => true,
                'action'          => $inFlight->action,
            ]);
        }

        $runId = (string) Str::uuid();
        $db->table('journal_import_runs')->insert([
            'id'                  => $runId,
            'journal_source_id'   => null,
            'shelf_id'            => $shelf->id,
            'canonical_source_id' => $canonicalId,
            'user_id'             => $request->user()?->id,
            'action'              => $action,
            'lanes'               => $lanes,
            'status'              => 'pending',
            'book'                => $book,
            'counts'              => '{}',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);

        JournalImportActionJob::dispatch($runId);

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }

    /**
     * GET /api/maintainer/shelf-import/{id}/archive — this shelf's archive
     * page record (archive_sources), or archive:null when it has none yet.
     */
    public function archive(Request $request, string $id)
    {
        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            return response()->json(['message' => 'Shelf not found (or not public).'], 404);
        }

        $archive = ArchiveSource::where('shelf_id', $shelf->id)->first();

        return response()->json(['archive' => $archive ? $this->archivePayload($archive) : null]);
    }

    /**
     * POST /api/maintainer/shelf-import/{id}/archive — create or update the
     * archive page record: slug + display name + hand-written about copy +
     * the certified ★ (the homepage-listing human signal). Synchronous
     * one-row write, following the journal certify precedent. The shelf must
     * be public — same gate as the console itself, and the /a page's feed
     * only exists for a public shelf anyway.
     */
    public function saveArchive(Request $request, string $id)
    {
        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            return response()->json(['message' => 'Shelf not found (or not public).'], 404);
        }

        $validated = $request->validate([
            'slug'         => 'required|string|max:100|regex:/^[a-z0-9-]+$/',
            'display_name' => 'required|string|max:255',
            'about'        => 'nullable|string|max:20000',
            'certified'    => 'boolean',
        ]);

        $slugTaken = ArchiveSource::where('slug', $validated['slug'])
            ->where('shelf_id', '!=', $shelf->id)
            ->exists();
        if ($slugTaken) {
            return response()->json(['message' => "Slug \"{$validated['slug']}\" already names another archive."], 422);
        }

        $archive = ArchiveSource::firstOrNew(['shelf_id' => $shelf->id]);
        $archive->slug = $validated['slug'];
        $archive->display_name = $validated['display_name'];
        // About copy may carry real HTML (links to the scraped source) — it
        // renders UNESCAPED on /a/{slug}, so the write path sanitizes (house
        // pattern: NodeHtmlSanitizer on every user-text field).
        $about = ($validated['about'] ?? '') !== '' ? $validated['about'] : null;
        $archive->about = \App\Services\Security\NodeHtmlSanitizer::clean($about);
        $archive->certified_at = $request->boolean('certified')
            ? ($archive->certified_at ?? now())
            : null;
        $archive->save();

        return response()->json(['archive' => $this->archivePayload($archive)]);
    }

    /** @return array<string, mixed> */
    private function archivePayload(ArchiveSource $archive): array
    {
        return [
            'slug'         => $archive->slug,
            'display_name' => $archive->display_name,
            'about'        => $archive->about,
            'certified'    => $archive->certified_at !== null,
            'public_page'  => '/a/' . $archive->slug,
        ];
    }
}
