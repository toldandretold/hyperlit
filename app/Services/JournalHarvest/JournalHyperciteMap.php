<?php

namespace App\Services\JournalHarvest;

use App\Helpers\BookSlugHelper;
use App\Models\JournalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * The journal hero's hypercite map: the journal's readable articles as a
 * sunflower-spiral BLOB — hypercited ones highlighted and interconnected —
 * with SPOKES out to the books beyond the journal they're hypercited with.
 * Emits a self-contained inline <svg> string for journal-home.blade.php.
 *
 * Server-rendered on purpose: the yield report's harvest-network visual is
 * client-rendered only because NodeHtmlSanitizer bans <svg> in STORED node
 * content — a blade view has no such constraint, and inlining means no new JS
 * component, no ButtonRegistry surface, and the visual is SEO-visible.
 *
 * Every readable article is a dot (the blob reads as "the journal" even when
 * hypercites are sparse); hypercited articles draw solid + larger. A
 * hypercited-only variant was built and compared — the all-articles shape won.
 *
 * Data reads go through pgsql_admin with EXPLICIT public + has_nodes gates
 * (the CitedWorksQuery `held`-subquery pattern): the output is then
 * viewer-independent, which is what makes the 15-minute cache safe. An edge
 * whose outside endpoint is private or contentless is dropped entirely — an
 * invisible book's title must never leak into a public page.
 *
 * Colors are fixed hex, not theme vars: the hero copy is always
 * #221F20-on-lava-lamp regardless of the reader theme (homepage.css).
 * Everything INTERNAL (article dots, article↔article edges) draws in that ink
 * — the lava lamp is pink/orange, so brand pink disappears into it (the first
 * ship did exactly that). Aqua is reserved for the OUTSIDE world: partner
 * books and the spokes reaching them, darkened from the raw brand stop for
 * the same reason.
 */
class JournalHyperciteMap
{
    private const CACHE_TTL = 900; // matches the homepage recompute cadence

    /**
     * Stale-serve window: between CACHE_TTL and this, the stored SVG is served
     * instantly and the rebuild runs deferred after the response — nobody pays
     * the whole-hypercites-table edge walk inline (the first visitor after
     * every 15-min expiry used to). Same pattern as the user-page map.
     */
    private const CACHE_STALE_TTL = 86400;

    /** Blob dots beyond this are dropped (hypercited articles win the cut). */
    private const MAX_BLOB_DOTS = 400;

    private const GOLDEN_ANGLE = 2.399963229728653; // 137.508° in radians

    private const SPIRAL_SPACING = 11.0; // ≈ nearest-neighbour distance in the blob

    /**
     * ON-SCREEN pixel sizes at the rendered width. The blob geometry is
     * data-driven (viewBox units), so emit() SOLVES the viewBox↔pixel scale
     * and multiplies every cosmetic size by it — dots and edge widths render
     * the same physical size whether the journal has 8 articles or 400.
     * No inline text labels: titles live in the hover/tap card
     * (components/journalHyperciteMap), which lets the network itself fill
     * the full width.
     */
    private const RENDER_WIDTH_PX = 680.0;

    private const R_PLAIN_PX = 3.0;

    private const R_LIT_PX = 5.0;

    private const R_LIT_CAP_PX = 9.0;

    private const R_EXTERNAL_PX = 4.5;

    /** Fixed hero palette (see class docblock). */
    private const INK = '#221F20';

    private const AQUA = '#2E7D80'; // darkened brand aqua — the raw #4EACAE washes out on the lamp

    /**
     * The map SVG, or null when the journal has no readable articles.
     * Stale-while-revalidate (see CACHE_STALE_TTL). The value is wrapped in an
     * array because a null SVG (empty corpus) must still cache — a bare cached
     * null reads as a miss and rebuilds every request.
     */
    public function svg(JournalSource $journal): ?string
    {
        $cached = Cache::flexible(
            // v10: figure wrapper + figcaption + legend, with the legend rows
            // now conditional on what was actually drawn. The cache stores
            // RENDERED markup, so a markup change is invisible to every warm
            // page until this key moves — bump it whenever emit() changes.
            "journal-hypercite-map:{$journal->id}:v10",
            [self::CACHE_TTL, self::CACHE_STALE_TTL],
            fn () => ['svg' => $this->buildFromCorpus(
                $this->journalArticles($journal),
                'Hypercite network of ' . $journal->display_name,
                ['noun' => 'article', 'plural' => 'articles', 'beyond' => 'beyond the journal'],
            )],
        );

        return $cached['svg'] ?? null;
    }

    /**
     * The vocabulary the figure describes itself with. The same network renders
     * for a journal (whose nodes are "articles" with partners "beyond the
     * journal") and for a user's library on /u/{username} ("books", "beyond
     * this library") — the legend used to be hand-copied into each blade with
     * the nouns swapped, which is exactly how two copies drift.
     *
     * @var array{noun: string, plural: string, beyond: string}
     */
    private const DEFAULT_VOCAB = [
        'noun' => 'text',
        'plural' => 'texts',
        'beyond' => 'beyond this collection',
    ];

    /**
     * Corpus-agnostic entry: any `book => {title, author, year, slug}` map (e.g.
     * a USER's public library on /u/{username}) renders the same network. The
     * corpus MUST be public-visibility only when the result is cached — the
     * SVG is served to every viewer of the page.
     *
     * @param  array<string, array{title:string, author:?string, year:mixed, slug?:?string}>  $articles
     * @param  array{noun?:string, plural?:string, beyond?:string}  $vocab
     */
    public function svgForBooks(array $articles, string $ariaLabel, string $cacheKey, array $vocab = []): ?string
    {
        return Cache::remember(
            $cacheKey,
            self::CACHE_TTL,
            fn () => $this->buildFromCorpus($articles, $ariaLabel, $vocab),
        );
    }

    /**
     * Uncached corpus build — for callers that manage their own caching. The
     * user page wraps its corpus QUERY and this build in one
     * stale-while-revalidate entry (UserHomeServerController::show), so the
     * expensive whole-hypercites-table edge walk runs after the response is
     * sent instead of inline for whichever visitor hits the 15-min expiry.
     *
     * @param  array{noun?:string, plural?:string, beyond?:string}  $vocab
     * @param  bool  $connectedOnly  See buildFromCorpus.
     */
    public function buildSvgForBooks(
        array $articles,
        string $ariaLabel,
        array $vocab = [],
        bool $connectedOnly = false,
    ): ?string {
        return $this->buildFromCorpus($articles, $ariaLabel, $vocab, $connectedOnly);
    }

    // ── data ─────────────────────────────────────────────────────────────────

    /**
     * $connectedOnly drops texts with NO hypercite edge from the blob, leaving
     * the wired core plus its partners.
     *
     * Default false, and that default is load-bearing for the journal and user
     * pages: the class docblock records that a hypercited-only variant was built
     * and compared, and the all-articles shape won — the full blob is what reads
     * as "the journal". The HOMEPAGE is the opposite case, which is why this is a
     * per-caller choice rather than a change of default: its corpus is the whole
     * public library, where unconnected dots are the overwhelming majority, so
     * all-articles would be a field of ~300 dots with a handful of lines, and
     * would also run into MAX_BLOB_DOTS truncation as the library grows.
     *
     * The corpus still has to be passed in FULL — the edge walk is what
     * discovers which books are connected, so the filter can only happen after
     * it, in draw().
     */
    private function buildFromCorpus(
        array $articles,
        string $ariaLabel,
        array $vocab = [],
        bool $connectedOnly = false,
    ): ?string {
        if ($articles === []) {
            return null;
        }

        [$internalEdges, $spokes, $external, $intro] = $this->edges($articles);

        return $this->draw(
            $ariaLabel,
            $articles,
            $internalEdges,
            $spokes,
            $external,
            $intro,
            array_merge(self::DEFAULT_VOCAB, array_filter($vocab)),
            $connectedOnly,
        );
    }

    /**
     * The journal's readable PUBLIC articles: book => {title, author, year, slug}.
     *
     * `slug` rides along so the text alternative can link each node at its
     * CANONICAL url. Without it the list would hard-code `/{book_id}`, and a
     * slugged article would be linked from its own journal page at a URL that
     * canonicalizes elsewhere — fragmenting the signal this whole exercise is
     * meant to concentrate.
     */
    private function journalArticles(JournalSource $journal): array
    {
        $best = BestVersionService::sqlCoalesceExpression('cs');

        return DB::connection('pgsql_admin')->table('canonical_source as cs')
            ->join('library as l', 'l.book', '=', DB::raw("({$best})"))
            ->where('cs.journal_source_id', $journal->id)
            ->where('l.has_nodes', true)
            ->where('l.visibility', 'public')
            ->get(['l.book', 'l.title', 'l.author', 'l.year', 'l.slug'])
            ->keyBy('book')
            ->map(fn ($r) => [
                'title' => (string) $r->title,
                'author' => $r->author,
                'year' => $r->year,
                'slug' => $r->slug,
            ])
            ->all();
    }

    /**
     * Hypercite edges touching the journal, split into internal pairs and
     * spokes to visible outside books.
     *
     * @param  array<string, array{title:string, author:?string, year:mixed}>  $articles
     * @return array{0: array<int, array{0:string,1:string}>,
     *               1: array<int, array{0:string,1:string}>,
     *               2: array<string, array{title:string, author:?string, year:mixed}>,
     *               3: array<string, string>}  [internalEdges, spokes(article, partner), partners, introFragments]
     */
    private function edges(array $articles): array
    {
        // Whole-table load, like DocuverseController::data — hypercites is a
        // small table and the citing side only exists inside citedIN strings.
        // Ordered by id so the INTRO fragment (below) is deterministic: the
        // earliest-minted hypercite wins.
        $rows = DB::connection('pgsql_admin')->table('hypercites')
            ->whereRaw('"citedIN" IS NOT NULL AND "citedIN"::text NOT IN (\'[]\', \'null\')')
            ->orderBy('id')
            ->get(['book', 'hyperciteId', 'citedIN']);

        // A dot's INTRO deep-link: land a first-time visitor ON hypercited
        // text (the click handler skips it when the reader has a saved
        // position). Inbound beats outbound — the cited book's own
        // #hyperciteId opens on the underlined passage; the citing side only
        // has its ↗ anchor (the fragment inside the citedIN entry).
        $inFrag = [];
        $outFrag = [];

        $pairs = [];
        foreach ($rows as $r) {
            $targets = json_decode($r->citedIN, true);
            if (!is_array($targets)) {
                continue;
            }
            $cited = $this->rootBook($r->book);
            foreach ($targets as $url) {
                // Entries look like "/book_123…#hypercite_abc"; sub-books fold to root.
                $path = parse_url((string) $url, PHP_URL_PATH) ?: '';
                $citing = $this->rootBook(ltrim($path, '/'));
                if ($cited === '' || $citing === '' || $cited === $citing) {
                    continue;
                }
                $aIn = isset($articles[$cited]);
                $bIn = isset($articles[$citing]);
                if (!$aIn && !$bIn) {
                    continue;
                }
                $inFrag[$cited] ??= (string) $r->hyperciteId;
                $anchor = parse_url((string) $url, PHP_URL_FRAGMENT);
                if (is_string($anchor) && $anchor !== '') {
                    $outFrag[$citing] ??= $anchor;
                }
                // Undirected for the visual — dedup on the sorted pair.
                [$lo, $hi] = $cited < $citing ? [$cited, $citing] : [$citing, $cited];
                $pairs["{$lo}→{$hi}"] = [$cited, $citing, $aIn, $bIn];
            }
        }

        // Outside endpoints must be publicly readable or the edge vanishes.
        $outside = [];
        foreach ($pairs as [$a, $b, $aIn, $bIn]) {
            if (!$aIn) {
                $outside[$a] = true;
            }
            if (!$bIn) {
                $outside[$b] = true;
            }
        }
        $external = $outside === [] ? collect() : DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', array_keys($outside))
            ->where('has_nodes', true)
            ->where('visibility', 'public')
            // slug: same reason as journalArticles() — the text alternative
            // links every node at its canonical url, partners included.
            ->get(['book', 'title', 'author', 'year', 'slug'])
            ->keyBy('book')
            ->map(fn ($r) => [
                'title' => (string) $r->title,
                'author' => $r->author,
                'year' => $r->year,
                'slug' => $r->slug,
            ]);

        $internalEdges = [];
        $spokes = [];
        foreach ($pairs as [$a, $b, $aIn, $bIn]) {
            if ($aIn && $bIn) {
                $internalEdges[] = [$a, $b];
            } else {
                [$article, $partner] = $aIn ? [$a, $b] : [$b, $a];
                if ($external->has($partner)) {
                    $spokes[] = [$article, $partner];
                }
            }
        }

        // Only partners that survived the visibility gate AND still have a spoke.
        $keep = array_unique(array_column($spokes, 1));

        return [$internalEdges, $spokes, $external->only($keep)->all(), $inFrag + $outFrag];
    }

    private function rootBook(string $book): string
    {
        return explode('/', $book, 2)[0];
    }

    // ── layout + drawing ─────────────────────────────────────────────────────

    /**
     * @param  array<string, array{title:string, author:?string, year:mixed}>  $articles
     * @param  array<int, array{0:string,1:string}>  $internalEdges
     * @param  array<int, array{0:string,1:string}>  $spokes
     * @param  array<string, array{title:string, author:?string, year:mixed}>  $external
     */
    private function draw(
        string $ariaLabel,
        array $articles,
        array $internalEdges,
        array $spokes,
        array $external,
        array $intro,
        array $vocab,
        bool $connectedOnly = false,
    ): string {
        // Degree per article (any hypercite edge) drives ordering + emphasis.
        $degree = [];
        foreach ($internalEdges as [$a, $b]) {
            $degree[$a] = ($degree[$a] ?? 0) + 1;
            $degree[$b] = ($degree[$b] ?? 0) + 1;
        }
        foreach ($spokes as [$article]) {
            $degree[$article] = ($degree[$article] ?? 0) + 1;
        }

        // Blob membership: hypercited articles first (they take the centre of
        // the spiral), then the rest, title-sorted for determinism. Capped;
        // hypercited articles win the cut.
        $title = fn (string $book): string => $articles[$book]['title'] ?? '';
        $connected = array_keys($degree);
        usort($connected, fn ($x, $y) => [$degree[$y], $title($x)] <=> [$degree[$x], $title($y)]);
        // connectedOnly: the wired core only. The homepage's corpus is the whole
        // public library, where unconnected texts dominate — see buildFromCorpus.
        $plain = $connectedOnly ? [] : array_diff(array_keys($articles), $connected);
        usort($plain, fn ($x, $y) => strcmp($title($x), $title($y)));
        $blob = array_slice(array_merge($connected, $plain), 0, self::MAX_BLOB_DOTS);
        if ($blob === []) {
            return ''; // callers treat '' like null via the blade truthiness check
        }
        $inBlob = array_flip($blob);

        // Sunflower spiral: dot i at angle i·φ, radius s·√i.
        $pos = [];
        foreach ($blob as $i => $book) {
            $theta = $i * self::GOLDEN_ANGLE;
            $r = self::SPIRAL_SPACING * sqrt($i);
            $pos[$book] = [$r * cos($theta), $r * sin($theta), $theta];
        }
        $blobRadius = self::SPIRAL_SPACING * sqrt(count($blob));

        // External partners on an outer ring at the circular-mean angle of
        // their connected blob dots, then one sorted pass enforcing a minimum
        // angular separation so labels never stack.
        $ringR = $blobRadius + 78;
        $anglesByPartner = [];
        foreach ($spokes as [$article, $partner]) {
            if (isset($inBlob[$article])) {
                $anglesByPartner[$partner][] = $pos[$article][2];
            }
        }
        $ring = [];
        foreach (array_keys($external) as $j => $partner) {
            $angles = $anglesByPartner[$partner] ?? [$j * self::GOLDEN_ANGLE];
            $ring[$partner] = atan2(
                array_sum(array_map(sin(...), $angles)) / count($angles),
                array_sum(array_map(cos(...), $angles)) / count($angles),
            );
        }
        asort($ring);
        $minSep = count($ring) > 0 ? min(0.6, (2 * M_PI) / count($ring)) : 0.6;
        $prev = null;
        foreach ($ring as $partner => $angle) {
            if ($prev !== null && $angle - $prev < $minSep) {
                $angle = $prev + $minSep;
            }
            $ring[$partner] = $angle;
            $prev = $angle;
            $pos[$partner] = [$ringR * cos($angle), $ringR * sin($angle), $angle];
        }

        return $this->emit($ariaLabel, $articles, $external, $pos, $inBlob, $degree, $internalEdges, $spokes, $blobRadius, $ringR, $intro, $vocab);
    }

    private function emit(
        string $ariaLabel,
        array $articles,
        array $external,
        array $pos,
        array $inBlob,
        array $degree,
        array $internalEdges,
        array $spokes,
        float $blobRadius,
        float $ringR,
        array $intro,
        array $vocab,
    ): string {
        // ── Solve the viewBox↔pixel scale ──
        // The blob/ring geometry is fixed viewBox units; dots/strokes are
        // specified in ON-SCREEN pixels and multiplied by $k (viewBox units
        // per rendered pixel). Total width = 2·core + 2k·P where P is the
        // per-side pixel margin, and k = width / RENDER_WIDTH — solving gives
        // the closed form below.
        $core = $external !== [] ? $ringR : $blobRadius;
        $chromePx = self::R_EXTERNAL_PX + 14;
        $k = 2 * $core / (self::RENDER_WIDTH_PX - 2 * $chromePx);
        $extent = $core + $chromePx * $k;
        $width = 2 * $extent;
        $minX = -$extent;
        $minY = -$extent;
        $height = 2 * $extent;

        // Rendered-pixel sizes, converted to viewBox units. Plain dots are
        // clamped against the spiral spacing so a dense blob stays a field of
        // distinct dots rather than a smear.
        $rPlain = min(self::R_PLAIN_PX * $k, 0.4 * self::SPIRAL_SPACING);
        $rLitBase = min(self::R_LIT_PX * $k, 0.8 * self::SPIRAL_SPACING);
        $rExternal = self::R_EXTERNAL_PX * $k;

        // role="group", NOT role="img": every dot is a real <a href> (SEO-visible
        // and the mouse click target), and `img` is a children-presentational role
        // — an interactive descendant inside it is the axe `nested-interactive`
        // violation (WCAG 4.1.2, serious) that the user-page a11y scan caught. A
        // labelled group keeps the one-line name for the diagram while letting the
        // node links stay legitimately in the accessibility tree.
        // data-map-noun / data-map-noun-beyond carry the VOCABULARY to the JS
        // hover card (components/journalHyperciteMap). Without them the card
        // hard-codes journal nouns and a book on /u/{name} reads "Hypercited
        // ARTICLE" — a live bug for as long as the PHP side was parameterised
        // and the JS side was not. Any new render surface gets correct labels by
        // passing $vocab; nothing has to be edited in the JS.
        $s = [];
        $s[] = '<svg viewBox="' . $this->n($minX) . ' ' . $this->n($minY) . ' ' . $this->n($width) . ' ' . $this->n($height) . '"'
            . ' role="group" aria-label="' . e($ariaLabel) . '"'
            . ' data-map-noun="' . e($vocab['noun']) . '"'
            . ' data-map-noun-beyond="' . e($vocab['beyond']) . '"'
            . ' style="display:block;width:100%;max-width:' . $this->n(self::RENDER_WIDTH_PX) . 'px;height:auto;margin:0 auto">';

        // <desc>, and deliberately NOT <title>: aria-label already supplies the
        // accessible name, and a <title> child renders a native browser tooltip
        // on hover — which would fight the hover/tap card the whole visual is
        // built around (components/journalHyperciteMap). <desc> is announced by
        // screen readers and draws nothing.
        //
        // It says how BIG the network is and where to read it — deliberately
        // NOT the same sentence as the <figcaption>, which explains what the
        // shapes MEAN. Duplicating them would make a screen reader announce the
        // same text twice for one graphic.
        $nodeCount = count($inBlob) + count($external);
        $edgeCount = count($internalEdges) + count($spokes);
        $s[] = '<desc>' . e(
            'A network diagram of ' . $nodeCount . ' ' . ($nodeCount === 1 ? $vocab['noun'] : $vocab['plural'])
            . ' and ' . $edgeCount . ' hypercite connection' . ($edgeCount === 1 ? '' : 's')
            . '. Every one is listed in full after the diagram.'
        ) . '</desc>';

        // Edges first, under the dots. Internal pairs bow toward the blob
        // centre; spokes bow gently outward on their way to the ring.
        foreach ($internalEdges as [$a, $b]) {
            if (!isset($pos[$a], $pos[$b])) {
                continue;
            }
            $s[] = $this->curve($pos[$a], $pos[$b], 0.62, self::INK, 0.6, 1.5 * $k);
        }
        foreach ($spokes as [$a, $b]) {
            if (!isset($pos[$a], $pos[$b])) {
                continue;
            }
            $s[] = $this->curve($pos[$a], $pos[$b], 1.12, self::AQUA, 0.8, 1.3 * $k);
        }

        // Blob dots: hypercited articles solid ink, sized by degree; the rest
        // faint ink.
        $plainDrawn = 0;
        foreach ($inBlob as $book => $_) {
            [$x, $y] = $pos[$book];
            $deg = $degree[$book] ?? 0;
            $lit = $deg > 0;
            if (! $lit) {
                $plainDrawn++;
            }
            $r = $lit
                ? min($rLitBase + 0.8 * $k * ($deg - 1), self::R_LIT_CAP_PX * $k)
                : $rPlain;
            $opacity = $lit ? '1' : '0.5';
            $s[] = $this->anchorOpen($book, $articles[$book] ?? null, $lit ? 'lit' : 'article', $deg, $intro[$book] ?? null)
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n($r) . '"'
                . ' fill="' . self::INK . '" fill-opacity="' . $opacity . '"></circle></a>';
        }

        // External partners: aqua dots, no inline labels — titles surface in
        // the hover/tap card, which is what lets the network fill the width.
        // Counted, because the legend must not advertise a key for a symbol the
        // diagram does not contain (see legend()).
        $beyondDrawn = 0;
        foreach ($external as $book => $meta) {
            if (!isset($pos[$book])) {
                continue;
            }
            $beyondDrawn++;
            [$x, $y] = $pos[$book];
            $s[] = $this->anchorOpen($book, $meta, 'beyond', 0, $intro[$book] ?? null)
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n($rExternal) . '"'
                . ' fill="' . self::AQUA . '" stroke="' . self::INK . '" stroke-opacity="0.5" stroke-width="' . $this->n($k) . '"></circle></a>';
        }

        $s[] = '</svg>';

        // <figcaption> holds the sentence AND the legend, and is the LAST child:
        // HTML's content model for <figure> is flow content followed by at most
        // one <figcaption> (or a <figcaption> first), so a caption in the MIDDLE
        // is invalid — and both parts describe the one graphic, so the caption is
        // where they belong rather than loose siblings.
        //
        // There was briefly a <details> "view as a list" text alternative here
        // too. It was removed deliberately, and should not come back on either
        // of its original justifications: the KEYBOARD route is contentHopper
        // (see anchorOpen), which already reaches these dots, and its <summary>
        // was a native Tab stop inside .welcome-copy — i.e. it BROKE the
        // homepage's chrome-only Tab loop (WCAG 2.4.3) rather than helping.
        // Its only real benefit was giving a crawler the title as anchor text,
        // which did not justify ~1,200 DOM elements and a 150-row list under
        // the hero on the site's busiest page.
        return '<figure class="hypercite-figure">'
            . implode('', $s)
            . '<figcaption class="hypercite-figcaption">'
            . '<p class="hypercite-encoding">' . e($this->encodingSentence($vocab, $beyondDrawn > 0, $plainDrawn > 0)) . '</p>'
            . $this->legend($vocab, $beyondDrawn > 0, $plainDrawn > 0)
            . '</figcaption>'
            . '</figure>';
    }

    /**
     * One sentence explaining what the diagram ENCODES — the thing a sighted
     * reader cannot infer from the picture (that dot SIZE is connection count)
     * and a screen-reader user cannot get at all.
     *
     * Rendered as the visible <figcaption>. The SVG's <desc> says something
     * different on purpose — how big the network is — because identical text in
     * both would be announced twice for one graphic.
     */
    private function encodingSentence(array $vocab, bool $hasBeyond = true, bool $hasPlain = true): string
    {
        // With no faint dots (connected-core mode) EVERY dot is hypercited, so
        // "the larger solid dots are hypercited" describes a distinction the
        // diagram does not draw. Size still means degree, which is the part a
        // reader cannot infer.
        $dots = $hasPlain
            ? 'Each dot is one ' . $vocab['noun'] . '; the larger solid dots are hypercited, '
                . 'sized by how many connections they have.'
            : 'Each dot is one ' . $vocab['noun'] . ', sized by how many connections it has.';

        return $dots
            . ' A line joins two ' . $vocab['plural'] . ' that are hypercited together'
            . ($hasBeyond ? ', and the outer ring holds works ' . $vocab['beyond'] : '')
            . '.';
    }

    /**
     * The visual key. Lives here rather than in the two blades that render this
     * figure: it was hand-copied into both with the nouns swapped, so the
     * journal and user versions could silently diverge. Class names are
     * unchanged (journalHome.css styles them, and the page tests assert
     * `journal-map-legend`).
     *
     * aria-hidden: every swatch is a colour sample whose meaning the
     * <figcaption> already states in words — read aloud it is four fragments
     * about dots, which is noise, not information.
     *
     * Both flags suppress a row rather than describe one, because a key for a
     * symbol the diagram does not contain is worse than no key:
     *
     *  - $hasBeyond: on the HOMEPAGE the collection is everything public on
     *    Hyperlit, so nothing is "beyond" it. Claiming otherwise is what made a
     *    Hyperlit article read as an external work (PublicBookCorpus::forHyperciteMap).
     *  - $hasPlain: in connected-core mode every dot is hypercited, so
     *    "hypercited X" vs "X" is a distinction with nothing on either side of
     *    it. One row stating that size means connections is the whole key.
     */
    private function legend(array $vocab, bool $hasBeyond = true, bool $hasPlain = true): string
    {
        $rows = $hasPlain
            ? '<li><span class="jml-dot jml-lit"></span>hypercited ' . e($vocab['noun'])
                . ' <em>(bigger = more connections)</em></li>'
                . '<li><span class="jml-dot jml-plain"></span>' . e($vocab['noun']) . '</li>'
            : '<li><span class="jml-dot jml-lit"></span>' . e($vocab['noun'])
                . ' <em>(bigger = more connections)</em></li>';

        return '<ul class="journal-map-legend" aria-hidden="true">'
            . $rows
            . '<li><span class="jml-line"></span>' . e($vocab['plural']) . ' hypercited together</li>'
            . ($hasBeyond
                ? '<li><span class="jml-dot jml-ext"></span>hypercited work ' . e($vocab['beyond']) . '</li>'
                : '')
            . '</ul>';
    }

    /**
     * The opening <a> for a node: link + the data the hover card reads
     * (components/journalHyperciteMap). No SVG <title> child — the native
     * tooltip would double up with the card. aria-label keeps the node named
     * for screen readers.
     *
     * tabindex="-1" STAYS, and these links are still keyboard-reachable: the
     * route is contentHopper (components/contentHopper), whose n/j/p/k keys hop
     * every `a[href]` inside its roots — `.main-content` and `.welcome-copy`.
     * This figure IS inside `.welcome-copy` on all three pages that render it
     * (`welcome-copy journal-about`, `welcome-copy user-about`, and the homepage
     * copy), so the dots are covered by the site-wide keyboard model described
     * in docs/a11y-findings.md: Tab never enters content, n/p always does.
     *
     * An earlier version of this comment claimed the opposite — that
     * contentHopper could not reach the figure — and a <details> list was added
     * to compensate. That was simply wrong, and the list's <summary> then broke
     * the homepage's chrome-only Tab loop by being a native Tab stop inside
     * `.welcome-copy`. Don't make 400 dots tab stops either; that buries the
     * page behind hundreds of presses, which is why tabindex="-1" is correct.
     *
     * data-intro carries the FIRST hypercite's URL fragment: the click handler
     * appends it for visitors with no saved reading position, so their first
     * landing opens on hypercited text — the system introducing itself.
     *
     * @param  ?array{title:string, author:?string, year:mixed, slug?:?string}  $meta
     */
    private function anchorOpen(string $book, ?array $meta, string $kind, int $degree, ?string $introFragment = null): string
    {
        $title = $meta['title'] ?? $book;

        // Canonical path (slug preferred), root-relative so the SPA link handler
        // treats it like any in-page link — a slugged work must not be linked
        // from its own collection page at a URL that canonicalizes elsewhere.
        // aria-label is the title, and the hover card reads it from there — there
        // used to be an identical `data-title` alongside, which was 19% of the
        // whole SVG (11kB on the prod journal page) for a second copy of the same
        // string. One attribute, two consumers.
        return '<a href="' . e(BookSlugHelper::canonicalPath($book, $meta['slug'] ?? null)) . '" tabindex="-1"'
            . ' aria-label="' . e($title) . '"'
            . ' data-map-node="' . $kind . '"'
            . ($meta !== null && $meta['author'] !== null && $meta['author'] !== '' ? ' data-author="' . e((string) $meta['author']) . '"' : '')
            . ($meta !== null && ($meta['year'] ?? null) ? ' data-year="' . e((string) $meta['year']) . '"' : '')
            . ($degree > 0 ? ' data-connections="' . $degree . '"' : '')
            . ($introFragment !== null && $introFragment !== '' ? ' data-intro="' . e($introFragment) . '"' : '')
            . '>';
    }

    /** A quadratic curve whose control point is the midpoint scaled by $pull toward/away from the origin. */
    private function curve(array $a, array $b, float $pull, string $stroke, float $opacity, float $width): string
    {
        $mx = ($a[0] + $b[0]) / 2 * $pull;
        $my = ($a[1] + $b[1]) / 2 * $pull;

        return '<path d="M ' . $this->n($a[0]) . ' ' . $this->n($a[1])
            . ' Q ' . $this->n($mx) . ' ' . $this->n($my)
            . ' ' . $this->n($b[0]) . ' ' . $this->n($b[1]) . '"'
            . ' fill="none" stroke="' . $stroke . '" stroke-opacity="' . $opacity . '"'
            . ' stroke-width="' . $this->n($width) . '"/>';
    }

    /** Compact numeric formatting for SVG attributes. */
    private function n(float $v): string
    {
        return rtrim(rtrim(number_format($v, 1, '.', ''), '0'), '.') ?: '0';
    }
}
