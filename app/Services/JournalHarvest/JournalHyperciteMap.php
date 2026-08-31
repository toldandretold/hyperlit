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
 * Modes (both rendered on the page while the winner is being chosen):
 *  - 'all'       — every readable article is a dot; hypercited ones brighter.
 *  - 'connected' — only articles participating in hypercites.
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

    private const R_PLAIN = 3.0;

    private const R_LIT = 5.0;

    private const R_EXTERNAL = 4.5;

    private const LABEL_CHARS = 24;

    /** Fixed hero palette (see class docblock). */
    private const INK = '#221F20';

    private const AQUA = '#2E7D80'; // darkened brand aqua — the raw #4EACAE washes out on the lamp

    /**
     * The map SVG, or null when there is nothing to draw
     * ('connected': no hypercite edges; 'all': no readable articles).
     */
    public function svg(JournalSource $journal, string $mode): ?string
    {
        return Cache::remember(
            "journal-hypercite-map:{$journal->id}:{$mode}:v2",
            self::CACHE_TTL,
            fn () => $this->build($journal, $mode),
        );
    }

    // ── data ─────────────────────────────────────────────────────────────────

    private function build(JournalSource $journal, string $mode): ?string
    {
        $articles = $this->journalArticles($journal); // book => title
        if ($articles === []) {
            return null;
        }

        [$internalEdges, $spokes, $external] = $this->edges($articles);

        if ($mode === 'connected' && $internalEdges === [] && $spokes === []) {
            return null;
        }

        return $this->draw($journal, $mode, $articles, $internalEdges, $spokes, $external);
    }

    /** The journal's readable PUBLIC articles: book => title. */
    private function journalArticles(JournalSource $journal): array
    {
        $best = BestVersionService::sqlCoalesceExpression('cs');

        return DB::connection('pgsql_admin')->table('canonical_source as cs')
            ->join('library as l', 'l.book', '=', DB::raw("({$best})"))
            ->where('cs.journal_source_id', $journal->id)
            ->where('l.has_nodes', true)
            ->where('l.visibility', 'public')
            ->pluck('l.title', 'l.book')
            ->map(fn ($t) => (string) $t)
            ->all();
    }

    /**
     * Hypercite edges touching the journal, split into internal pairs and
     * spokes to visible outside books.
     *
     * @param  array<string, string>  $articles
     * @return array{0: array<int, array{0:string,1:string}>,
     *               1: array<int, array{0:string,1:string}>,
     *               2: array<string, string>}  [internalEdges, spokes(article, partner), partnerTitles]
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
            ->pluck('title', 'book')
            ->map(fn ($t) => (string) $t);

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
        $partnerTitles = $external->only($keep)->all();

        return [$internalEdges, $spokes, $partnerTitles];
    }

    private function rootBook(string $book): string
    {
        return explode('/', $book, 2)[0];
    }

    // ── layout + drawing ─────────────────────────────────────────────────────

    /**
     * @param  array<string, string>  $articles  book => title
     * @param  array<int, array{0:string,1:string}>  $internalEdges
     * @param  array<int, array{0:string,1:string}>  $spokes
     * @param  array<string, string>  $external  book => title
     */
    private function draw(
        JournalSource $journal,
        string $mode,
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

        // Blob membership: connected first (they take the centre of the
        // spiral), then — mode 'all' only — the plain articles, title-sorted
        // for determinism. Capped; connected articles win the cut.
        $connected = array_keys($degree);
        usort($connected, fn ($x, $y) => [$degree[$y], $articles[$x] ?? ''] <=> [$degree[$x], $articles[$y] ?? '']);
        $blob = $connected;
        if ($mode === 'all') {
            $plain = array_diff(array_keys($articles), $connected);
            usort($plain, fn ($x, $y) => strcmp($articles[$x], $articles[$y]));
            $blob = array_merge($blob, $plain);
        }
        $blob = array_slice($blob, 0, self::MAX_BLOB_DOTS);
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

        return $this->emit($journal, $mode, $articles, $external, $pos, $inBlob, $degree, $internalEdges, $spokes, $blobRadius, $ringR);
    }

    private function emit(
        JournalSource $journal,
        string $mode,
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
        // Bounds: the ring (or blob) plus horizontal room for partner labels.
        $labelRoom = $external === [] ? 0 : (self::LABEL_CHARS * 5.5 + 10);
        $extent = ($external === [] ? $blobRadius : $ringR) + self::R_EXTERNAL + 14;
        $minX = -$extent - $labelRoom;
        $width = 2 * ($extent + $labelRoom);
        $minY = -$extent;
        $height = 2 * $extent;

        $s = [];
        $s[] = '<svg viewBox="' . $this->n($minX) . ' ' . $this->n($minY) . ' ' . $this->n($width) . ' ' . $this->n($height) . '"'
            . ' role="img" aria-label="Hypercite map of ' . e($journal->display_name) . '"'
            . ' style="display:block;width:100%;max-width:640px;height:auto;margin:0 auto">';

        // Edges first, under the dots. Internal pairs bow toward the blob
        // centre; spokes bow gently outward on their way to the ring.
        foreach ($internalEdges as [$a, $b]) {
            if (!isset($pos[$a], $pos[$b])) {
                continue;
            }
            $s[] = $this->curve($pos[$a], $pos[$b], 0.62, self::INK, 0.6, 1.5);
        }
        foreach ($spokes as [$a, $b]) {
            if (!isset($pos[$a], $pos[$b])) {
                continue;
            }
            $s[] = $this->curve($pos[$a], $pos[$b], 1.12, self::AQUA, 0.8, 1.3);
        }

        // Blob dots: hypercited articles in brand pink, sized by degree;
        // plain articles (mode 'all') faint ink.
        foreach ($inBlob as $book => $_) {
            [$x, $y] = $pos[$book];
            $deg = $degree[$book] ?? 0;
            $lit = $deg > 0;
            $r = $lit ? min(self::R_LIT + 0.8 * ($deg - 1), 9) : self::R_PLAIN;
            $fill = self::INK;
            $opacity = $lit ? '1' : '0.5';
            $s[] = '<a href="/' . e(rawurlencode($book)) . '" tabindex="-1">'
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n($r) . '"'
                . ' fill="' . $fill . '" fill-opacity="' . $opacity . '"><title>' . e($articles[$book] ?? $book) . '</title></circle></a>';
        }

        // External partners: aqua dots with short labels on the outward side.
        foreach ($external as $book => $title) {
            if (!isset($pos[$book])) {
                continue;
            }
            [$x, $y] = $pos[$book];
            $short = mb_strlen($title) > self::LABEL_CHARS
                ? mb_substr($title, 0, self::LABEL_CHARS - 1) . '…'
                : $title;
            $onLeft = $x < 0;
            $s[] = '<a href="/' . e(rawurlencode($book)) . '" tabindex="-1">'
                . '<circle cx="' . $this->n($x) . '" cy="' . $this->n($y) . '" r="' . $this->n(self::R_EXTERNAL) . '"'
                . ' fill="' . self::AQUA . '" stroke="' . self::INK . '" stroke-opacity="0.5" stroke-width="1"><title>' . e($title) . '</title></circle>'
                . '<text x="' . $this->n($x + ($onLeft ? -1 : 1) * (self::R_EXTERNAL + 5)) . '" y="' . $this->n($y + 3) . '"'
                . ' text-anchor="' . ($onLeft ? 'end' : 'start') . '" font-size="10" font-family="sans-serif"'
                . ' fill="' . self::INK . '" fill-opacity="0.9">' . e($short) . '</text></a>';
        }

        $s[] = '</svg>';

        return implode('', $s);
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
