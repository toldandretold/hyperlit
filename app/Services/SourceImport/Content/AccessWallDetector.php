<?php

namespace App\Services\SourceImport\Content;

use App\Services\Conversion\GarbageDetector;

/**
 * Deterministic detection of bot-wall / captcha interstitials — the pages a
 * publisher serves INSTEAD of the article when it thinks we're a robot.
 *
 * Why this exists (and why it is deliberately NOT an LLM call): the HTML lane
 * used to rely solely on LlmService::assessHtmlContent's `is_blocked` verdict,
 * which FAILS OPEN — an unavailable LLM returned "importing as-is". That is how
 * a JSTOR PerimeterX "Access Check" page became a published 7-node book titled
 * "Copyright and a Democratic Civil Society". A string match costs nothing,
 * never fails open, and runs before the paste engine is even spawned.
 *
 * SCOPE — this detects INTERSTITIALS ONLY (captcha / "are you a robot" /
 * challenge pages), never paywalls. A real article page routinely carries
 * "Access through your institution" / "Buy article PDF" chrome alongside the
 * full text (every Springer and Elsevier article page does), so treating
 * paywall wording as a block would reject genuine open-access articles. The
 * paywalled-LANDING-page case — publisher chrome + abstract + reference list
 * but no body — is not detectable by markers at all and is decided by
 * {@see BodyPresenceAssessor} instead. Two different failures, two detectors.
 *
 * RELATIONSHIP TO GarbageDetector: that class detects the same wall pages AFTER
 * they have been imported, from node text, for `library:flag-sweep`. This one
 * runs BEFORE the import, on raw HTML, so the book is never created — and it can
 * see vendor script identifiers (`_pxAppId`, `cf_chl_opt`) that never survive
 * into extracted text. The prose vocabulary is NOT duplicated: the title check
 * below delegates to GarbageDetector::isBlockPhrase.
 */
class AccessWallDetector
{
    /**
     * Marker => human-readable reason. Matched case-insensitively against the
     * raw HTML. Each marker must be something a genuine article page would
     * never contain; prefer vendor script/DOM identifiers over prose, since
     * prose ("unusual traffic") can legitimately appear in an article ABOUT
     * bot detection.
     */
    private const MARKERS = [
        // PerimeterX (JSTOR, Zillow, et al.) — the JSTOR "Access Check" case.
        '_pxAppId'                  => 'blocked by a PerimeterX bot check',
        'px-captcha'                => 'blocked by a PerimeterX bot check',
        '/captcha/captcha.js'       => 'blocked by a PerimeterX bot check',

        // Cloudflare challenge pages.
        'cf-browser-verification'   => 'blocked by a Cloudflare challenge',
        'cf_chl_opt'                => 'blocked by a Cloudflare challenge',
        '/cdn-cgi/challenge-platform' => 'blocked by a Cloudflare challenge',

        // Google reCAPTCHA / hCaptcha challenge harnesses.
        'g-recaptcha'               => 'blocked by a reCAPTCHA challenge',
        'recaptcha/api.js'          => 'blocked by a reCAPTCHA challenge',
        'hcaptcha.com/1/api.js'     => 'blocked by an hCaptcha challenge',

        // Imperva / Incapsula.
        '_Incapsula_Resource'       => 'blocked by an Imperva/Incapsula bot check',

        // Akamai bot manager interstitial.
        '/akam/13/'                 => 'blocked by an Akamai bot check',

        // AWS WAF Bot Control ("Human Verification" puzzle). Bristol UP serves this to proxy IPs
        // it distrusts, and it carries NONE of the markers above — so before this entry it fell
        // through to the body gate and was reported as "no article body / 0 prose", which reads
        // as a thin landing page and sent the diagnosis in exactly the wrong direction. The host
        // is the durable identifier: the visible prose is localised (the captured page carried
        // Arabic), and the token path segments are per-request.
        'awswaf.com'                => 'blocked by an AWS WAF bot check',
    ];

    /**
     * Above this much visible text, a block-phrase TITLE is not enough to condemn a page. A wall is
     * a few hundred characters; the smallest thing we would still call an article is far above
     * this. Matches GarbageDetector::MIN_TOTAL_CHARS so the two agree on "suspiciously empty".
     */
    private const INTERSTITIAL_TEXT_CEILING = 2000;

    public function __construct(private GarbageDetector $garbage)
    {
    }

    /**
     * @return string|null a human-readable reason, or null when the page shows
     *                     no interstitial signature.
     */
    public function detect(string $html): ?string
    {
        foreach (self::MARKERS as $marker => $reason) {
            if (stripos($html, $marker) !== false) {
                return $reason;
            }
        }

        // Prose wording ("Access Check", "Just a moment", "unusual traffic") is NOT duplicated
        // here — GarbageDetector::isBlockPhrase is the one vocabulary, already shared with
        // WebArticleVerifier and library:flag-sweep. It is deliberately loose (it also covers
        // "sign in to", "cookie consent", "search results"), so it is applied to the <title> only
        // and ONLY when the page is also suspiciously empty.
        //
        // Both halves are load-bearing. Section headings were always excluded because a genuine
        // article can be headed "Results for the primary endpoint" — but a TITLE can contain the
        // same words, and GSCJ's "Can organizational frameworks drive institutional change and
        // results for gender equality?" was thrown away on that basis while carrying 88,000
        // characters of the actual article. An interstitial is a few hundred characters of "prove
        // you are human"; a paper is tens of thousands. Requiring both closes the hole without
        // weakening the vocabulary for its other consumers.
        $title = $this->title($html);
        if ($title !== '' && $this->garbage->isBlockPhrase($title)
            && $this->visibleTextLength($html) < self::INTERSTITIAL_TEXT_CEILING) {
            return sprintf('the page served was an interstitial, not the article (title: "%s")', $title);
        }

        return null;
    }

    /**
     * Rough visible-text length: enough to tell "prove you are human" from a paper, and no more.
     * Deliberately not the body gate's job — that one measures PROSE BLOCKS on converted output
     * and runs later; this is a cheap pre-check on raw HTML that only has to avoid being absurd.
     */
    private function visibleTextLength(string $html): int
    {
        $stripped = preg_replace('#<(script|style)\b.*?</\1>#is', ' ', $html) ?? $html;

        return mb_strlen(trim(preg_replace('/\s+/', ' ', strip_tags($stripped)) ?? ''));
    }

    /** Collapsed, tag-stripped <title> text; '' when the page has none. */
    private function title(string $html): string
    {
        if (!preg_match('#<title[^>]*>(.*?)</title>#is', $html, $m)) {
            return '';
        }

        return trim(preg_replace('/\s+/', ' ', strip_tags($m[1])));
    }
}
