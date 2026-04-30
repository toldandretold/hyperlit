<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

class CitationScanContentCommand extends Command
{
    protected $signature = 'citation:scan-content {bookId : The parent book ID to scan for in-text citations}';
    protected $description = 'Scan a book\'s nodes for in-text citations, resolve each against bibliography + library';

    public function handle(): int
    {
        $bookId = $this->argument('bookId');
        $db = DB::connection('pgsql_admin');

        // Validate book exists
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        $this->info("Book: {$book->title}");
        $this->newLine();

        // Phase 1 — Extract citations from nodes
        $this->info('Scanning nodes for in-text citations...');
        $citations = $this->extractCitations($db, $bookId);

        if (empty($citations)) {
            $this->warn('No in-text citations found in this book.');
            return 0;
        }

        $this->info("Found " . count($citations) . " unique citation(s).");
        $this->newLine();

        // Load match_method from the latest bibliography scan
        $matchMethods = $this->loadMatchMethods($db, $bookId);

        // Phase 2 — Resolve each unique referenceId
        $results = [];
        foreach ($citations as $refId => $info) {
            $results[] = $this->resolveReference($refId, $info, $db, $bookId, $matchMethods);
        }

        // Print summary
        $this->printSummary($results);

        // Write JSON report
        $timestamp = now()->format('Y-m-d_His');
        $jsonFilename = "citation-content_{$bookId}_{$timestamp}.json";
        Storage::put($jsonFilename, json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        $this->newLine();
        $this->info("JSON report: " . storage_path("app/{$jsonFilename}"));

        // Write markdown report
        $mdFilename = "citation-content_{$bookId}_{$timestamp}.md";
        $md = $this->buildMarkdownReport($results, $bookId);
        Storage::put($mdFilename, $md);
        $this->info("Markdown report: " . storage_path("app/{$mdFilename}"));

        return 0;
    }

    /**
     * Extract in-text citations from all nodes in the book.
     * Returns array keyed by referenceId with occurrence count and surrounding text.
     */
    private function extractCitations($db, string $bookId): array
    {
        $nodes = $db->table('nodes')
            ->where('book', $bookId)
            ->select(['node_id', 'content', 'plainText'])
            ->get();

        // Pre-load bibliography entries for self-reference detection
        $bibPlainTexts = $db->table('bibliography')
            ->where('book', $bookId)
            ->pluck('content', 'referenceId')
            ->map(fn($html) => trim(strip_tags($html)))
            ->toArray();

        // O(1) lookup set for bibliography referenceIds
        $bibRefIdSet = array_flip(array_keys($bibPlainTexts));

        // Footnote-only: when bibliography is empty, citation-classified footnotes are valid IDs
        $isFootnoteOnly = empty($bibRefIdSet);
        $fnRefIdSet = [];
        if ($isFootnoteOnly) {
            $fnRefIdSet = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('is_citation', true)
                ->pluck('footnoteId')
                ->flip()
                ->toArray();
        }

        // Pre-build footnote → refIds map for footnote-based citations
        $footnoteMap = $this->buildFootnoteCitationMap($db, $bookId, $bibRefIdSet);

        $citations = [];

        foreach ($nodes as $node) {
            $content = $node->content ?? '';

            // Fast-path: skip nodes that are tagged as bibliography content
            if (str_contains($content, 'data-static-content="bibliography"')) {
                continue;
            }

            // --- Inline <a href="#refId"> citations ---
            $inlineRefIds = [];
            $hasInlineLinks = preg_match_all(
                '/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is',
                $content,
                $matches
            );

            if ($hasInlineLinks) {
                $validIndices = [];
                foreach ($matches[1] as $i => $refId) {
                    if (isset($bibRefIdSet[$refId])) {
                        $validIndices[] = $i;
                    }
                }

                if (!empty($validIndices)) {
                    // Self-heal: add missing class="in-text-citation" to citation links
                    $healed = false;
                    foreach ($validIndices as $i) {
                        $fullTag = $matches[0][$i];
                        if (!str_contains($fullTag, 'in-text-citation')) {
                            $refId = $matches[1][$i];
                            $fixedTag = preg_replace(
                                '/<a\s([^>]*href="#' . preg_quote($refId, '/') . '")/i',
                                '<a class="in-text-citation" $1',
                                $fullTag
                            );
                            $content = str_replace($fullTag, $fixedTag, $content);
                            $healed = true;
                        }
                    }
                    if ($healed) {
                        $db->table('nodes')
                            ->where('book', $bookId)
                            ->where('node_id', $node->node_id)
                            ->update(['content' => $content]);
                        Log::info('Added missing in-text-citation class to citation links', [
                            'node_id' => $node->node_id,
                        ]);
                        // Re-match after healing so $matches reflects updated content
                        preg_match_all('/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is', $content, $matches);
                        $validIndices = [];
                        foreach ($matches[1] as $i => $refId) {
                            if (isset($bibRefIdSet[$refId])) {
                                $validIndices[] = $i;
                            }
                        }
                    }

                    // Check if this node IS a bibliography entry (self-reference)
                    $isBibEntry = false;
                    $validRefIds = array_map(fn($i) => $matches[1][$i], $validIndices);
                    $inlineRefIds = $validRefIds;
                    foreach ($validRefIds as $refId) {
                        if (isset($bibPlainTexts[$refId])) {
                            $nodeText = trim($node->plainText ?? '');
                            $bibText = $bibPlainTexts[$refId];
                            $prefixLen = min(60, strlen($bibText));
                            if ($prefixLen >= 30 && str_starts_with($nodeText, substr($bibText, 0, $prefixLen))) {
                                $isBibEntry = true;
                                break;
                            }
                        }
                    }

                    if ($isBibEntry) {
                        // Strip all citation <a> tags that reference bibliography entries, keep inner text
                        $cleanedContent = preg_replace_callback(
                            '/<a\s[^>]*href="#([^"]+)"[^>]*>(.*?)<\/a>/is',
                            function ($m) use ($bibRefIdSet) {
                                return isset($bibRefIdSet[$m[1]]) ? $m[2] : $m[0];
                            },
                            $content
                        );
                        if ($cleanedContent !== $content) {
                            $db->table('nodes')
                                ->where('book', $bookId)
                                ->where('node_id', $node->node_id)
                                ->update(['content' => $cleanedContent]);
                            Log::info('Stripped self-referencing citation from bibliography node', [
                                'node_id' => $node->node_id,
                                'refIds'  => $validRefIds,
                            ]);
                        }
                        continue; // skip this node entirely
                    }
                }
            }

            // --- Footnote-based citations via <sup> tags ---
            $footnoteRefIds = [];
            if (!empty($footnoteMap)) {
                if (preg_match_all('/<sup\b[^>]*\bfn-count-id="[^"]*"[^>]*>/i', $content, $supMatches)) {
                    foreach ($supMatches[0] as $supTag) {
                        if (preg_match('/\bid="([^"]+)"/', $supTag, $idMatch)) {
                            $footnoteId = $idMatch[1];
                            if (isset($footnoteMap[$footnoteId])) {
                                $footnoteRefIds = array_merge($footnoteRefIds, $footnoteMap[$footnoteId]);
                            }
                        }
                    }
                }
            }

            // Combine inline and footnote citations
            $allRefIds = array_unique(array_merge($inlineRefIds, $footnoteRefIds));

            if (empty($allRefIds)) {
                continue;
            }

            foreach ($allRefIds as $refId) {
                if (!isset($citations[$refId])) {
                    $citations[$refId] = [
                        'occurrences' => 0,
                        'surrounding_text' => null,
                    ];
                }

                $citations[$refId]['occurrences']++;

                // Capture surrounding text from the first occurrence only
                if ($citations[$refId]['surrounding_text'] === null) {
                    $citations[$refId]['surrounding_text'] = $this->extractSurroundingText(
                        $node->plainText ?? '',
                        $refId
                    );
                }
            }
        }

        return $citations;
    }

    /**
     * Get surrounding text context for a citation.
     */
    private function extractSurroundingText(string $plainText, string $refId): string
    {
        $plainText = trim($plainText);

        if (strlen($plainText) <= 500) {
            return $plainText;
        }

        // Split into sentences
        $sentences = preg_split('/(?<=[.!?])\s+/', $plainText, -1, PREG_SPLIT_NO_EMPTY);

        if (count($sentences) <= 3) {
            return $plainText;
        }

        // Find the sentence that mentions the refId
        $targetIndex = 0;
        foreach ($sentences as $i => $sentence) {
            if (stripos($sentence, $refId) !== false) {
                $targetIndex = $i;
                break;
            }
        }

        $start = max(0, $targetIndex - 1);
        $end = min(count($sentences) - 1, $targetIndex + 1);

        return implode(' ', array_slice($sentences, $start, $end - $start + 1));
    }

    /**
     * Load match_method for each referenceId from the latest bibliography scan results.
     */
    private function loadMatchMethods($db, string $bookId): array
    {
        $scan = $db->table('citation_scans')
            ->where('book', $bookId)
            ->where('status', 'completed')
            ->orderByDesc('created_at')
            ->first(['results']);

        if (!$scan || !$scan->results) {
            return [];
        }

        $results = json_decode($scan->results, true) ?? [];
        $map = [];

        foreach ($results as $r) {
            if (!empty($r['referenceId']) && !empty($r['match_method'])) {
                $map[$r['referenceId']] = $r['match_method'];
            }
        }

        return $map;
    }

    /**
     * Resolve a single referenceId against bibliography + library.
     */
    private function resolveReference(string $refId, array $info, $db, string $bookId, array $matchMethods = []): array
    {
        $result = [
            'referenceId'        => $refId,
            'occurrences'        => $info['occurrences'],
            'surrounding_text'   => $info['surrounding_text'],
            'status'             => 'no_match',
            'match_method'       => $matchMethods[$refId] ?? null,
            'foundation_book_id' => null,
            'content_book_id'    => null,
            'library_title'      => null,
            'is_oa'              => null,
            'oa_url'             => null,
            'pdf_url'            => null,
        ];

        // Bibliography lookup
        $bibEntry = $db->table('bibliography')
            ->where('book', $bookId)
            ->where('referenceId', $refId)
            ->first();

        if (!$bibEntry) {
            // Fall through to footnotes for footnote-only books
            $fnEntry = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('footnoteId', $refId)
                ->first();
            if (!$fnEntry) {
                return $result;
            }
            $foundationSource = $fnEntry->foundation_source ?? null;
        } else {
            $foundationSource = $bibEntry->foundation_source ?? null;
        }

        if (!$foundationSource || $foundationSource === 'unknown') {
            return $result;
        }

        // Library lookup
        $libraryRecord = $db->table('library')
            ->where('book', $foundationSource)
            ->first();

        if (!$libraryRecord) {
            return $result;
        }

        $result['foundation_book_id'] = $foundationSource;
        $result['library_title'] = $libraryRecord->title ?? null;
        $result['is_oa'] = $libraryRecord->is_oa ?? null;
        $result['oa_url'] = $libraryRecord->oa_url ?? null;
        $result['pdf_url'] = $libraryRecord->pdf_url ?? null;

        // Check if library record already has nodes
        $hasNodes = $libraryRecord->has_nodes ?? false;

        if ($hasNodes) {
            $result['status'] = 'has_content';
            $result['content_book_id'] = $foundationSource;
        } else {
            $result['status'] = 'needs_content';
        }

        return $result;
    }

    private function printSummary(array $results): void
    {
        $counts = [
            'has_content' => 0,
            'needs_content' => 0,
            'no_match' => 0,
        ];

        $totalOccurrences = 0;
        $needsContentItems = [];

        foreach ($results as $r) {
            $totalOccurrences += $r['occurrences'];

            match ($r['status']) {
                'has_content'    => $counts['has_content']++,
                'needs_content'  => $counts['needs_content']++,
                'no_match'       => $counts['no_match']++,
                default          => null,
            };

            if ($r['status'] === 'needs_content') {
                $needsContentItems[] = $r;
            }
        }

        $this->info("Unique citations: " . count($results));
        $this->info("Total occurrences: {$totalOccurrences}");
        $this->newLine();

        $this->line("  <fg=green>Has content:</>      {$counts['has_content']}");
        $this->line("  <fg=yellow>Needs content:</>    {$counts['needs_content']}");
        $this->line("  <fg=red>No match:</>          {$counts['no_match']}");

        // Show OA URLs for needs_content items
        if (!empty($needsContentItems)) {
            $this->newLine();
            $this->info('Needs content — available URLs:');
            foreach ($needsContentItems as $r) {
                $title = $r['library_title'] ?? $r['referenceId'];
                $url = $r['oa_url'] ?? $r['pdf_url'] ?? '(no URL)';
                $this->line("  <fg=yellow>{$title}</> → {$url}");
            }
        }
    }

    private function buildMarkdownReport(array $results, string $bookId): string
    {
        $md = "# Citation Content Scan Report\n\n";
        $md .= "- **Book:** {$bookId}\n";
        $md .= "- **Date:** " . now()->toDateTimeString() . "\n";
        $md .= "- **Unique citations:** " . count($results) . "\n\n";

        // Group by status
        $grouped = [];
        foreach ($results as $r) {
            $grouped[$r['status']][] = $r;
        }

        // Summary table
        $md .= "## Summary\n\n";
        $md .= "| Status | Count |\n|--------|-------|\n";
        foreach ($grouped as $status => $items) {
            $md .= "| {$status} | " . count($items) . " |\n";
        }
        $md .= "\n";

        // Has content
        if (!empty($grouped['has_content'])) {
            $md .= "## Has Content (" . count($grouped['has_content']) . ")\n\n";
            foreach ($grouped['has_content'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // Needs content
        if (!empty($grouped['needs_content'])) {
            $md .= "## Needs Content (" . count($grouped['needs_content']) . ")\n\n";
            foreach ($grouped['needs_content'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // No match
        if (!empty($grouped['no_match'])) {
            $md .= "## No Match (" . count($grouped['no_match']) . ")\n\n";
            foreach ($grouped['no_match'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        return $md;
    }

    /**
     * Pre-build a map of footnoteId → [refId, ...] for all footnotes in the book.
     * Uses two detection methods: inline links in footnote HTML, and author+year text matching.
     */
    private function buildFootnoteCitationMap($db, string $bookId, array $bibRefIdSet): array
    {
        // Footnote-only: each citation-classified footnote maps to itself
        if (empty($bibRefIdSet)) {
            $footnotes = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('is_citation', true)
                ->select(['footnoteId'])
                ->get();
            $map = [];
            foreach ($footnotes as $fn) {
                $map[$fn->footnoteId] = [$fn->footnoteId];
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
                $lastName = $this->extractLastName((string) $author);
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

    /**
     * Extract last name from an author string.
     * Handles "Surname, First" and "First Surname" formats.
     */
    private function extractLastName(string $author): string
    {
        $author = trim($author);
        if (empty($author)) {
            return '';
        }

        // "Surname, First" format
        if (str_contains($author, ',')) {
            return trim(explode(',', $author)[0]);
        }

        // "First Surname" format — take last word
        $words = preg_split('/\s+/', $author);
        return end($words);
    }

    private function formatEntryMd(array $r): string
    {
        $md = "### `{$r['referenceId']}`\n\n";
        $md .= "- **Occurrences:** {$r['occurrences']}\n";

        if (!empty($r['library_title'])) {
            $md .= "- **Title:** {$r['library_title']}\n";
        }
        if (!empty($r['match_method'])) {
            $md .= "- **Matched by:** {$r['match_method']}\n";
        }
        if (!empty($r['foundation_book_id'])) {
            $md .= "- **Foundation book:** `{$r['foundation_book_id']}`\n";
        }
        if (!empty($r['content_book_id'])) {
            $md .= "- **Content book:** `{$r['content_book_id']}`\n";
        }
        if ($r['is_oa'] !== null) {
            $md .= "- **Open Access:** " . ($r['is_oa'] ? 'yes' : 'no') . "\n";
        }
        if (!empty($r['oa_url'])) {
            $md .= "- **OA URL:** {$r['oa_url']}\n";
        }
        if (!empty($r['pdf_url'])) {
            $md .= "- **PDF URL:** {$r['pdf_url']}\n";
        }
        if (!empty($r['surrounding_text'])) {
            $text = mb_substr($r['surrounding_text'], 0, 300);
            $md .= "- **Context:** \"{$text}\"\n";
        }

        $md .= "\n";
        return $md;
    }
}
