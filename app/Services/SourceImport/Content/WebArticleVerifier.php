<?php

namespace App\Services\SourceImport\Content;

/**
 * Verifies that a fetched web page IS the cited non-academic article.
 *
 * Non-academic sources (news, gov, blogs) have no DOI / academic-database
 * identity, so the strongest honest claim is: "the cited metadata matches the
 * live page at the cited URL." This does that deterministically, using the
 * structured metadata publishers emit for Google News / SEO — the web analog
 * of JATS/Highwire:
 *
 *   1. JSON-LD schema.org (@type in the Article hierarchy) → headline / author
 *      / datePublished. Publisher-DECLARED, strongest.
 *   2. OpenGraph (og:type=article, og:title, article:published_time/author).
 *   3. Plain <title> / og:title as a last resort.
 *
 * Verdict:
 *   verified   — page declares itself an article AND its title matches the
 *                citation (similarity ≥ 0.8). Honest tier: URL-content match.
 *   unverified — got a page but no article self-declaration / weak title match.
 *   reject     — page declares an article whose title strongly CONTRADICTS the
 *                citation (similarity < 0.3): wrong page / redirect / listing.
 *
 * NB: a 'verified' web source is NEVER canonical — there is no academic work
 * identity. Callers must keep it out of AutoVersionResolver::SYSTEM_CONVERSION_METHODS.
 */
class WebArticleVerifier
{
    public const VERIFIED = 'web_verified';
    public const UNVERIFIED = 'web_unverified';
    public const REJECT = 'reject';

    private const MATCH_FLOOR = 0.8;
    private const CONTRADICT_CEIL = 0.3;

    /**
     * @return array{verdict:string, matched_on:?string, page_title:?string, score:float, is_article:bool, note:?string}
     */
    public function assess(string $html, string $citationTitle, ?int $citationYear = null): array
    {
        $meta = $this->extractMeta($html);
        $pageTitle = $meta['title'];
        $isArticle = $meta['is_article'];

        $jaccard = ($pageTitle && $citationTitle)
            ? $this->titleSimilarity($citationTitle, $pageTitle)
            : 0.0;
        // Overlap coefficient rescues subset titles (a stub title padded with
        // site/author junk around the real headline scores low on Jaccard but
        // high on containment) — a contradiction claim must fail BOTH.
        $overlap = ($pageTitle && $citationTitle)
            ? $this->titleOverlap($citationTitle, $pageTitle)
            : 0.0;

        // REJECT means "we are confident the page hosts a DIFFERENT article".
        // That confidence requires more than declared-article + low score:
        //   - the page must not be a block/error shell (paywalls, consent walls
        //     and soft-404s often still emit og:type=article with a junk title —
        //     there we never SAW the article, so we cannot claim contradiction);
        //   - the citation title must be meaningful (a truncated/garbage stub
        //     title scoring low is "garbage in", not "different article");
        //   - both similarity measures must contradict.
        $blockPage = $pageTitle && $this->looksLikeBlockPage($pageTitle);
        $citTokens = $this->tokenize($citationTitle);
        $pageTokens = $pageTitle ? $this->tokenize($pageTitle) : [];
        $citationMeaningful = count($citTokens) >= 3;
        $shared = count(array_intersect($citTokens, $pageTokens));
        // Length ratio guards containment: a 4-token page title swallowed by a
        // 16-token citation is NOT the same work — containment only counts when
        // the two titles are of comparable size.
        $ratio = (count($citTokens) && count($pageTokens))
            ? min(count($citTokens), count($pageTokens)) / max(count($citTokens), count($pageTokens))
            : 0.0;
        // og:title / JSON-LD headline = the PUBLISHER declared this title for
        // this URL. A strong match against it is direct evidence the page IS
        // the cited piece, whether or not the page also typed itself "article"
        // (gov/print/NGO pages routinely have og:title but no og:type — real
        // case: OCCRP/ANI/Interpol/PIB all failed verification on that alone).
        $declaredByPublisher = in_array($meta['source'], ['json-ld', 'opengraph'], true);

        $verified =
            // declared-article + strong overall match (original rule)
            ($isArticle && $jaccard >= self::MATCH_FLOOR)
            // declared-article + page headline contained in the citation (or
            // vice versa) with comparable lengths — subset-title wording
            || ($isArticle && $overlap >= 0.85 && $shared >= 3 && $ratio >= 0.5)
            // publisher-declared title that (near-)exactly equals the citation
            || ($declaredByPublisher && $jaccard >= 0.95)
            // publisher-declared title fully contained, comparable lengths
            || ($declaredByPublisher && $overlap >= 0.99 && $shared >= 4 && $ratio >= 0.5)
            // bare <title> only counts when (near-)exact AND long enough that
            // coincidence is implausible (e.g. PIB print pages)
            || ($meta['source'] === 'title' && $jaccard >= 0.95 && count($citTokens) >= 5);

        $note = null;
        if (!$blockPage && $pageTitle && $verified) {
            $verdict = self::VERIFIED;
        } elseif ($isArticle && $pageTitle
            && max($jaccard, $overlap) < self::CONTRADICT_CEIL
            && !$blockPage && $citationMeaningful) {
            $verdict = self::REJECT;
        } else {
            $verdict = self::UNVERIFIED;
            if ($blockPage) {
                $note = 'block_page';            // never saw the article — cannot judge
            } elseif (!$citationMeaningful) {
                $note = 'citation_title_junk';   // nothing reliable to match against
            }
        }

        return [
            'verdict'    => $verdict,
            'matched_on' => $meta['source'],
            'page_title' => $pageTitle,
            'score'      => round($jaccard, 3),
            'is_article' => $isArticle,
            'note'       => $note,
        ];
    }

    /**
     * Does the page title look like a block/error shell rather than content?
     * Matched against the TITLE only (conservative) — these pages often still
     * carry article-typed metadata from the site template. The phrase list
     * itself lives in GarbageDetector (shared with library:flag-sweep).
     */
    private function looksLikeBlockPage(string $title): bool
    {
        return app(\App\Services\Conversion\GarbageDetector::class)->isBlockPhrase($title);
    }

    /**
     * Pull the article's self-declared metadata. JSON-LD first (richest), then
     * OpenGraph, then bare <title>.
     *
     * @return array{title:?string, published:?string, author:?string, is_article:bool, source:?string}
     */
    public function extractMeta(string $html): array
    {
        // 1. JSON-LD schema.org
        if (preg_match_all('#<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>#is', $html, $m)) {
            foreach ($m[1] as $block) {
                $node = $this->findArticleNode(json_decode(trim($block), true));
                if ($node) {
                    return [
                        'title'      => $this->str($node['headline'] ?? $node['name'] ?? null),
                        'published'  => $this->str($node['datePublished'] ?? null),
                        'author'     => $this->authorName($node['author'] ?? null),
                        'is_article' => true,
                        'source'     => 'json-ld',
                    ];
                }
            }
        }

        // 2. OpenGraph
        $ogType = $this->metaContent($html, 'og:type', true);
        $ogTitle = $this->metaContent($html, 'og:title', true);
        if ($ogTitle) {
            return [
                'title'      => $ogTitle,
                'published'  => $this->metaContent($html, 'article:published_time', true),
                'author'     => $this->metaContent($html, 'article:author', true),
                'is_article' => ($ogType !== null && stripos($ogType, 'article') !== false),
                'source'     => 'opengraph',
            ];
        }

        // 3. Bare <title> — present but not self-declared as an article
        if (preg_match('#<title[^>]*>(.*?)</title>#is', $html, $t)) {
            return [
                'title'      => $this->str(html_entity_decode($t[1], ENT_QUOTES | ENT_HTML5, 'UTF-8')),
                'published'  => null, 'author' => null,
                'is_article' => false, 'source' => 'title',
            ];
        }

        return ['title' => null, 'published' => null, 'author' => null, 'is_article' => false, 'source' => null];
    }

    /**
     * Find a JSON-LD node in the Article hierarchy (NewsArticle,
     * ReportageNewsArticle, Article, Report, BlogPosting, …), walking lists and
     * @graph. Returns the node dict or null.
     */
    private function findArticleNode($data): ?array
    {
        if (!is_array($data)) {
            return null;
        }
        // A list of nodes
        if (array_is_list($data)) {
            foreach ($data as $item) {
                if ($node = $this->findArticleNode($item)) {
                    return $node;
                }
            }
            return null;
        }
        if (!empty($data['@graph'])) {
            if ($node = $this->findArticleNode($data['@graph'])) {
                return $node;
            }
        }
        $type = $data['@type'] ?? null;
        $types = is_array($type) ? $type : [$type];
        foreach ($types as $t) {
            if (is_string($t) && (str_ends_with($t, 'Article') || in_array($t, ['Report', 'BlogPosting', 'WebPage'], true))) {
                // WebPage only counts if it actually carries a headline/name.
                if ($t === 'WebPage' && empty($data['headline']) && empty($data['name'])) {
                    continue;
                }
                return $data;
            }
        }
        return null;
    }

    private function authorName($author): ?string
    {
        if (is_string($author)) return $this->str($author);
        if (is_array($author)) {
            if (isset($author['name'])) return $this->str($author['name']);
            if (array_is_list($author) && isset($author[0])) return $this->authorName($author[0]);
        }
        return null;
    }

    private function metaContent(string $html, string $property, bool $byProperty): ?string
    {
        $attr = $byProperty ? '(?:property|name)' : 'name';
        // content before or after the property attr
        if (preg_match('#<meta[^>]*' . $attr . '=["\']' . preg_quote($property, '#') . '["\'][^>]*content=["\'](.*?)["\']#is', $html, $m)
            || preg_match('#<meta[^>]*content=["\'](.*?)["\'][^>]*' . $attr . '=["\']' . preg_quote($property, '#') . '["\']#is', $html, $m)) {
            return $this->str(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        }
        return null;
    }

    /** Lowercased, punctuation-stripped, stopword-free, deduped tokens. */
    private function tokenize(string $s): array
    {
        $s = mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $s));
        $stop = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as'];
        // Dedupe — array_intersect keeps duplicate entries from the first
        // array, which can push intersection above union (score > 1).
        return array_values(array_unique(array_diff(array_filter(preg_split('/\s+/', $s)), $stop)));
    }

    /** Jaccard title similarity, 0–1. Standalone (no deps). */
    private function titleSimilarity(string $a, string $b): float
    {
        $wa = $this->tokenize($a);
        $wb = $this->tokenize($b);
        if (!$wa || !$wb) return 0.0;
        $inter = count(array_intersect($wa, $wb));
        $union = count(array_unique(array_merge($wa, $wb)));
        return $union > 0 ? $inter / $union : 0.0;
    }

    /** Overlap coefficient (intersection / smaller set), 0–1 — containment. */
    private function titleOverlap(string $a, string $b): float
    {
        $wa = $this->tokenize($a);
        $wb = $this->tokenize($b);
        if (!$wa || !$wb) return 0.0;
        return count(array_intersect($wa, $wb)) / min(count($wa), count($wb));
    }

    private function str($v): ?string
    {
        if (!is_string($v)) return null;
        $v = trim(preg_replace('/\s+/', ' ', $v));
        return $v === '' ? null : $v;
    }
}
