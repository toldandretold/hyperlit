<?php

namespace App\Services\SourceImport\Content;

/**
 * Is the ARTICLE BODY actually present in what we fetched?
 *
 * The failure this exists to stop: a publisher's paywalled LANDING page is
 * indistinguishable from the real article by every signal the authenticity
 * gate used to check. It carries the matching `citation_doi`, the matching
 * `citation_title`, a publisher-specific processor matches it, and it ships
 * the complete reference list (publishers expose references for SEO and
 * paywall only the body). ContentFetchService::assessArticleAuthenticity
 * therefore returned `verified` for a Springer landing page and promoted 276
 * nodes of nav chrome, cookie banners and buybox CSS to a canonical version of
 * "Availability of digital object identifiers in publications archived by
 * PubMed". Identity was never the problem — nothing measured the BODY.
 *
 * The discriminator is the count of genuine PROSE paragraphs, not total text
 * length. Measured over the real fixtures in tests/paste/fixtures/clipboard/
 * (11 full articles, 9 publishers) versus the captured landing page in
 * tests/paste/fixtures/walled/:
 *
 *   - real articles ...... 26-85 prose blocks, 44,089-82,157 prose chars
 *   - Springer landing ...  1 prose block,      1,943 prose chars
 *
 * Total length alone does NOT separate them (the landing page still totals
 * ~21k chars once its 50 references and ~7k of leaked CSS/JS are counted) —
 * which is exactly why both filters below matter more than the thresholds do.
 * The thresholds sit ~5x below the weakest real article on both axes.
 */
class BodyPresenceAssessor
{
    public const PRESENT = 'present';
    public const ABSENT  = 'absent';

    /** A body paragraph worth counting. Shorter blocks are captions/labels/nav. */
    private const PROSE_BLOCK_CHARS = 400;

    /** Blocks this long count toward the chars total (a lower bar than a "paragraph"). */
    private const PROSE_CHAR_FLOOR = 200;

    /**
     * Below BOTH of a profile's numbers, the body is absent.
     *
     * SCHOLARLY — journal articles, the harvester's lane. Weakest real fixture
     * is 26 blocks / 44,089 chars, so this sits ~5x below it.
     *
     * WEB — news / gov / blog sources (importWebSource). A legitimate 500-word
     * news piece is only ~3k chars across a handful of short paragraphs and
     * would fail the scholarly bar, so the web profile is much lower: it only
     * has to catch the "headline + standfirst + subscribe to continue" teaser,
     * which runs to one or two short blocks. Do NOT raise it to the scholarly
     * numbers — that rejects real short articles.
     */
    public const PROFILE_SCHOLARLY = 'scholarly';
    public const PROFILE_WEB       = 'web';

    private const PROFILES = [
        self::PROFILE_SCHOLARLY => ['blocks' => 5, 'chars' => 10000],
        self::PROFILE_WEB       => ['blocks' => 2, 'chars' => 1500],
    ];

    /**
     * The block walk and the two non-prose filters live in ProseBlockExtractor
     * so the citation resolver's main-content extraction reuses this exact
     * notion of "a body paragraph". The THRESHOLDS and the verdict stay here.
     */
    private ProseBlockExtractor $blocks;

    public function __construct(?ProseBlockExtractor $blocks = null)
    {
        $this->blocks = $blocks ?? new ProseBlockExtractor();
    }

    /**
     * Assess a body-HTML string (the paste engine's `html` output).
     *
     * @return array{verdict: string, prose_blocks: int, prose_chars: int, reason: ?string}
     */
    public function assess(string $html, string $profile = self::PROFILE_SCHOLARLY): array
    {
        // stripNonContent: FALSE deliberately. This path is fed the paste
        // engine's already-cleaned body HTML, and its calibration (26-85 prose
        // blocks for a real article) was measured with leaked <style>/<script>
        // text arriving as blocks and being dropped by isCodeLike.
        return $this->assessBlocks($this->blocks->leafBlocks($html), $profile);
    }

    /**
     * Assess pre-extracted block texts — the path used when re-measuring a book
     * that is ALREADY imported (harvest:audit-imports reads nodes.plainText
     * straight from Postgres, so a stored landing page can be caught without
     * re-fetching anything).
     *
     * @param iterable<string> $texts
     * @return array{verdict: string, prose_blocks: int, prose_chars: int, reason: ?string}
     */
    public function assessBlocks(iterable $texts, string $profile = self::PROFILE_SCHOLARLY): array
    {
        $limits = self::PROFILES[$profile] ?? self::PROFILES[self::PROFILE_SCHOLARLY];

        $proseBlocks = 0;
        $proseChars  = 0;

        foreach ($texts as $raw) {
            $text = $this->blocks->normalise((string) $raw);
            $len  = mb_strlen($text);

            if ($len < self::PROSE_CHAR_FLOOR || $this->blocks->isCodeLike($text) || $this->blocks->isReferenceLike($text)) {
                continue;
            }

            $proseChars += $len;
            if ($len >= self::PROSE_BLOCK_CHARS) {
                $proseBlocks++;
            }
        }

        $absent = $proseBlocks < $limits['blocks'] && $proseChars < $limits['chars'];

        return [
            'verdict'      => $absent ? self::ABSENT : self::PRESENT,
            'prose_blocks' => $proseBlocks,
            'prose_chars'  => $proseChars,
            'reason'       => $absent
                ? "no article body — only {$proseBlocks} prose paragraph(s) / {$proseChars} chars "
                    . '(publisher landing page or abstract only, not the full text)'
                : null,
        ];
    }

}
