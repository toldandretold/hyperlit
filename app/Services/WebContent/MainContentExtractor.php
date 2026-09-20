<?php

namespace App\Services\WebContent;

use App\Services\SourceImport\Content\ProseBlockExtractor;

/**
 * Pull the ARTICLE out of a raw web page and leave the furniture behind.
 *
 * The failure this exists to stop: citation resolution used to reduce a fetched
 * page with a regex strip of seven tags followed by strip_tags(), which keeps
 * every nav list, cookie banner, ad slot and "related articles" rail that
 * wasn't inside a literal <nav>. Measured on a real unresolved chacko citation
 * (scroll.in/latest/1050748), that produced 17,820 chars whose FIRST 1,500 were
 * the site's trending-headlines rail — and the first 1,500 chars are exactly
 * what LlmService::validateWebContent is shown when asked "is this the cited
 * article?". The honest answer was no, so a real article was thrown away. When
 * a page did squeak past, that same rail stayed in the body the passage search
 * then searched, so the reviewer could be shown an unrelated headline as
 * "PASSAGES FROM SOURCE TEXT".
 *
 * The discriminator is the same one BodyPresenceAssessor already calibrates on:
 * a genuine body paragraph runs to hundreds of characters, while nav items,
 * rail headlines, captions, bylines and buttons are short. Keeping only leaf
 * blocks at or above PROSE_CHAR_FLOOR turns that scroll.in page into 37 blocks
 * / 9,821 chars beginning at the article's first sentence.
 *
 * Deliberately NOT the paste engine. scripts/paste-convert.mjs is the
 * PUBLISHER-page answer — it has real processors for sage/cambridge/t&f and
 * WebTextAcquirer uses it when the detector claims one of those. Fed a general
 * news page it falls back to `general`, which does no main-content extraction
 * at all (verified: the same scroll.in page came back 29,095 chars, still
 * nav-first). Readability is the missing piece, not conversion.
 *
 * Deliberately NOT a new dependency either. Every filter here is
 * ProseBlockExtractor's, already calibrated against 11 real articles and a
 * captured paywalled landing page.
 */
class MainContentExtractor
{
    /**
     * Blocks at or above this length are body prose; below it they are
     * furniture. Same floor BodyPresenceAssessor counts chars at — kept
     * identical on purpose so "extracted" and "assessed" agree about what a
     * paragraph is.
     */
    public const PROSE_CHAR_FLOOR = 200;

    /**
     * A page whose longest block is under the floor gets a second, lower pass.
     * Short-paragraph pages are real (wire copy, gov notices, press releases
     * run to 80-150 char paragraphs), so rather than returning nothing we
     * retry at this floor and let the caller's grade say the extract is thin.
     */
    private const SHORT_FORM_FLOOR = 80;

    /**
     * Below this many surviving chars the salvage pass isn't worth reporting as
     * an extract — it is a JS shell or an interstitial, and saying so is more
     * useful than handing back a title and a copyright line.
     */
    private const SALVAGE_MIN_CHARS = 200;

    public function __construct(private ProseBlockExtractor $blocks) {}

    /**
     * @return array{text: string, blocks: list<string>, chars: int, floor: int, considered: int}
     *         `text` is blocks joined by BLANK LINES — not spaces. The old
     *         extraction collapsed all whitespace to single spaces, which
     *         destroyed paragraph boundaries before WebFetchService::chunkText
     *         ran, so its preg_split('/\n\n+/') could never fire and every web
     *         stub was chunked blind at 500 chars mid-sentence. Keeping the
     *         blank lines restores paragraph-aligned chunking for free.
     */
    public function extract(string $html): array
    {
        $raw = $this->blocks->leafBlocks($html, stripNonContent: true);

        $normalised = [];
        foreach ($raw as $block) {
            $text = $this->blocks->normalise($block);
            if ($text === '' || $this->blocks->isCodeLike($text) || $this->blocks->isReferenceLike($text)) {
                continue;
            }
            $normalised[] = $text;
        }

        $kept = $this->keepAtLeast($normalised, self::PROSE_CHAR_FLOOR);
        $floor = self::PROSE_CHAR_FLOOR;

        if ($kept === []) {
            $salvage = $this->keepAtLeast($normalised, self::SHORT_FORM_FLOOR);
            if ($this->charsOf($salvage) >= self::SALVAGE_MIN_CHARS) {
                $kept  = $salvage;
                $floor = self::SHORT_FORM_FLOOR;
            }
        }

        return [
            'text'       => implode("\n\n", $kept),
            'blocks'     => $kept,
            'chars'      => $this->charsOf($kept),
            'floor'      => $floor,
            'considered' => count($normalised),
        ];
    }

    /**
     * @param  list<string>  $blocks
     * @return list<string>
     */
    private function keepAtLeast(array $blocks, int $floor): array
    {
        return array_values(array_filter($blocks, fn ($b) => mb_strlen($b) >= $floor));
    }

    /** @param list<string> $blocks */
    private function charsOf(array $blocks): int
    {
        $total = 0;
        foreach ($blocks as $b) {
            $total += mb_strlen($b);
        }

        return $total;
    }
}
