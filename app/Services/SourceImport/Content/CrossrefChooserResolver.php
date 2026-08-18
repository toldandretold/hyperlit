<?php

namespace App\Services\SourceImport\Content;

/**
 * Crossref "multiple resolution" chooser pages — follow them, don't reject them.
 *
 * The HTML lane fetches `https://doi.org/<DOI>` and trusts doi.org to redirect
 * to the publisher. For DOIs whose publisher enables Crossref MULTIPLE
 * RESOLUTION, doi.org instead serves chooser.crossref.org — an interstitial
 * listing the locations that host the work. That page has zero prose, so both
 * fetch channels "succeed" and {@see BodyPresenceAssessor} rightly rejects the
 * import ("no article body — 0 prose paragraphs"). Ten fresh Bristol UP GSCJ
 * articles failed exactly this way in the 2026-08 harvest while their older
 * siblings (direct-redirect DOIs) imported fine — the difference is per-DOI
 * Crossref configuration, not the publisher's article pages.
 *
 * Unlike an {@see AccessWallDetector} interstitial, the chooser TELLS us where
 * the article lives: each location is a `<div class="resource-line">` whose
 * first anchor is the target. This resolver extracts that target so the fetch
 * ladder can follow it once; it is not a gate and never fails an import by
 * itself — an unparseable chooser simply returns null and the body gate keeps
 * doing its job.
 */
class CrossrefChooserResolver
{
    private const CHOOSER_HOST = 'chooser.crossref.org';

    /**
     * @param string $landedUrl the URL the page was actually served from
     *                          (post-redirect), used for the cheap host check
     * @param string $html      the served page
     *
     * @return string|null the first non-Crossref location the chooser lists
     *                     (Crossref orders the specific resource first), or
     *                     null when the page is not a chooser / lists nothing
     */
    public function target(string $landedUrl, string $html): ?string
    {
        if (!$this->isChooser($landedUrl, $html)) {
            return null;
        }

        if (!preg_match_all('#class="[^"]*resource-line[^"]*"[^>]*>.*?<a[^>]+href="([^"]+)"#is', $html, $m)) {
            return null;
        }

        foreach ($m[1] as $href) {
            $href = html_entity_decode($href, ENT_QUOTES | ENT_HTML5);
            $host = strtolower((string) (parse_url($href, PHP_URL_HOST) ?: ''));
            // Skip the chooser's own chrome: doi.org self-links and crossref.org
            // explainer/API links are listed alongside the real locations.
            if ($host === '' || $host === 'doi.org' || str_ends_with($host, 'crossref.org')) {
                continue;
            }

            return $href;
        }

        return null;
    }

    private function isChooser(string $landedUrl, string $html): bool
    {
        $host = strtolower((string) (parse_url($landedUrl, PHP_URL_HOST) ?: ''));
        if ($host === self::CHOOSER_HOST) {
            return true;
        }

        // Fallback for a lost redirect history (landedUrl still reads doi.org):
        // the chooser's own CSS class plus its explainer link. Requiring both
        // keeps an article ABOUT multiple resolution from matching.
        return stripos($html, 'resource-line') !== false
            && stripos($html, 'crossref.org/get-started/multiple-resolution') !== false;
    }
}
