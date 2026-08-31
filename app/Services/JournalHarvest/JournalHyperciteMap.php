<?php

namespace App\Services\JournalHarvest;

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

    /** The map SVG, or null when the journal has no readable articles. */
    public function svg(JournalSource $journal): ?string
    {
        return Cache::remember(
            "journal-hypercite-map:{$journal->id}:v5",
            self::CACHE_TTL,
            fn () => $this->build($journal),
        );
    }

    // ── data ─────────────────────────────────────────────────────────────────

    private function build(JournalSource $journal): ?string
    {
        $articles = $this->journalArticles($journal); // book => title
        if ($articles === []) {
            return null;
        }

        [$internalEdges, $spokes, $external] = $this->edges($articles);

        return $this->draw($journal, $articles, $internalEdges, $spokes, $external);
    }

    /** The journal's readable PUBLIC articles: book => {title, author, year}. */
    private function journalArticles(JournalSource $journal): array
    {
        $best = BestVersionService::sqlCoalesceExpression('cs');

        return DB::connection('pgsql_admin')->table('canonical_source as cs')
            ->join('library as l', 'l.book', '=', DB::raw("({$best})"))
            ->where('cs.journal_source_id', $journal->id)
            ->where('l.has_nodes', true)
            ->where('l.visibility', 'public')
            ->get(['l.book', 'l.title', 'l.author', 'l.year'])
            ->keyBy('book')
            ->map(fn ($r) => ['title' => (string) $r->title, 'author' => $r->author, 'year' => $r->year])
            ->all();
    }

    /**
     * Hypercite edges touching the journal, split into internal pairs and
     * spokes to visible outside books.
     *
     * @param  array<string, array{title:string, author:?string, year:mixed}>  $articles
     * @return array{0: array<int, array{0:string,1:string}>,
     *               1: array<int, array{0:string,1:string}>,
     *               2: array<string, array{title:string, author:?string, year:mixed}>}  [internalEdges, spokes(article, partner), partners]
     */
    private function edges(array $articles): array
    {
        // Whole-table load, like DocuverseController::data — hypercites is a
        // small table and the citing side only exists inside citedIN strings.
        $rows = DB::connection('pgsql_admin')->table('hypercites')
            ->whereRaw('"citedIN" IS NOT NULL AND "citedIN"::text NOT IN (\'[]\', \'null\')')
            ->get(['book', 'citedIN']);

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
            ->get(['book', 'title', 'author', 'year'])
            ->keyBy('book')
            ->map(fn ($r) => ['title' => (string) $r->title, 'author' => $r->author, 'year' => $r->year]);

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

        return [$internalEdges, $spokes, $external->only($keep)->all()];
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
        JournalSource $journal,
        array $articles,
        array $internalEdges,
        array $spokes,
        array $external,
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
        $plain = array_diff(array_keys($articles), $connected);
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

        return $this->emit($journal, $articles, $external, $pos, $inBlob, $degree, $internalEdges, $spokes, $blobRadius, $ringR);
    }

    private function emit(
        JournalSource $journal,
        array $articles,
        array $external,
        array $pos,
        array $inBlob,
        array $degree,
        array $internalEdges,
        array $spokes,
        float $blobRadius,
        float $ringR,
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

        $s = [];
        $s[] = '<svg viewBox="' . $this->n($minX) . ' ' . $this->n($minY) . ' ' . $this->n($width) . ' ' . $this->n($height) . '"'
            . ' role="img" aria-label="Hypercite network of ' . e($journal->display_name) . '"'
            . ' style="display:block;width:100%;max-width:' . $this->n(self::RENDER_WIDTH_PX) . 'px;height:auto;margin:0 auto">';

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
        foreach ($inBlob as $book => $_) {
            [$x, $y] = $pos[$book];
            $deg = $degree[$book] ?? 0;
            $lit = $deg > 0;
            $r = $lit
                ? min($rLitBase + 0.8 * $k * ($deg - 1), self::R_LIT_CAP_PX * $k)
                : $rPlain;
            $opacity = $lit ? '1' : '0.5';
            $s[] = $this->anchorOpen($book, $articles[$book] ?? null, $lit ? 'lit' : 'article', $deg)
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n($r) . '"'
                . ' fill="' . self::INK . '" fill-opacity="' . $opacity . '"></circle></a>';
        }

        // External partners: aqua dots, no inline labels — titles surface in
        // the hover/tap card, which is what lets the network fill the width.
        foreach ($external as $book => $meta) {
            if (!isset($pos[$book])) {
                continue;
            }
            [$x, $y] = $pos[$book];
            $s[] = $this->anchorOpen($book, $meta, 'beyond', 0)
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n($rExternal) . '"'
                . ' fill="' . self::AQUA . '" stroke="' . self::INK . '" stroke-opacity="0.5" stroke-width="' . $this->n($k) . '"></circle></a>';
        }

        $s[] = '</svg>';

        return implode('', $s);
    }

    /**
     * The opening <a> for a node: link + the data the hover card reads
     * (components/journalHyperciteMap). No SVG <title> child — the native
     * tooltip would double up with the card. aria-label keeps the node named
     * for screen readers; tabindex="-1" is the welcome-copy keyboard model.
     *
     * @param  ?array{title:string, author:?string, year:mixed}  $meta
     */
    private function anchorOpen(string $book, ?array $meta, string $kind, int $degree): string
    {
        $title = $meta['title'] ?? $book;

        return '<a href="/' . e(rawurlencode($book)) . '" tabindex="-1"'
            . ' aria-label="' . e($title) . '"'
            . ' data-map-node="' . $kind . '"'
            . ' data-title="' . e($title) . '"'
            . ($meta !== null && $meta['author'] !== null && $meta['author'] !== '' ? ' data-author="' . e((string) $meta['author']) . '"' : '')
            . ($meta !== null && ($meta['year'] ?? null) ? ' data-year="' . e((string) $meta['year']) . '"' : '')
            . ($degree > 0 ? ' data-connections="' . $degree . '"' : '')
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
