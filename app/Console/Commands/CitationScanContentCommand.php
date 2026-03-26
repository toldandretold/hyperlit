<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
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
            ->select(['content', 'plainText'])
            ->get();

        $citations = [];

        foreach ($nodes as $node) {
            $content = $node->content ?? '';

            // Match <a href="#refId" class="in-text-citation">
            if (!preg_match_all('/<a\s[^>]*href="#([^"]+)"[^>]*class="in-text-citation"[^>]*>/i', $content, $matches)) {
                // Also try class before href
                if (!preg_match_all('/<a\s[^>]*class="in-text-citation"[^>]*href="#([^"]+)"[^>]*>/i', $content, $matches)) {
                    continue;
                }
            }

            foreach ($matches[1] as $refId) {
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
            return $result;
        }

        $foundationSource = $bibEntry->foundation_source ?? null;

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
