<?php

namespace App\Services\Conversion;

use Illuminate\Support\Collection;

/**
 * Heuristics for "this book's content is conversion garbage" — CAPTCHA/block
 * pages saved as the whole text (the JSTOR 'Access Check' book), nav-menu
 * scrapes, near-empty conversions, OCR noise. Consumed by
 * `library:flag-sweep` (whole-corpus sweep → conversion_flags rows) and
 * shared with WebArticleVerifier (whose block-page title check delegates to
 * the same phrase list — one vocabulary, two call sites).
 *
 * assessBook() is deliberately conservative: every signal names itself so
 * the queue shows WHY a book was flagged, and the sweep runs with --dry-run
 * first. Thresholds are constants — tune them against real prod flags.
 */
class GarbageDetector
{
    /**
     * "This page is GONE" — as distinct from "we were refused".
     *
     * Kept separate from the wall phrases below because the two lead to
     * opposite conclusions about a citation: a dead link is evidence the
     * reference rotted, while a bot wall says nothing at all about the source,
     * which may be perfectly genuine. AccessWallDetector deliberately does NOT
     * fire on these (it would report a rotted URL as "blocked"), while the
     * combined BLOCK_PHRASES below still covers both, because for harvest's
     * garbage detection either one means "not a book".
     *
     * Soft 404s phrase it in prose rather than as a code, so they slip past
     * "page not found" and "\b404\b" — a justice.gov press-release URL returned
     * HTTP 200 with "the page you’re looking for can’t be found" and was graded
     * as real source text. Two things spelled out rather than approximated: the
     * apostrophe may be the curly U+2019 (a character class cannot express it
     * here — this pattern is matched without /u, so a 3-byte codepoint inside
     * [..] matches only ONE of its bytes), and the connecting words are
     * ENUMERATED rather than a loose `.{0,40}` gap, which false-positived on
     * ordinary prose ("…the page turned on land reform and could not be found
     * wanting").
     */
    private const NOT_FOUND_PHRASES =
        'page not found|\b404\b|'
        . '(page|article|document|content) '
        . '(you are looking for |you\'re looking for |you’re looking for |you requested |)'
        . '(can not be found|cannot be found|cant be found|can\'t be found|can’t be found'
        . '|could not be found|is no longer available|no longer exists)';

    /**
     * Refusal / interstitial phrases: we reached something, and it would not
     * show us the content.
     */
    private const WALL_PHRASES =
        'just a moment|attention required|access denied|are you a robot|robot check|captcha|'
        . '\b403\b|server error|subscribe to (read|continue)|'
        . 'sign in to|log ?in required|cookie consent|before you continue|'
        . 'search results|results for|'
        . 'access check|unusual traffic|verify (that )?you are (human|not a robot)|'
        . 'enable javascript and cookies|checking your browser';

    /**
     * Block/error-shell phrases. Superset of the old
     * WebArticleVerifier::looksLikeBlockPage list + the wordings found in
     * actual prod garbage books (JSTOR access check, Cloudflare).
     */
    private const BLOCK_PHRASES = self::NOT_FOUND_PHRASES . '|' . self::WALL_PHRASES;

    private const MIN_NODES = 5;
    private const MIN_TOTAL_CHARS = 2000;
    private const BLOCK_SCAN_NODES = 10;   // block phrases only count near the top
    private const MAX_EMPTY_RATIO = 0.5;
    private const MIN_ALPHA_RATIO = 0.6;   // below this the text reads as OCR noise
    private const MAX_DUPLICATE_RATIO = 0.3;

    /** Does a page/book TITLE look like a block/error shell? (WebArticleVerifier seam.) */
    public function isBlockPhrase(string $text): bool
    {
        return (bool) preg_match('/' . self::BLOCK_PHRASES . '/i', $text);
    }

    /**
     * Specifically "this page is gone" — a DEAD link, not a refusal. Callers
     * that have to tell a rotted citation URL from a bot-walled live source
     * (WebTextAcquirer, AccessWallDetector) need this narrower question.
     */
    public function isNotFoundPhrase(string $text): bool
    {
        return (bool) preg_match('/' . self::NOT_FOUND_PHRASES . '/i', $text);
    }

    /** A refusal or interstitial, excluding not-found wordings. */
    public function isWallPhrase(string $text): bool
    {
        return (bool) preg_match('/' . self::WALL_PHRASES . '/i', $text);
    }

    /**
     * Assess a book's nodes (objects/arrays with a plainText field, in reading
     * order). Returns ['flagged' => bool, 'signals' => string[]] — signals name
     * every heuristic that fired; any signal flags the book.
     */
    public function assessBook(Collection $nodes): array
    {
        $texts = $nodes->map(
            fn ($n) => trim((string) (is_array($n) ? ($n['plainText'] ?? '') : ($n->plainText ?? '')))
        )->values();

        $signals = [];
        $count = $texts->count();
        $total = $texts->sum(fn ($t) => mb_strlen($t));

        if ($count < self::MIN_NODES) {
            $signals[] = "node_count:{$count}";
        }
        if ($total < self::MIN_TOTAL_CHARS) {
            $signals[] = "total_chars:{$total}";
        }

        // A block phrase near the top of the document = the fetch saved a wall,
        // not the work. (Deep in a real text, these words can occur naturally.)
        $head = $texts->take(self::BLOCK_SCAN_NODES)->implode("\n");
        if ($head !== '' && $this->isBlockPhrase($head)) {
            $signals[] = 'block_page_phrase';
        }

        if ($count > 0) {
            $empty = $texts->filter(fn ($t) => $t === '')->count();
            if ($empty / $count > self::MAX_EMPTY_RATIO) {
                $signals[] = sprintf('empty_nodes:%.2f', $empty / $count);
            }

            $nonEmpty = $texts->filter(fn ($t) => $t !== '');
            if ($nonEmpty->count() > 0) {
                $joined = $nonEmpty->implode('');
                $letters = preg_match_all('/[\p{L}\s]/u', $joined);
                $alpha = mb_strlen($joined) > 0 ? $letters / mb_strlen($joined) : 1.0;
                if ($alpha < self::MIN_ALPHA_RATIO) {
                    $signals[] = sprintf('alpha_ratio:%.2f', $alpha);
                }

                $dupes = $nonEmpty->count() - $nonEmpty->unique()->count();
                if ($dupes / $nonEmpty->count() > self::MAX_DUPLICATE_RATIO) {
                    $signals[] = sprintf('duplicate_nodes:%.2f', $dupes / $nonEmpty->count());
                }
            }
        }

        return ['flagged' => $signals !== [], 'signals' => $signals];
    }
}
