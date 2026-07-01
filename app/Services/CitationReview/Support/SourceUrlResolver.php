<?php

namespace App\Services\CitationReview\Support;

/**
 * Resolve the best external URL for a source and make URLs markdown-safe.
 * Cross-group leaf: used by both the report builders (Report\*) and the
 * highlight phase (SourceHtmlBuilder). Extracted verbatim from
 * CitationReviewService::resolveSourceUrl / ::mdSafeUrl.
 */
final class SourceUrlResolver
{
    /**
     * Resolve the best external URL for a source (DOI > OA URL > URL).
     */
    public function resolve(array $claim): ?string
    {
        if (!empty($claim['source_doi'])) {
            return 'https://doi.org/' . $claim['source_doi'];
        }
        if (!empty($claim['source_oa_url'])) {
            return $claim['source_oa_url'];
        }
        if (!empty($claim['source_url'])) {
            return $claim['source_url'];
        }
        return null;
    }

    /**
     * Make a URL safe for embedding in a markdown link destination: the md→HTML
     * converter treats _x_ inside URLs as emphasis, mangling DOIs like
     * 10.1162/qss_a_00195 into qss<em>a</em>00195. %5F resolves identically.
     */
    public function mdSafe(string $url): string
    {
        return str_replace('_', '%5F', $url);
    }
}
