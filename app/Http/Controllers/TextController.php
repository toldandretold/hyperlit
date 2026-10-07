<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Http\Controllers\ConversionController;
use App\Helpers\BookSlugHelper;
use App\Services\BookCache;
use League\CommonMark\CommonMarkConverter;

class TextController extends Controller
{
    public function show(Request $request, $book, $hl = null, $fn = null)
    {
        // Sub-book interception removed — level-1 sub-book URLs (e.g. /book/Fn123)
        // now load the parent book and JS auto-opens the item in HyperlitContainer.
        // For standalone sub-book loading, use /based/{subBookId}.

        // If the path matches a username (allow basic slug variants),
        // (re)generate a user-home pseudo-book in DB and point $book to that.
        // findByNamePublic goes through the SECURITY DEFINER lookup: it
        // bypasses RLS (the default connection can only SELECT your OWN user
        // row, so these probes found nothing for a visitor) and matches on the
        // URL key — case- and space-insensitively.
        //
        // The second probe survives because the key STRIPS spaces rather than
        // mapping separators to them: `Mr Johns` is now found by `MrJohns`,
        // but `Mr_Johns` still needs the underscores turned back into spaces.
        //
        // $username is then the CANONICAL stored name — it keys library.creator
        // and nodes.book below, which RLS compares case-sensitively.
        $possible = urldecode($book);
        $normalized = str_replace(['_', '-'], ' ', $possible);
        $user = \App\Models\User::findByNamePublic($possible)
            ?? \App\Models\User::findByNamePublic($normalized);
        $username = $user?->name;

        if ($username !== null) {
            $bookCount = DB::table('library')->where('creator', $username)->where('book', '!=', $username)->count();
            $nodeCount = DB::table('nodes')->where('book', $username)->where('startLine', '>', 0)->count();

            // Generate the user-home book if it doesn't exist OR if the counts are out of sync.
            if ($nodeCount === 0 || $bookCount !== $nodeCount) {
                $isCurrentUserOwner = \Illuminate\Support\Facades\Auth::check() && \Illuminate\Support\Facades\Auth::user()->name === $username;
                Log::info('Regenerating user page due to count mismatch or non-existence.', ['username' => $username, 'book_count' => $bookCount, 'node_count' => $nodeCount, 'is_owner' => $isCurrentUserOwner]);
                $generator = new \App\Http\Controllers\UserHomeServerController();
                // RLS allows user home page writes via type='user_home' exception
                $generator->generateUserHomeBook($username, $isCurrentUserOwner, 'public');
            }

            $book = $username;
        }

        // Resolve slug → real book ID (preserves original value if not a slug)
        $urlSlug = $book; // keep the original URL segment for slug detection
        $book = BookSlugHelper::resolve($book);
        // Determine the slug to pass to the view
        $slug = BookSlugHelper::getSlug($book) ?? '';

        $editMode = $request->boolean('edit') || $request->routeIs('book.edit');

        // Fetch library metadata for SEO
        $seoData = $this->buildSeoData($book);

        // User pseudo-books canonicalize to the /u/ profile URL, not the bare
        // /{username} path (which 301s to /u/ anyway).
        if ($username !== null) {
            $userCanonical = \App\Support\UsernameKey::profileUrl($username);
            $seoData['canonicalUrl'] = $userCanonical;
            $seoData['ogUrl'] = $userCanonical;
        }

        // Legacy URL forms (raw /book_<id>, pre-slug human-readable ids) 301 to
        // the slug — the canonical tag alone left Google holding two live URLs
        // per work (GSC "Alternative page with proper canonical tag", 2026-10).
        // Every clause is load-bearing:
        //  - $username === null: user pseudo-books keep their /u/ canonicalization;
        //  - $slug !== '': a slugless book's raw id IS its canonical URL;
        //  - $urlSlug !== $slug: never fire on the canonical URL itself (no loop:
        //    resolve($slug) matches the slug column and getSlug returns that same
        //    stored value);
        //  - !empty($seoData): the PRIVACY gate. getSlug() reads pgsql_admin, but
        //    buildSeoData is RLS-subject — empty means this viewer may not see the
        //    row, and an anonymous 301 to a title-derived slug would leak it.
        //    (Accepted edge: a PUBLIC book with neither title nor author also
        //    yields [] and keeps the old canonical-tag behaviour.)
        // The SPA's reader-HTML fetch follows this transparently with ?target=
        // intact, and fetchHtml returns finalUrl so pushState lands on the slug.
        if ($username === null && $slug !== '' && $urlSlug !== $slug && !empty($seoData)) {
            $suffix = $request->routeIs('book.edit') ? '/edit'
                : ($hl !== null ? '/' . $hl : ($fn !== null ? '/' . $fn : ''));
            $qs = $request->getQueryString();

            return redirect('/' . $slug . $suffix . ($qs ? "?{$qs}" : ''), 301);
        }

        // Check all possible data sources
        $bookExistsInDB = DB::table('nodes')->where('book', $book)->exists();
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $htmlPath = resource_path("markdown/{$book}/main-text.html");
        $markdownExists = File::exists($markdownPath);
        $htmlExists = File::exists($htmlPath);

        // Determine data source priority and handle accordingly
        if ($bookExistsInDB) {
            // PostgreSQL has the data — the SPA loads it via JS, but we ALSO inject the
            // first chunk's HTML server-side (from the file cache, when fresh) so crawlers
            // index the real article body and users get an instant first paint. The client
            // discards this scaffolding (#__seo_prerender) the moment the lazy loader renders.
            // Resolve the prerender target: an SPA reader-HTML fetch passes the deep-link as
            // ?target= (the client read the URL #hash and forwarded it), else a path deep-link
            // reaches show() as $hl (HL_…) or $fn (…Fn…). buildFirstChunkPrerender maps it to its
            // chunk via the cached index → the FLASH-free correct chunk is prerendered.
            // No deep-link target → fall back to the user's saved reading position (resume),
            // mirroring the API's resume path so the prerendered chunk matches the client's fetch.
            $prerender = $this->buildFirstChunkPrerender($book, $request->query('target') ?? $hl ?? $fn, $request);
            if ($prerender && $prerender['text'] !== '' && isset($seoData['jsonLd'])) {
                $seoData['jsonLd']['articleBody'] = \Illuminate\Support\Str::limit($prerender['text'], 5000);
            }

            // A prerender MISS means `<main>` ships EMPTY — no article body for a
            // crawler, nothing for a browser's translator to detect a language
            // from, and no instant first paint. Measured 2026-10-02: 4 of 10
            // random public books with >40 nodes served zero characters inside
            // `<main>`, because nothing on the HTML path had ever warmed their
            // cache. The only warm trigger was a MISS on the NODES API
            // (DatabaseToIndexedDBController::warmAsync), i.e. after a JS reader
            // had already fetched chunks — so a book's first server render was
            // always empty, and stayed empty until a human opened it with JS.
            // Crawlers never get that far.
            //
            // Warming here closes the loop: this response is still empty, but
            // every later visit to that book is prerendered. It also repairs the
            // permanently-stale case (`ted2018the`'s cache sat 1053ms behind its
            // library row, which `isFresh` correctly refuses forever with nothing
            // to rebuild it). afterResponse so the warm never costs the reader
            // latency; the job is ShouldBeUnique + lock-guarded, so a crawl burst
            // collapses to one rebuild per book.
            if (! $prerender) {
                $this->warmBookCacheAsync($book);
            }

            // Discovery link for the deep-section pages (/{book}/text?page=N) —
            // the only route from the book page into the crawlable body. PUBLIC
            // non-encrypted books only (showTextPage 404s everything else), and
            // never user pseudo-books. The admin read is deliberate: "is this
            // book public" is viewer-independent, and the link must not flicker
            // with the viewer's RLS session.
            $fullTextPath = null;
            if ($username === null) {
                $pub = DB::connection('pgsql_admin')->table('library')
                    ->where('book', $book)->first(['visibility', 'encrypted']);
                if ($pub && $pub->visibility === 'public' && empty($pub->encrypted)) {
                    $fullTextPath = BookSlugHelper::canonicalPath($book, $slug ?: null) . '/text';
                }
            }

            $response = response()->view('reader', array_merge([
                'html' => '',
                'prerenderHtml' => $prerender['html'] ?? null,
                'prerenderChunkId' => $prerender['chunkId'] ?? null,
                'book' => $book,
                'slug' => $slug,
                'editMode' => $editMode,
                'dataSource' => 'database',
                'pageType' => 'reader',
                'fullTextPath' => $fullTextPath,
            ], $seoData));

            // A bookmark-derived prerender is PER-USER for the same /{book} URL — never let a
            // shared/CDN cache (e.g. Cloudflare) serve one user's reading position to another.
            if ($prerender['private'] ?? false) {
                $response->header('Cache-Control', 'private, no-store');
            }

            return $response;
        }

        if ($markdownExists || $htmlExists) {
            // File system has the data - process files as before
            $convertToHtml = false;
            if ($markdownExists) {
                if (!$htmlExists) {
                    $convertToHtml = true;
                } else {
                    $markdownModified = File::lastModified($markdownPath);
                    $htmlModified = File::lastModified($htmlPath);
                    if ($markdownModified > $htmlModified) {
                        $convertToHtml = true;
                    }
                }
            }

            if ($convertToHtml) {
                $markdown = File::get($markdownPath);
                $markdown = $this->normalizeMarkdown($markdown);
                $conversionController = new ConversionController($book);
                File::put($markdownPath, $markdown);
                $html = $conversionController->markdownToHtml();
            } else {
                $html = File::get($htmlPath);
            }

            return view('reader', array_merge([
                'html' => $html,
                'book' => $book,
                'slug' => $slug,
                'editMode' => $editMode,
                'dataSource' => 'filesystem',
                'pageType' => 'reader'
            ], $seoData));
        }

        // Neither PostgreSQL nor filesystem has it - assume it might be in IndexedDB
        // Always serve the reader view and let frontend JS check IndexedDB
        return view('reader', array_merge([
            'html' => '',
            'book' => $book,
            // getSlug() reads pgsql_admin, so for a PRIVATE book this shell
            // would stamp a title-derived slug into data-slug for a viewer RLS
            // refuses — only emit it when the RLS-subject buildSeoData saw the
            // row. (Local-only/unknown books have no slug; nothing changes.)
            'slug' => !empty($seoData) ? $slug : '',
            'editMode' => $editMode,
            'dataSource' => 'indexeddb', // Frontend will check IndexedDB
            'pageType' => 'reader',
            // The server can't see this book: a typo, a deleted book, a private
            // book under RLS, or a local-only (unsynced IndexedDB) creation. The
            // 200 is deliberate — the local-first create flow needs the shell to
            // render — but every such shell is byte-identical (<title>Hyperlit</title>,
            // empty <main>), and Google was indexing the pile and electing its own
            // canonical among them (GSC "Duplicate, Google chose different
            // canonical than user", 2026-10). noindex kills the whole class;
            // crawlers are always anonymous, so a real book never lands here.
            'noindex' => true,
        ], $seoData));
    }


    /**
     * Time machine: read-only historical view of a book at a specific timestamp.
     * URL: /{book}/timemachine?at={timestamp}
     */
    public function showTimeMachine(Request $request, $book)
    {
        $book = BookSlugHelper::resolve($book);
        $timestamp = $request->query('at');

        if (!$timestamp) {
            return redirect("/{$book}");
        }

        return view('reader', [
            'html'                 => '',
            'book'                 => $book . '/timemachine',
            'realBook'             => $book,
            'editMode'             => false,
            'dataSource'           => 'database',
            'pageType'             => 'timemachine',
            'timeMachineTimestamp'  => $timestamp,
            // A historical view OF a book, not a work. Indexing it competes
            // with the book's own page on near-identical text.
            'noindex'              => true,
        ]);
    }

    /**
     * Standalone mode: load a sub-book as a full-screen book.
     * URL: /based/{subBookId}
     */
    public function showStandalone(Request $request, $subBookId)
    {
        if (!DB::table('nodes')->where('book', $subBookId)->exists()) {
            abort(404, 'Sub-book not found.');
        }

        // These URLs are IN the sitemap but used to ship <title>Hyperlit</title>
        // and a self-canonical, because this method never called buildSeoData()
        // — a sub-book is real content (a footnote apparatus, a pasted source),
        // so it gets the same treatment as any book rather than a noindex.
        $seoData = $this->buildSeoData($subBookId);

        // canonicalUrl/ogUrl MUST be overridden: buildSeoData builds url('/' .
        // $id), and a sub-book id contains a slash, so that yields the NESTED
        // route (/book_x/Fn1 — the parent with a container auto-opened), not
        // this standalone page. /based/… is the form the sitemap offers, so it
        // is the one canonical URL for the standalone view.
        $canonical = url('/based/' . $subBookId);
        $seoData['canonicalUrl'] = $canonical;
        $seoData['ogUrl'] = $canonical;
        if (!empty($seoData['jsonLd']) && is_array($seoData['jsonLd'])) {
            $seoData['jsonLd']['url'] = $canonical;
        }

        return view('reader', array_merge([
            'html'       => '',
            'book'       => $subBookId,
            'editMode'   => $request->boolean('edit'),
            'dataSource' => 'database',
            'pageType'   => 'reader',
        ], $seoData));
    }

    /**
     * Deep-section pages: /{book}/text?page=N — the crawlable form of chunks
     * 2..N, which otherwise have NO URL (only the first chunk of a book was
     * ever server-rendered, so long-tail exact-phrase search over the body was
     * structurally unavailable; Capital Vol I exposed 622 chars of a ~2M-char
     * book). One page = one manifest chunk (ordinal, 1-based), served as the
     * NORMAL reader view with that chunk prerendered — a human landing from a
     * search result gets the actual reader seated at the passage; a crawler
     * gets the same HTML plus hidden prev/next <a> links to walk the book.
     * Same HTML for both, so no cloaking. Discovery: a hidden link on the book
     * page (NOT the sitemap — these earn their indexing via links).
     *
     * An early inline script replaceStates the address bar to the canonical
     * book path before any module JS reads location.pathname, so the SPA,
     * history stack and deep-link machinery all see a plain book URL.
     */
    public function showTextPage(Request $request, string $book)
    {
        $urlSlug = $book;
        $book = BookSlugHelper::resolve($book);
        $slug = BookSlugHelper::getSlug($book) ?? '';

        // Crawler-facing and viewer-independent, so the gate runs on pgsql_admin
        // (an RLS-shaped read here would let one viewer's view leak into shared
        // caches — same reasoning as PublicBookCorpus::queryAsAdmin). 404 for
        // private and unknown ALIKE: existence must not be revealed. Encrypted
        // books hold ciphertext; user pseudo-books (public library rows keyed by
        // a username) would otherwise serve /{username}/text.
        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->first(['visibility', 'encrypted', 'raw_json', 'title', 'author']);
        $pseudoType = $row ? (json_decode($row->raw_json ?? '{}', true)['type'] ?? '') : '';
        if (! $row
            || $row->visibility !== 'public'
            || ! empty($row->encrypted)
            || in_array($pseudoType, ['user_home', 'user_home_sorted', 'user_account', 'user_about'], true)
        ) {
            abort(404);
        }

        // Legacy raw-id form → the slug, like the book page itself.
        if ($slug !== '' && $urlSlug !== $slug) {
            $qs = $request->getQueryString();

            return redirect('/' . $slug . '/text' . ($qs ? "?{$qs}" : ''), 301);
        }

        // A cold or stale cache has nothing to serve and — unlike /{book},
        // where the empty shell still boots the reader — an empty text page is
        // pointless. Warm it and tell crawlers to retry; never loosen
        // BookCache::isFresh instead (stale prose is worse than a 503).
        $cache = app(BookCache::class);
        if (! $cache->isFresh($book, $cache->freshTimestamp($book))) {
            $this->warmBookCacheAsync($book);
            $bookUrl = BookSlugHelper::canonicalUrl($book, $slug ?: null);

            return response(
                '<p>This page is being prepared. <a href="' . e($bookUrl) . '">Read the book</a>.</p>',
                503,
                ['Retry-After' => '300']
            );
        }

        $manifest = $cache->getManifest($book);
        if (empty($manifest)) {
            abort(404);
        }

        $page = max(1, (int) $request->query('page', 1));
        $lastPage = count($manifest);
        if ($page > $lastPage) {
            abort(404);
        }

        $entry = $manifest[$page - 1];
        $prerender = $this->renderChunkPrerender($book, (float) $entry['chunk_id'], $cache);
        if ($prerender === null) {
            abort(404);
        }

        // The replaceState tidy URL. Page 1 is the book's own top — a bare book
        // path boots exactly like /{book}. A DEEPER page appends the chunk's
        // first node id as a #hash: resolveBootstrapTarget (priority 1) then
        // drives the WHOLE existing deep-link pathway — targeted initial fetch
        // (so the prerendered chunk's nodes are in it and render-in-place
        // adopts rather than orphaning), no eager chunk-0 load, scroll to the
        // node. A numeric hash is already a recognized content target (the
        // blade flash-guard regex; the cache index maps startLine → chunk).
        $firstLineId = rtrim(rtrim(number_format((float) ($entry['first_line'] ?? 0), 6, '.', ''), '0'), '.');
        $tidyPath = BookSlugHelper::canonicalPath($book, $slug ?: null)
            . ($page > 1 ? '#' . $firstLineId : '');

        $basePath = BookSlugHelper::canonicalPath($book, $slug ?: null) . '/text';
        // Page 1 canonicalizes to the bare /text, not ?page=1 (the /books rule).
        $pageUrl = fn (int $p) => url($basePath . ($p > 1 ? '?page=' . $p : ''));

        $seoData = $this->buildSeoData($book);
        // These pages are body text, not bibliographic records: the book page
        // owns the Scholar citation_* tags and the ScholarlyArticle JSON-LD —
        // repeating them here would register N duplicate records per work.
        unset($seoData['citationMeta'], $seoData['jsonLd']);

        $title = trim((string) $row->title) !== '' ? trim((string) $row->title) : 'Untitled';
        $pagePart = $page > 1 ? ", page {$page}" : '';
        $budget = self::TITLE_MAX - mb_strlen(self::TITLE_SUFFIX) - mb_strlen(" — full text{$pagePart}");
        if (mb_strlen($title) > $budget) {
            $title = rtrim(mb_substr($title, 0, max(1, $budget - 1)), " \t\n\r\0\x0B.,;:—-") . '…';
        }
        $seoData['pageTitle'] = "{$title} — full text{$pagePart}" . self::TITLE_SUFFIX;
        $byAuthor = trim((string) $row->author) !== '' ? ' by ' . trim((string) $row->author) : '';
        $seoData['pageDescription'] = 'Full text of ' . trim((string) $row->title) . $byAuthor
            . ", page {$page} of {$lastPage}. Read with citations and highlights on Hyperlit.";
        $seoData['canonicalUrl'] = $pageUrl($page);
        $seoData['ogUrl'] = $seoData['canonicalUrl'];

        return view('reader', array_merge([
            'html' => '',
            'prerenderHtml' => $prerender['html'],
            'prerenderChunkId' => $prerender['chunkId'],
            'book' => $book,
            'slug' => $slug,
            'editMode' => false,
            'dataSource' => 'database',
            'pageType' => 'reader',
            'textPagePrev' => $page > 1 ? $pageUrl($page - 1) : null,
            'textPageNext' => $page < $lastPage ? $pageUrl($page + 1) : null,
            'textPageCanonicalBookPath' => $tidyPath,
        ], $seoData));
    }

    /**
     * Nested mode: load parent book with an auto-open chain for sequential container opening.
     * URL: /{book}/{rest}  where rest = "2/Fn.../HL_..."
     */
    public function showNested(Request $request, $book, $rest)
    {
        // Resolve slug → real book ID
        $book = BookSlugHelper::resolve($book);
        $slug = BookSlugHelper::getSlug($book) ?? '';

        $parts = explode('/', $rest);
        $level = (int) $parts[0];
        $urlItems = array_slice($parts, 1);

        if (count($urlItems) < 1) {
            abort(404, 'Invalid nested URL.');
        }

        // Construct the final sub_book_id from URL components
        // Level 1 format: "book/itemId"  |  Level 2+ format: "book/level/parentItem/itemId"
        if ($level <= 1 && count($urlItems) === 1) {
            $finalSubBookId = $book . '/' . $urlItems[0];
        } else {
            $finalSubBookId = $book . '/' . $rest;
        }

        // Walk backwards from leaf to root to discover full chain, falling back to the
        // deepest ANCESTOR that still resolves when the requested one is gone.
        $resolved = $this->resolveDeepestSurvivingChain($book, $finalSubBookId);
        $chain = $resolved['chain'];

        if ($resolved['subBookId'] !== $finalSubBookId) {
            // Check if the root book is private (RLS blocked the chain queries).
            // If so, serve the reader view — the client-side fetchInitialChunk() will
            // get a 403 and show the "Private Book" login prompt, same as /book does.
            // This case is NOT a deletion, so it must not redirect: a would-be reader
            // needs the login prompt, not a bounce to a book they equally can't see.
            $bookInfo = DB::selectOne('SELECT * FROM check_book_visibility(?)', [$book]);
            if ($bookInfo && $bookInfo->visibility === 'private') {
                $privateSeo = $this->buildSeoData($book); // RLS-subject: [] for a viewer who can't see the row
                return view('reader', array_merge([
                    'html'       => '',
                    'book'       => $book,
                    // Only emit the (admin-fetched) slug when this viewer may see
                    // the library row — same leak guard as show()'s fallthrough.
                    'slug'       => !empty($privateSeo) ? $slug : '',
                    'editMode'   => false,
                    'dataSource' => 'database',
                    'pageType'   => 'reader',
                    // Same soft-404 shape as show()'s IndexedDB fallthrough, at a
                    // /{book}/{rest} URL: a crawler gets the generic empty shell
                    // here, so it must not be indexable either.
                    'noindex'    => true,
                ], $privateSeo));
            }

            // The requested sub-book no longer exists — deleting a highlight destroys its
            // sub-book, so any link or restored history entry pointing at it used to 404.
            // Redirect ONCE to the deepest surviving ancestor (or the plain book when none
            // survives), which both lands the reader somewhere real and clears the dead
            // segments out of the address bar. Each hop is strictly shorter than the last
            // and the terminal case is a bare book URL, so this cannot loop.
            return redirect()->to(
                $this->subBookUrl($slug ?: $book, $book, $resolved['subBookId'])
            );
        }

        $editMode = $request->boolean('edit') || $request->routeIs('book.edit');

        // SEO: fetch book metadata + hyperlight text for link previews
        $seoData = $this->buildSeoData($book);
        $hlDescription = $this->getHyperlightDescription($finalSubBookId, $urlItems);
        if ($hlDescription) {
            $seoData['ogDescription'] = $hlDescription;
            $seoData['pageDescription'] = $hlDescription;
        }

        return view('reader', array_merge([
            'html'           => '',
            'book'           => $book,
            'slug'           => $slug,
            'editMode'       => $editMode,
            'dataSource'     => 'database',
            'pageType'       => 'reader',
            'autoOpenChain'  => $chain,
        ], $seoData));
    }

    /**
     * API endpoint: resolve a sub-book chain server-side.
     * Reuses walkChainToRoot + findParentBook against PostgreSQL.
     */
    public function resolveChainApi(Request $request, string $book, string $rest): \Illuminate\Http\JsonResponse
    {
        // Resolve slug → real book ID
        $book = BookSlugHelper::resolve($book);

        $parts = explode('/', $rest);
        $level = (int) $parts[0];
        $urlItems = array_slice($parts, 1);

        if (count($urlItems) < 1) {
            return response()->json(['success' => false, 'message' => 'Invalid path'], 400);
        }

        if ($level <= 1 && count($urlItems) === 1) {
            $finalSubBookId = $book . '/' . $urlItems[0];
        } else {
            $finalSubBookId = $book . '/' . $rest;
        }

        // Degrade to the deepest surviving ancestor rather than 404 — the client's
        // buildChainFromUrl() calls this to recover a level-3+ chain, and a hard 404
        // there left it opening the dead leaf anyway. `truncated` lets the caller know
        // the chain it got back is shorter than the one it asked for.
        $resolved = $this->resolveDeepestSurvivingChain($book, $finalSubBookId);

        return response()->json([
            'success'           => true,
            'chain'             => $resolved['chain'],
            'truncated'         => $resolved['subBookId'] !== $finalSubBookId,
            'resolvedSubBookId' => $resolved['subBookId'],
        ]);
    }

    /**
     * Resolve the requested sub-book chain, or — when it or an ancestor has been deleted —
     * the deepest ancestor that still resolves.
     *
     * Stepping down cannot be done by string surgery: a sub-book id only ever encodes its
     * last two items ("book/item" or "book/N/parentItem/item"), so the grandparent is not
     * derivable from the id. The parent ITEM id is in there though, and an item's own
     * sub_book_id is a direct lookup — that is what walks us down one real level at a time.
     *
     * @return array{chain: array, subBookId: ?string} subBookId is null at the root book.
     */
    private function resolveDeepestSurvivingChain(string $rootBook, string $leafSubBookId): array
    {
        $currentSubBookId = $leafSubBookId;
        $maxHops = 20;

        for ($i = 0; $i < $maxHops; $i++) {
            $chain = $this->walkChainToRoot($rootBook, $currentSubBookId);
            if ($chain !== null) {
                return ['chain' => $chain, 'subBookId' => $currentSubBookId];
            }

            $parentItemId = \App\Helpers\SubBookIdHelper::parse($currentSubBookId)['parentItemId'];
            if (!$parentItemId) {
                break; // level 1 — the only thing below it is the root book
            }

            $parentSubBookId = $this->findSubBookIdForItem($rootBook, $parentItemId);
            if ($parentSubBookId === null || $parentSubBookId === $currentSubBookId) {
                break;
            }

            $currentSubBookId = $parentSubBookId;
        }

        return ['chain' => [], 'subBookId' => null];
    }

    /**
     * The sub_book_id owned by a given item id, scoped to one foundation book.
     * split_part rather than a LIKE prefix: book ids contain underscores, which LIKE
     * would treat as single-character wildcards.
     */
    private function findSubBookIdForItem(string $rootBook, string $itemId): ?string
    {
        $subBookId = DB::table('hyperlights')
            ->where('hyperlight_id', $itemId)
            ->whereRaw("split_part(sub_book_id, '/', 1) = ?", [$rootBook])
            ->value('sub_book_id');

        if ($subBookId !== null) return $subBookId;

        return DB::table('footnotes')
            ->where('footnoteId', $itemId)
            ->whereRaw("split_part(sub_book_id, '/', 1) = ?", [$rootBook])
            ->value('sub_book_id');
    }

    /**
     * Reader URL for a sub-book id, or the plain book URL when $subBookId is null.
     * A sub-book id is "<foundation>/<rest>" and the reader route is "/<slug>/<rest>",
     * so the foundation prefix is simply swapped for the slug.
     */
    private function subBookUrl(string $slugOrBook, string $rootBook, ?string $subBookId): string
    {
        if ($subBookId === null || !str_starts_with($subBookId, $rootBook . '/')) {
            return '/' . $slugOrBook;
        }

        return '/' . $slugOrBook . '/' . substr($subBookId, strlen($rootBook) + 1);
    }

    private function walkChainToRoot(string $rootBook, string $leafSubBookId): ?array
    {
        $chain = [];
        $currentSubBookId = $leafSubBookId;
        $maxIterations = 20;

        for ($i = 0; $i < $maxIterations; $i++) {
            $parsed = \App\Helpers\SubBookIdHelper::parse($currentSubBookId);
            if (!$parsed['itemId']) return null;

            array_unshift($chain, [
                'itemId'    => $parsed['itemId'],
                'subBookId' => $currentSubBookId,
            ]);

            $parentBook = $this->findParentBook($currentSubBookId);
            if ($parentBook === null) return null;

            // Root reached when parentBook has no slashes
            if (!str_contains($parentBook, '/')) {
                return ($parentBook === $rootBook) ? $chain : null;
            }

            $currentSubBookId = $parentBook;
        }

        return null; // Safety limit hit
    }

    private function findParentBook(string $subBookId): ?string
    {
        $book = DB::table('footnotes')
            ->where('sub_book_id', $subBookId)
            ->value('book');

        if ($book !== null) return $book;

        return DB::table('hyperlights')
            ->where('sub_book_id', $subBookId)
            ->value('book');
    }

    /**
     * The brand suffix every public page title ends with. Em dash, matching
     * journal-index / archive-index / the homepage — book and user titles used
     * a hyphen, so one SERP showed the site branding itself two ways.
     */
    private const TITLE_SUFFIX = ' — Hyperlit';

    /** Google displays ~60 chars of <title>; past that it truncates mid-word. */
    private const TITLE_MAX = 60;

    /**
     * "{title} by {author}{suffix}", trimmed to fit, with the author dropped
     * when it IS the brand (see the call site for why) or when keeping it
     * would cost the title itself.
     */
    private function composePageTitle(string $title, ?string $author): string
    {
        $title = trim($title);
        $author = trim((string) $author);

        // A book credited to the site reads "… by Hyperlit — Hyperlit"
        if ($author !== '' && strcasecmp($author, 'hyperlit') === 0) {
            $author = '';
        }

        $budget = self::TITLE_MAX - mb_strlen(self::TITLE_SUFFIX);

        // The title is the part that must survive; the author is the first
        // thing dropped, and only then is the title itself shortened.
        if ($author !== '') {
            $withAuthor = "{$title} by {$author}";
            if (mb_strlen($withAuthor) <= $budget) {
                return $withAuthor . self::TITLE_SUFFIX;
            }
        }

        if (mb_strlen($title) > $budget) {
            // rtrim the cut so the ellipsis never follows a space or comma
            $title = rtrim(mb_substr($title, 0, $budget - 1), " \t\n\r\0\x0B.,;:—-") . '…';
        }

        return $title . self::TITLE_SUFFIX;
    }

    private function buildSeoData(string $bookId): array
    {
        $library = DB::table('library')
            ->select([
                'title', 'author', 'abstract', 'year', 'publisher', 'journal',
                'volume', 'issue', 'pages', 'doi', 'language', 'language_detected', 'editor',
                'booktitle', 'school', 'type', 'cited_by_count', 'slug',
                // openalex_id: for the JSON-LD sameAs (see externalIdentityUrls)
                'openalex_id',
            ])
            ->where('book', $bookId)
            ->first();

        if (!$library || (!$library->title && !$library->author)) {
            return [];
        }

        $title = $library->title ?? 'Untitled';
        $author = $library->author;
        $isArticle = !empty($library->journal);

        // Every URL variant of a book (slug, raw id, HL/Fn deep links, /edit)
        // must canonicalize to ONE URL, or ranking signals fragment across them.
        $canonicalUrl = BookSlugHelper::canonicalUrl($bookId, $library->slug);

        // Page title. Three rules, all learned from live SERP output:
        //
        //  - the brand suffix is an EM DASH, matching the journal, archive and
        //    homepage titles; book and user pages used a hyphen, so the site
        //    presented itself two ways in one result page;
        //  - an author equal to the brand is DROPPED — /welcome and /stats are
        //    authored by "Hyperlit"/"hyperlit" and read as "Welcome to the
        //    hyperlit docuverse by Hyperlit — Hyperlit";
        //  - the whole thing is capped, because Google displays ~60 characters
        //    and long academic titles pushed both the author and the brand out
        //    of view entirely.
        $pageTitle = $this->composePageTitle($title, $author);

        // Description — rich citation string
        $pageDescription = '';
        if ($library->abstract) {
            $pageDescription = \Illuminate\Support\Str::limit(strip_tags($library->abstract), 160);
        } else {
            $parts = [];
            if ($author) $parts[] = $author;
            if ($title) $parts[] = $isArticle ? "\"{$title}\"" : $title;
            if ($library->journal) $parts[] = $library->journal;
            if ($library->volume) {
                $vol = "vol. {$library->volume}";
                if ($library->issue) $vol .= ", no. {$library->issue}";
                $parts[] = $vol;
            }
            if ($library->publisher && !$isArticle) $parts[] = $library->publisher;
            if ($library->year) $parts[] = $library->year;
            $pageDescription = implode('. ', $parts) . '. Read on Hyperlit.';
        }

        $seo = [
            'pageTitle' => $pageTitle,
            'pageDescription' => $pageDescription,
            'ogType' => $isArticle ? 'article' : 'book',
            'canonicalUrl' => $canonicalUrl,
            'ogUrl' => $canonicalUrl,
        ];

        // Open Graph card: a single static branded card for every book (see the
        // blade default, public/images/og-card.png). We previously rendered a
        // per-book citation card via the /og/{book}.png route + OgImageRenderer
        // (Imagick) — that machinery is kept but dormant; leaving $ogImage unset
        // here makes the layout fall back to the static card.

        // Google Scholar citation_* meta tags
        $citationMeta = [];
        $citationMeta['citation_title'] = $title;
        if ($author) $citationMeta['citation_author'] = $author;
        if ($library->year) $citationMeta['citation_publication_date'] = $library->year;
        if ($library->journal) $citationMeta['citation_journal_title'] = $library->journal;
        if ($library->publisher) $citationMeta['citation_publisher'] = $library->publisher;
        if ($library->volume) $citationMeta['citation_volume'] = $library->volume;
        if ($library->issue) $citationMeta['citation_issue'] = $library->issue;
        if ($library->doi) $citationMeta['citation_doi'] = $library->doi;
        // Normalised like `htmlLang`: a junk value that is correctly REJECTED for
        // <html lang> must not sail through to Google Scholar instead. Stays
        // DECLARED-only — this is a bibliographic claim about the work, so it
        // must keep ignoring `library.language_detected` (that guess feeds
        // <html lang> only, below).
        if ($lang = self::normalizeLang($library->language)) $citationMeta['citation_language'] = $lang;
        if ($library->pages) {
            $citationMeta['citation_pages'] = $library->pages;
            // Try to extract first/last page
            if (preg_match('/^(\d+)\s*[-–]\s*(\d+)$/', $library->pages, $m)) {
                $citationMeta['citation_firstpage'] = $m[1];
                $citationMeta['citation_lastpage'] = $m[2];
            }
        }
        if ($library->booktitle) $citationMeta['citation_inbook_title'] = $library->booktitle;
        $seo['citationMeta'] = $citationMeta;

        // Keywords from metadata
        $keywords = [];
        if ($author) $keywords[] = $author;
        if ($library->journal) $keywords[] = $library->journal;
        if ($library->publisher && !$isArticle) $keywords[] = $library->publisher;
        if ($library->year) $keywords[] = $library->year;
        // Extract meaningful words from title (skip short/common words)
        if ($title) {
            $stopWords = ['the','a','an','and','or','of','in','on','at','to','for','is','it','by','with','from','as','this','that'];
            $titleWords = preg_split('/[\s,.:;!?\-]+/', strtolower($title));
            foreach ($titleWords as $w) {
                if (strlen($w) > 3 && !in_array($w, $stopWords)) {
                    $keywords[] = $w;
                }
            }
        }
        if ($library->booktitle) $keywords[] = $library->booktitle;
        if ($library->school) $keywords[] = $library->school;
        $seo['keywords'] = implode(', ', array_unique($keywords));

        // JSON-LD structured data
        $schemaType = $isArticle ? 'ScholarlyArticle' : 'Book';
        $jsonLd = [
            '@context' => 'https://schema.org',
            '@type' => $schemaType,
            'name' => $title,
            'url' => $canonicalUrl,
        ];
        if ($author) $jsonLd['author'] = ['@type' => 'Person', 'name' => $author];
        if ($library->publisher) {
            $jsonLd['publisher'] = ['@type' => 'Organization', 'name' => $library->publisher];
        }
        if ($library->year) $jsonLd['datePublished'] = $library->year;
        if ($library->abstract) $jsonLd['abstract'] = \Illuminate\Support\Str::limit(strip_tags($library->abstract), 500);
        // Normalised, and DECLARED-only, for the same reason as citation_language
        // — must keep ignoring `library.language_detected`.
        if ($lang = self::normalizeLang($library->language)) $jsonLd['inLanguage'] = $lang;
        if ($library->doi) $jsonLd['identifier'] = ['@type' => 'PropertyValue', 'propertyID' => 'DOI', 'value' => $library->doi];
        if ($library->pages) $jsonLd['pagination'] = $library->pages;
        if ($isArticle && $library->journal) {
            $jsonLd['isPartOf'] = [
                '@type' => 'Periodical',
                'name' => $library->journal,
            ];
            if ($library->volume) $jsonLd['volumeNumber'] = $library->volume;
            if ($library->issue) $jsonLd['issueNumber'] = $library->issue;
        }
        if ($library->editor) $jsonLd['editor'] = ['@type' => 'Person', 'name' => $library->editor];
        if ($library->cited_by_count) $jsonLd['citationCount'] = $library->cited_by_count;

        // Where this page sits in the site. Google renders it as the breadcrumb
        // trail in place of the raw URL, which matters most here: two thirds of
        // the corpus is still at an opaque /book_1790421435416, and a result
        // reading "Hyperlit › Books › Capital" is legible where that URL is not.
        $jsonLd['breadcrumb'] = $this->buildBreadcrumb($title, $canonicalUrl);

        // The same work's identity elsewhere (doi.org, OpenAlex). These links
        // DO exist on the page already — in the source container's citation
        // line — but that panel renders EMPTY until a user opens it, so a
        // crawler never sees them. sameAs states the same thing in the channel
        // machines actually read, without server-rendering a hidden panel.
        if ($sameAs = $this->externalIdentityUrls($library)) {
            $jsonLd['sameAs'] = $sameAs;
        }

        $seo['jsonLd'] = $jsonLd;

        // <html lang>. The layout hardcoded "en" while library.language held the
        // real ISO code — telling every crawler and screen reader that a German
        // or Spanish work is English. Declared wins; the detected value
        // (BookLanguageDetector, confidence-floored) fills the hole — `lang` is
        // a statement about THIS PAGE's text, so a high-confidence detection is
        // honest here even though the bibliographic fields above must never
        // carry it. Still absent when neither exists: a wrong lang is worse
        // than none.
        $lang = self::normalizeLang($library->language)
            ?? self::normalizeLang($library->language_detected ?? null);
        if ($lang) {
            $seo['htmlLang'] = $lang;
        }

        return $seo;
    }

    /**
     * Resolvable URLs for this work's identity in external authorities, for the
     * JSON-LD `sameAs`.
     *
     * The DOI is normalised rather than concatenated: `library.doi` is bare
     * `10.x` across the corpus today, but it is a free-text column fed by
     * several harvest paths, and `'https://doi.org/' . $doi` on an
     * already-resolved value yields `https://doi.org/https://doi.org/10…`.
     * Anything that is not DOI-shaped is dropped — a malformed sameAs asserts a
     * false identity, which is worse than asserting none.
     *
     * NOTE `citation_doi` deliberately keeps the BARE doi: Scholar's tag wants
     * the identifier, not a link.
     *
     * @return array<int, string>
     */
    private function externalIdentityUrls(object $library): array
    {
        $urls = [];

        $doi = preg_replace(
            '#^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)#i',
            '',
            trim((string) ($library->doi ?? ''))
        );
        if ($doi !== '' && preg_match('#^10\.\d{4,9}/\S+$#', $doi)) {
            $urls[] = 'https://doi.org/' . $doi;
        }

        // Stored as the bare OpenAlex work id ("W101716117").
        $openalex = trim((string) ($library->openalex_id ?? ''));
        if ($openalex !== '' && preg_match('#^[WwAaSsIiCcPpFf]\d+$#', $openalex)) {
            $urls[] = 'https://openalex.org/' . $openalex;
        }

        return $urls;
    }

    /**
     * Hyperlit › Books › {title}.
     *
     * Deliberately NOT journal-aware: a journal name in the trail would have to
     * link to /j/{slug}, and `library.journal` is a free-text string with no
     * guaranteed registry row — a breadcrumb pointing at a 404 is worse than a
     * shallower one.
     */
    private function buildBreadcrumb(string $title, string $canonicalUrl): array
    {
        return [
            '@type' => 'BreadcrumbList',
            'itemListElement' => [
                [
                    '@type' => 'ListItem',
                    'position' => 1,
                    'name' => 'Hyperlit',
                    'item' => url('/'),
                ],
                [
                    '@type' => 'ListItem',
                    'position' => 2,
                    'name' => 'Books',
                    'item' => url('/books'),
                ],
                [
                    '@type' => 'ListItem',
                    'position' => 3,
                    'name' => $title,
                    'item' => $canonicalUrl,
                ],
            ],
        ];
    }

    /**
     * A `library.language` value safe to emit as an HTML lang attribute, or
     * null. The column holds clean two-letter ISO codes today ("de", "en",
     * "es", "it", "nl"), but it is free text — anything that is not a plausible
     * BCP-47 tag is dropped rather than guessed at, because a malformed lang
     * attribute is worse than the "en" default.
     */
    private static function normalizeLang(?string $language): ?string
    {
        $lang = strtolower(trim((string) $language));

        return preg_match('/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/', $lang) ? $lang : null;
    }

    /**
     * Build the server-side first-chunk prerender — the REAL chunk DOM the client will adopt
     * (Phase 2). Determines which chunk the client will load first and returns that chunk's
     * concatenated node HTML + plain text:
     *   - a PATH target (`/{book}/{hl}` — a hyperlight/hypercite/footnote/startLine id) → its
     *     chunk, resolved via the cached `index.json` (the same map the API uses);
     *   - otherwise the LOWEST chunk (document start — what a crawler at /{book} indexes).
     *
     * Only runs on a FRESH cache: a pure file read, never a Postgres query, so the page render
     * stays cheap. On a cold cache it returns null (the <main> stays empty, today's behaviour)
     * and the first reader API call warms the cache so the NEXT load prerenders. The node
     * `content` is already sanitized on write (NodeHtmlSanitizer), safe to emit with {!! !!}.
     *
     * @return array{html: string, text: string, chunkId: float, private: bool}|null
     */
    /**
     * Schedule a background (re)warm of a book's file cache after a prerender
     * MISS, so the next render of this book can ship its article body.
     *
     * Mirrors `DatabaseToIndexedDBController::warmAsync` — same job, same
     * afterResponse dispatch, same fallback to an inline warm when the queue is
     * unavailable (e.g. the sync driver mid-request). Kept as its own small
     * method rather than reaching into that controller: both are thin wrappers
     * over one job, and coupling two controllers to share four lines would be
     * worse than the duplication. Always best-effort — a book that cannot be
     * warmed must still render.
     */
    private function warmBookCacheAsync(string $book): void
    {
        try {
            \App\Jobs\WarmBookCacheJob::dispatch($book)->afterResponse();
        } catch (\Throwable $e) {
            try {
                app(BookCache::class)->warm($book);
            } catch (\Throwable $inner) {
                Log::warning('Inline BookCache warm failed after prerender miss', [
                    'book' => $book,
                    'error' => $inner->getMessage(),
                ]);
            }
        }
    }

    private function buildFirstChunkPrerender(string $book, ?string $target = null, ?Request $request = null): ?array
    {
        try {
            $cache = app(BookCache::class);
            if (! $cache->isFresh($book, $cache->freshTimestamp($book))) {
                return null;
            }
            $manifest = $cache->getManifest($book);
            if (empty($manifest)) {
                return null;
            }
            // Precedence: deep-link target → saved reading position (resume) → document start (lowest).
            // Resolve a target via the cached index first, then a LIVE lookup — a cite/highlight created
            // after the last warm isn't in index.json yet, and resolving index-only would prerender the
            // WRONG (lowest) chunk → flash.
            $chunkId = (float) $manifest[0]['chunk_id']; // manifest is sorted ascending by warm()
            $private = false;
            if ($target !== null && $target !== '') {
                $resolved = $this->resolvePrerenderTargetChunk($book, $target, $cache);
                if ($resolved !== null) {
                    $chunkId = $resolved;
                }
            } elseif ($request !== null) {
                // No deep-link → resume to the user's saved position (the SAME row the client's
                // resume=true fetch reads), but ONLY if that chunk still exists in the manifest —
                // content edits can shift chunk ids, and an unmatched prerender would orphan in the DOM.
                $bookmark = \App\Services\ReadingPosition::lookup($request, $book);
                if ($bookmark !== null) {
                    $savedChunkId = (float) $bookmark['chunk_id'];
                    foreach ($manifest as $entry) {
                        if ((float) $entry['chunk_id'] === $savedChunkId) {
                            $chunkId = $savedChunkId;
                            $private = true; // per-user prerender → not shared-cacheable
                            break;
                        }
                    }
                }
            }
            $rendered = $this->renderChunkPrerender($book, $chunkId, $cache);
            if ($rendered === null) {
                return null;
            }

            return $rendered + ['private' => $private];
        } catch (\Throwable $e) {
            // SEO prerender is best-effort — never let it break the page render.
            Log::warning('First-chunk prerender failed (serving empty <main>)', [
                'book' => $book,
                'error' => $e->getMessage(),
            ]);
            return null;
        }
    }

    /**
     * Render ONE cached chunk as prerender HTML — the shared core between
     * buildFirstChunkPrerender (which picks the chunk from target/resume/lowest)
     * and showTextPage (which picks it from the ?page= ordinal).
     *
     * @return array{html: string, text: string, chunkId: float}|null
     */
    private function renderChunkPrerender(string $book, float $chunkId, BookCache $cache): ?array
    {
        $nodes = $cache->getChunk($book, $chunkId);
        if (empty($nodes)) {
            return null;
        }

        $html = '';
        $text = '';
        foreach ($nodes as $node) {
            $html .= $node['content'] ?? '';
            $plain = $node['plainText'] ?? '';
            if ($plain !== '') {
                $text .= $plain . ' ';
            }
        }

        // Layout-shift guard: stamp width/height onto attr-less media <img>
        // tags from book_images dims. The prerendered chunk paints BEFORE any
        // JS runs, so an unsized figure decoding above the restored reading
        // position shoves the page with no compensator awake — dims reserve
        // the box up front (`img { height:auto }` derives the ratio).
        // Render-time only; stored node content is never touched.
        $html = $this->injectImageDimensions($book, $html);

        // Same render-time marking the client does in chunkRender, applied here
        // so the pre-JS window is covered too: a browser translator acts on
        // first paint, which for a prerendered chunk is BEFORE our JS runs.
        $html = $this->markUntranslatableGlyphs($html);

        return ['html' => $html, 'text' => trim($text), 'chunkId' => $chunkId];
    }

    /**
     * Stamp `translate="no"` on the glyphs in a prerendered chunk that are not
     * prose: footnote markers (`sup[fn-count-id]`), hypercite arrows
     * (`.open-icon`) and `<latex>` / `<latex-block>`.
     *
     * A footnote marker is a NUMBER. Translating it breaks the link between
     * marker and definition, and for a target language with its own numerals
     * (Arabic-Indic, Devanagari) the marker stops matching anything at all.
     * `translate="no"` inherits, so marking the `<sup>` covers its inner anchor.
     *
     * Render-time only, exactly like `injectImageDimensions` — stored node
     * content is never touched, and the client's `contentProcessor` strips the
     * attribute again on any save path. Mirrors the pass in
     * `resources/js/lazyLoader/chunkRender.ts`; keep the two selectors in step.
     * Best-effort: any failure returns the HTML unchanged.
     */
    private function markUntranslatableGlyphs(string $html): string
    {
        if ($html === '') {
            return $html;
        }
        try {
            $out = preg_replace_callback('/<(sup|a|span|latex|latex-block)\b[^>]*>/i', function (array $m) {
                $tag = $m[0];
                if (preg_match('/\btranslate\s*=/i', $tag)) {
                    return $tag;
                }
                $isMarker = (bool) preg_match('/\bfn-count-id\s*=/i', $tag);
                $isArrow = (bool) preg_match('/\bclass\s*=\s*["\'][^"\']*\bopen-icon\b/i', $tag);
                $isLatex = (bool) preg_match('/^<latex(-block)?\b/i', $tag);
                if (! $isMarker && ! $isArrow && ! $isLatex) {
                    return $tag;
                }
                $insert = ' translate="no"';

                return str_ends_with($tag, '/>')
                    ? substr($tag, 0, -2) . $insert . ' />'
                    : substr($tag, 0, -1) . $insert . '>';
            }, $html);

            return $out ?? $html;
        } catch (\Throwable) {
            return $html;
        }
    }

    /**
     * Best-effort width/height injection for the prerendered chunk's media imgs.
     * Reads dims from book_images (measured at ingest; plaintext even for E2EE
     * books). Any failure returns the HTML unchanged.
     */
    private function injectImageDimensions(string $book, string $html): string
    {
        if ($html === '' || stripos($html, '<img') === false) {
            return $html;
        }
        try {
            $rows = \App\Models\PgBookImage::where('book', $book)
                ->whereNotNull('width')
                ->whereNotNull('height')
                ->get(['filename', 'width', 'height'])
                ->keyBy('filename');
            if ($rows->isEmpty()) {
                return $html;
            }
            $prefix = '/' . $book . '/media/';
            $out = preg_replace_callback('/<img\b[^>]*>/i', function (array $m) use ($rows, $prefix) {
                $tag = $m[0];
                if (preg_match('/\bwidth\s*=/i', $tag) && preg_match('/\bheight\s*=/i', $tag)) {
                    return $tag;
                }
                if (! preg_match('/\bsrc\s*=\s*["\']([^"\']+)["\']/i', $tag, $srcMatch)) {
                    return $tag;
                }
                $src = $srcMatch[1];
                if (! str_starts_with($src, $prefix)) {
                    return $tag;
                }
                $filename = rawurldecode(preg_replace('/[?#].*$/', '', substr($src, strlen($prefix))));
                $row = $rows[$filename] ?? null;
                if (! $row || ! $row->width || ! $row->height) {
                    return $tag;
                }
                $insert = ' width="' . (int) $row->width . '" height="' . (int) $row->height . '"';
                return str_ends_with($tag, '/>')
                    ? substr($tag, 0, -2) . $insert . ' />'
                    : substr($tag, 0, -1) . $insert . '>';
            }, $html);

            return $out ?? $html;
        } catch (\Throwable) {
            return $html;
        }
    }

    /**
     * Resolve a deep-link target (?target= / path $hl/$fn) to its chunk_id for the prerender.
     * Cached `index.json` first (no DB), else a LIVE lookup so a hypercite/highlight/footnote/node
     * created AFTER the last cache warm (not yet in the index) still prerenders its REAL chunk.
     * Mirrors DatabaseToIndexedDBController::resolveTargetToChunkIdWithReason. Returns chunk_id or null.
     */
    private function resolvePrerenderTargetChunk(string $book, string $target, BookCache $cache): ?float
    {
        $index = $cache->getIndex($book);
        if (is_array($index) && isset($index[$target])) {
            return (float) $index[$target];
        }
        // Index miss → live fallback (same branch order as the API resolver).
        if (str_starts_with($target, 'hypercite_')) {
            return $this->chunkOfAnnotationFirstNode($book, 'hypercites', 'hyperciteId', $target);
        }
        if (str_starts_with($target, 'HL_')) {
            return $this->chunkOfAnnotationFirstNode($book, 'hyperlights', 'hyperlight_id', $target);
        }
        if (preg_match('/(^|_)Fn\d/', $target)) {
            $node = DB::table('nodes')->where('book', $book)
                ->whereRaw('footnotes::jsonb @> ?', [json_encode([$target])])->first();
            return $node ? (float) $node->chunk_id : null;
        }
        if (preg_match('/^\d+(\.\d+)?$/', $target)) {
            $node = DB::table('nodes')->where('book', $book)->where('startLine', (float) $target)->first();
            return $node ? (float) $node->chunk_id : null;
        }
        return null;
    }

    /** Chunk of an annotation's first node_id (hypercite/hyperlight → nodes.chunk_id), or null. */
    private function chunkOfAnnotationFirstNode(string $book, string $table, string $idCol, string $target): ?float
    {
        $row = DB::table($table)->where('book', $book)->where($idCol, $target)->first();
        if (!$row) {
            return null;
        }
        $nodeIds = json_decode($row->node_id ?? '[]', true);
        if (empty($nodeIds)) {
            return null;
        }
        $node = DB::table('nodes')->where('book', $book)->where('node_id', $nodeIds[0])->first();
        return $node ? (float) $node->chunk_id : null;
    }

    private function getHyperlightDescription(string $subBookId, array $urlItems): ?string
    {
        // Check if the last URL item is a hyperlight (HL_...)
        $lastItem = end($urlItems);
        if (!$lastItem || !str_starts_with($lastItem, 'HL_')) {
            return null;
        }

        // Query the hyperlights table for the text content
        $hyperlight = DB::table('hyperlights')
            ->where('sub_book_id', $subBookId)
            ->first();

        if (!$hyperlight) {
            // Try matching by hyperlight_id in the parent book context
            $hlId = $lastItem;
            $parentBook = explode('/', $subBookId)[0] ?? null;
            if ($parentBook) {
                $hyperlight = DB::table('hyperlights')
                    ->where('book', $parentBook)
                    ->where('hyperlight_id', $hlId)
                    ->first();
            }
        }

        if ($hyperlight && !empty($hyperlight->highlightedText)) {
            return \Illuminate\Support\Str::limit(strip_tags($hyperlight->highlightedText), 200);
        }

        return null;
    }

    // Preprocess the markdown to handle soft line breaks
    private function normalizeMarkdown($markdown)
    {
        // Split markdown content by double newlines to preserve block-level elements
        $paragraphs = preg_split('/(\n\s*\n)/', $markdown, -1, PREG_SPLIT_DELIM_CAPTURE);

        // Iterate through each block and normalize only the inner soft line breaks, excluding code blocks, blockquotes, and lists
        foreach ($paragraphs as &$block) {
            // Skip processing if the block is a code block (either fenced or indented)
            if (preg_match('/^( {4}|\t)|(```)/m', $block)) {
                continue;  // Skip normalization for code blocks
            }

            // Skip processing if the block starts with a blockquote or a list item
            if (preg_match('/^\s*>|\d+\.\s|\*\s|-\s|\+\s/m', $block)) {
                continue;  // Skip normalization for blockquotes and lists
            }

            // If the block isn't just a delimiter (double newline), normalize inner soft line breaks
            if (!preg_match('/^\n\s*\n$/', $block)) {
                // Replace single newlines within a paragraph block with spaces
                $block = preg_replace('/(?<!\n)\n(?!\n)/', ' ', $block);
            }
        }

        // Recombine the paragraphs to maintain block structure
        return implode('', $paragraphs);
    }

    // Show the hyperlights content for a specific book
    public function showHyperlights($book)
    {
        // Define the path to the hyperlights markdown file
        $hyperLightsPath = resource_path("markdown/{$book}/hyperlights.md");

        // Check if the hyperlights markdown file exists
        if (!File::exists($hyperLightsPath)) {
            abort(404, "Hyperlights not found for book: $book");
        }

        // Load the hyperlights markdown file
        $markdown = File::get($hyperLightsPath);

        // Use CommonMarkConverter to convert the markdown to HTML
        $converter = new CommonMarkConverter();
        $html = $converter->convertToHtml($markdown);

        // Pass the converted HTML to the Blade template
        return view('hyperlights-md', [
            'html' => $html,
            'book' => $book
        ]);
    }

    public function showHyperlightsHTML($book)
    {
        // Define the path to the HTML file for this book
        $htmlFilePath = resource_path("markdown/{$book}/hyperlights.html");

        // Check if the HTML file exists
        if (!File::exists($htmlFilePath)) {
            abort(404, "Main HTML content not found for book: $book");
        }

        // Load the HTML file content
        $htmlContent = File::get($htmlFilePath);

        // Pass the content to the Blade template
        return view('hyperlights', [
            'htmlContent' => $htmlContent,  // Pass the HTML content
            'book' => $book
        ]);
    }
}
