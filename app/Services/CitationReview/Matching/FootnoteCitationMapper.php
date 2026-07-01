<?php

namespace App\Services\CitationReview\Matching;

use App\Services\CitationReview\Support\AuthorName;
use Illuminate\Support\Facades\DB;

/**
 * Maps footnoteId → [refId, ...] for a book's footnotes, so footnote-based
 * citations resolve to bibliography entries. Two detection methods: inline
 * <a href="#refId"> links in the footnote HTML, and author-last-name + year
 * text matching against bibliography metadata (disambiguated by title overlap).
 *
 * Extracted verbatim from CitationReviewService::buildFootnoteCitationMap /
 * ::matchFootnoteTextToBibliography.
 */
final class FootnoteCitationMapper
{
    public function __construct(private AuthorName $authorName) {}

    /**
     * Pre-build a map of footnoteId → [refId, ...] for all footnotes in the book.
     */
    public function buildMap(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        // Load bibliography referenceIds for link validation
        $bibRefIdSet = $db->table('bibliography')
            ->where('book', $bookId)
            ->pluck('referenceId')
            ->flip()
            ->toArray();

        // Footnote-only: each citation-classified footnote maps to itself
        if (empty($bibRefIdSet)) {
            $fnCitations = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('is_citation', true)
                ->pluck('footnoteId');
            $map = [];
            foreach ($fnCitations as $fnId) {
                $map[$fnId] = [$fnId];
            }
            return $map;
        }

        $footnotes = $db->table('footnotes')
            ->where('book', $bookId)
            ->select(['footnoteId', 'preview_nodes', 'content'])
            ->get();

        if ($footnotes->isEmpty()) {
            return [];
        }

        // Load bibliography entries with llm_metadata for author+year matching
        $bibMetadata = [];
        $bibEntries = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereNotNull('llm_metadata')
            ->select(['referenceId', 'llm_metadata'])
            ->get();

        foreach ($bibEntries as $entry) {
            $meta = is_string($entry->llm_metadata) ? json_decode($entry->llm_metadata, true) : null;
            if ($meta) {
                $bibMetadata[$entry->referenceId] = $meta;
            }
        }

        $footnoteMap = [];

        foreach ($footnotes as $fn) {
            $refIds = [];

            // Extract HTML and plaintext from preview_nodes or fallback to content
            $html = '';
            $plaintext = '';

            $previewNodes = is_string($fn->preview_nodes)
                ? json_decode($fn->preview_nodes, true)
                : (is_array($fn->preview_nodes) ? $fn->preview_nodes : null);

            if (!empty($previewNodes) && is_array($previewNodes)) {
                foreach ($previewNodes as $node) {
                    $nodeContent = $node['content'] ?? '';
                    $html .= ' ' . $nodeContent;
                    $plaintext .= ' ' . ($node['plainText'] ?? strip_tags($nodeContent));
                }
            } elseif (!empty($fn->content)) {
                $html = $fn->content;
                $plaintext = strip_tags($fn->content);
            }

            $html = trim($html);
            $plaintext = trim($plaintext);

            if (empty($html) && empty($plaintext)) {
                continue;
            }

            // Method 1: Scan HTML for <a href="#refId"> tags
            if (preg_match_all('/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is', $html, $linkMatches)) {
                foreach ($linkMatches[1] as $refId) {
                    if (isset($bibRefIdSet[$refId])) {
                        $refIds[$refId] = true;
                    }
                }
            }

            // Method 2: Author+year text matching against bibliography metadata
            if (!empty($plaintext) && !empty($bibMetadata)) {
                $textMatches = $this->matchFootnoteTextToBibliography($plaintext, $bibMetadata);
                foreach ($textMatches as $refId) {
                    $refIds[$refId] = true;
                }
            }

            if (!empty($refIds)) {
                $footnoteMap[$fn->footnoteId] = array_keys($refIds);
            }
        }

        return $footnoteMap;
    }

    /**
     * Match footnote plaintext against bibliography entries using author last name + year.
     * Returns array of matched referenceIds.
     */
    private function matchFootnoteTextToBibliography(string $text, array $bibMetadata): array
    {
        $textLower = mb_strtolower($text);
        $matches = [];

        foreach ($bibMetadata as $refId => $meta) {
            $year = (string) ($meta['year'] ?? '');
            $authors = $meta['authors'] ?? [];

            if (empty($year) || empty($authors)) {
                continue;
            }

            // Check if year appears in text
            if (mb_strpos($textLower, $year) === false) {
                continue;
            }

            // Extract last names and check if any appear in text
            if (!is_array($authors)) {
                $authors = [$authors];
            }

            $hasAuthorMatch = false;
            foreach ($authors as $author) {
                $lastName = $this->authorName->lastName((string) $author);
                if ($lastName && mb_strpos($textLower, mb_strtolower($lastName)) !== false) {
                    $hasAuthorMatch = true;
                    break;
                }
            }

            if ($hasAuthorMatch) {
                $matches[$refId] = $meta;
            }
        }

        if (count($matches) <= 1) {
            return array_keys($matches);
        }

        // Multiple matches — score by title keyword overlap to disambiguate
        $textWords = preg_split('/[^\p{L}\p{N}]+/u', $textLower);
        $textWords = array_filter($textWords, fn($w) => mb_strlen($w) > 3);
        $textWords = array_values($textWords);

        $scores = [];
        foreach ($matches as $refId => $meta) {
            $title = mb_strtolower($meta['title'] ?? '');
            $titleWords = preg_split('/[^\p{L}\p{N}]+/u', $title);
            $titleWords = array_filter($titleWords, fn($w) => mb_strlen($w) > 3);
            $scores[$refId] = count(array_intersect($titleWords, $textWords));
        }

        arsort($scores);
        $topScore = reset($scores);

        // Return all entries with the top score (handles ties)
        if ($topScore > 0) {
            return array_keys(array_filter($scores, fn($s) => $s === $topScore));
        }

        // No title overlap distinguishes them — return all
        return array_keys($matches);
    }
}
