<?php

namespace App\Services\CitationReview\Support;

/**
 * Build source HTML for highlight sub-book nodes.
 * Returns ['content' => ..., 'plainText' => ...] for a <p> node.
 * Extracted verbatim from CitationReviewService::buildSourceHtml.
 */
final class SourceHtmlBuilder
{
    public function __construct(private SourceUrlResolver $urls) {}

    public function build(array $claim): ?array
    {
        $sourceInfo = array_filter([
            $claim['source_title'] ?? null,
            $claim['source_author'] ?? null,
            isset($claim['source_year']) ? "({$claim['source_year']})" : null,
        ]);

        if (empty($sourceInfo)) {
            return null;
        }

        $externalUrl = $this->urls->resolve($claim);
        $title = $claim['source_title'] ?? '';
        $otherParts = array_filter([
            $claim['source_author'] ?? null,
            isset($claim['source_year']) ? "({$claim['source_year']})" : null,
        ]);

        // The source line links IN-APP ONLY (the reviewed version carrying the
        // highlights). No external link here — the bibliography citation line
        // below already carries the URL/DOI.
        $inAppUrl = (!empty($claim['has_source_content']) && !empty($claim['source_book_id']))
            ? '/' . $claim['source_book_id'] : null;

        if ($inAppUrl && $title) {
            $linkedTitle = '<a href="' . e($inAppUrl) . '">' . e($title) . '</a>';
        } else {
            $linkedTitle = e($title ?: implode(' — ', $sourceInfo));
        }

        $parts = $linkedTitle;
        if ($title && !empty($otherParts)) {
            $parts .= ' — ' . e(implode(' — ', $otherParts));
        }

        if ($inAppUrl && !$title) {
            $parts .= ' <a href="' . e($inAppUrl) . '">→</a>';
        }

        $plainText = 'Source: ' . implode(' — ', $sourceInfo);

        if (($claim['verification_tier'] ?? null) === 'canonical') {
            $parts .= ' <em>✓ canonical-verified</em>';
            $plainText .= ' (canonical-verified)';
        }

        return [
            'content'   => '<p><strong>Source:</strong> ' . $parts . '</p>',
            'plainText' => $plainText,
        ];
    }
}
