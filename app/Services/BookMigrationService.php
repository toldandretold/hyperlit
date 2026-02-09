<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class BookMigrationService
{
    /**
     * Migrate node_id field for chunks missing it
     * Strategy: Full renumbering if decimals detected, otherwise sparse fill
     *
     * @return array Stats about the migration
     */
    public function migrateNodeIds(string $bookId, bool $dryRun = false): array
    {
        $stats = [
            'chunks_checked' => 0,
            'chunks_updated' => 0,
            'strategy' => 'none',
        ];

        // Quick check: if all chunks have node_id, skip migration entirely
        $chunksWithoutNodeId = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->whereNull('node_id')
            ->count();

        if ($chunksWithoutNodeId === 0) {
            return $stats;
        }

        $stats['chunks_checked'] = $chunksWithoutNodeId;

        // Check if any startLine has decimals (indicates messy paste operations)
        $hasDecimals = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->whereRaw('"startLine" != FLOOR("startLine")')
            ->exists();

        if ($hasDecimals) {
            $stats['strategy'] = 'full_renumber';
            if (!$dryRun) {
                $stats['chunks_updated'] = $this->fullRenumberMigration($bookId);
            } else {
                $stats['chunks_updated'] = DB::connection('pgsql_admin')->table('nodes')->where('book', $bookId)->count();
            }
        } else {
            $stats['strategy'] = 'sparse_fill';
            if (!$dryRun) {
                $stats['chunks_updated'] = $this->sparseFillNodeIds($bookId, $chunksWithoutNodeId);
            } else {
                $stats['chunks_updated'] = $chunksWithoutNodeId;
            }
        }

        return $stats;
    }

    /**
     * Sparse fill: Only update chunks missing node_id (no renumbering)
     */
    private function sparseFillNodeIds(string $bookId, int $missingCount): int
    {
        Log::channel('sync_audit')->info('Starting sparse node_id fill (no renumbering)', [
            'book_id' => $bookId,
            'missing_count' => $missingCount
        ]);

        // Get ONLY chunks missing node_id
        $chunks = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->whereNull('node_id')
            ->get();

        $toUpdate = [];

        foreach ($chunks as $chunk) {
            // Extract node_id from HTML or generate new one
            $extractedNodeId = $this->extractNodeIdFromHtml($chunk->content);
            $nodeId = $extractedNodeId ?: $this->generateNodeId($bookId);

            // Ensure HTML has the data-node-id attribute (add if missing)
            $updatedContent = $this->addNodeIdToHtml($chunk->content, $nodeId);

            // Update raw_json
            $rawJson = json_decode($chunk->raw_json, true);
            if ($rawJson && is_array($rawJson)) {
                $rawJson['content'] = $updatedContent;
                $rawJson['node_id'] = $nodeId;
                $updatedRawJson = json_encode($rawJson);
            } else {
                $updatedRawJson = $chunk->raw_json;
            }

            $toUpdate[] = [
                'book' => $chunk->book,
                'startLine' => $chunk->startLine,
                'node_id' => $nodeId,
                'content' => $updatedContent,
                'raw_json' => $updatedRawJson,
            ];
        }

        // Update nodes using parameterized queries
        foreach ($toUpdate as $update) {
            DB::statement(
                'UPDATE nodes SET node_id = ?, content = ?, raw_json = ?::jsonb, updated_at = ? WHERE book = ? AND "startLine" = ?',
                [
                    $update['node_id'],
                    $update['content'],
                    $update['raw_json'],
                    now(),
                    $update['book'],
                    $update['startLine']
                ]
            );
        }

        Log::channel('sync_audit')->info('node_id migration completed (sparse fill)', [
            'book_id' => $bookId,
            'chunks_updated' => count($toUpdate)
        ]);

        return count($toUpdate);
    }

    /**
     * Full renumbering: Clean slate with 100-unit gaps
     * Used when book has decimal startLines from paste operations
     *
     * Uses UPDATE instead of DELETE+INSERT to work with RLS policies.
     * Two-pass approach: first move to negative startLines, then to final positive values.
     */
    private function fullRenumberMigration(string $bookId): int
    {
        Log::channel('sync_audit')->info('Starting full renumbering migration (decimals detected)', [
            'book_id' => $bookId
        ]);

        // Get ALL chunks for this book, ordered by startLine
        $chunks = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->orderBy('startLine')
            ->get();

        if ($chunks->isEmpty()) {
            return 0;
        }

        $nodesPerChunk = 100;
        $updates = [];

        foreach ($chunks as $index => $chunk) {
            // Calculate new values with 100-unit gaps
            $newStartLine = ($index + 1) * 100;

            // Calculate chunk_id: group every 100 nodes into a chunk
            $chunkIndex = floor($index / $nodesPerChunk);
            $newChunkId = $chunkIndex;

            // Always generate fresh node_id during renumbering
            $nodeId = $this->generateNodeId($bookId);

            // Update content's id and data-node-id to match new startLine
            $updatedContent = $this->updateContentId($chunk->content, $newStartLine, $nodeId);

            // Update raw_json
            $rawJson = json_decode($chunk->raw_json, true);
            if ($rawJson && is_array($rawJson)) {
                $rawJson['content'] = $updatedContent;
                $rawJson['node_id'] = $nodeId;
                $rawJson['startLine'] = $newStartLine;
                $rawJson['chunk_id'] = $newChunkId;
                $updatedRawJson = json_encode($rawJson);
            } else {
                $updatedRawJson = $chunk->raw_json;
            }

            $updates[] = [
                'old_startLine' => $chunk->startLine,
                'temp_startLine' => -($index + 1),  // Temporary negative value
                'new_startLine' => $newStartLine,
                'chunk_id' => $newChunkId,
                'node_id' => $nodeId,
                'content' => $updatedContent,
                'plainText' => $chunk->plainText ?? null,
                'type' => $chunk->type ?? null,
                'footnotes' => $chunk->footnotes ?? '[]',
                'raw_json' => $updatedRawJson,
            ];
        }

        try {
            DB::transaction(function () use ($bookId, $updates) {
                // Pass 1: Move all rows to temporary negative startLines to avoid conflicts
                foreach ($updates as $update) {
                    DB::connection('pgsql_admin')->table('nodes')
                        ->where('book', $bookId)
                        ->where('startLine', $update['old_startLine'])
                        ->update(['startLine' => $update['temp_startLine']]);
                }

                // Pass 2: Update to final values
                foreach ($updates as $update) {
                    DB::connection('pgsql_admin')->table('nodes')
                        ->where('book', $bookId)
                        ->where('startLine', $update['temp_startLine'])
                        ->update([
                            'startLine' => $update['new_startLine'],
                            'chunk_id' => $update['chunk_id'],
                            'node_id' => $update['node_id'],
                            'content' => $update['content'],
                            'plainText' => $update['plainText'],
                            'type' => $update['type'],
                            'footnotes' => $update['footnotes'],
                            'raw_json' => $update['raw_json'],
                            'updated_at' => now(),
                        ]);
                }
            });
        } catch (\Exception $e) {
            Log::channel('sync_audit')->error('Full renumbering failed', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'node_count' => count($updates),
            ]);
            throw new \Exception("Full renumbering failed for {$bookId}: " . $e->getMessage());
        }

        // Update library timestamp
        DB::connection('pgsql_admin')->table('library')
            ->where('book', $bookId)
            ->update(['timestamp' => round(microtime(true) * 1000)]);

        Log::channel('sync_audit')->info('Full renumbering completed', [
            'book_id' => $bookId,
            'nodes_renumbered' => count($updates),
        ]);

        return count($updates);
    }

    /**
     * Migrate footnotes array for nodes where nodes.footnotes doesn't match nodes.content.
     * Also normalizes HTML to canonical format.
     *
     * @return array Stats about the migration
     */
    public function migrateNodeFootnotes(string $bookId, bool $dryRun = false): array
    {
        $stats = [
            'nodes_checked' => 0,
            'nodes_fixed' => 0,
            'footnotes_renumbered' => false,
        ];

        // Get all nodes that might have footnotes (quick filter)
        $nodesWithFootnoteMarkers = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->where(function($q) {
                $q->where('content', 'like', '%fn-count-id%')
                  ->orWhere('content', 'like', '%Fn%');
            })
            ->get();

        if ($nodesWithFootnoteMarkers->isEmpty()) {
            return $stats;
        }

        $stats['nodes_checked'] = $nodesWithFootnoteMarkers->count();

        $nodesToFix = [];

        foreach ($nodesWithFootnoteMarkers as $node) {
            $storedFootnotes = json_decode($node->footnotes ?? '[]', true) ?: [];

            // Normalize HTML to canonical format and extract footnote IDs
            $normalizedContent = $this->normalizeFootnoteHtml($node->content);
            $contentFootnotes = $this->extractFootnoteIdsFromHtml($normalizedContent);

            $needsUpdate = false;
            $updateData = ['updated_at' => now()];

            // Check if stored footnotes are in legacy string format
            $hasLegacyFormat = $this->hasLegacyFootnoteFormat($storedFootnotes);

            // Normalize stored footnotes to object format for comparison
            $normalizedStored = $this->normalizeFootnoteArray($storedFootnotes);

            // Update if: legacy format OR IDs don't match content
            if ($hasLegacyFormat || !$this->footnotesMatch($normalizedStored, $contentFootnotes)) {
                $updateData['footnotes'] = json_encode($contentFootnotes);
                $needsUpdate = true;
            }

            // Check if HTML was normalized
            if ($normalizedContent !== $node->content) {
                $updateData['content'] = $normalizedContent;
                $needsUpdate = true;
            }

            if ($needsUpdate) {
                $nodesToFix[] = [
                    'startLine' => $node->startLine,
                    'updateData' => $updateData,
                ];
            }
        }

        if (empty($nodesToFix)) {
            return $stats;
        }

        $stats['nodes_fixed'] = count($nodesToFix);

        if (!$dryRun) {
            Log::channel('sync_audit')->info('Fixing footnotes (format + array)', [
                'book_id' => $bookId,
                'nodes_to_fix' => count($nodesToFix)
            ]);

            // Update nodes
            foreach ($nodesToFix as $fix) {
                DB::connection('pgsql_admin')->table('nodes')
                    ->where('book', $bookId)
                    ->where('startLine', $fix['startLine'])
                    ->update($fix['updateData']);
            }

            // Renumber all footnotes in document order
            $this->renumberFootnotes($bookId);
            $stats['footnotes_renumbered'] = true;

            Log::channel('sync_audit')->info('Footnotes fixed', [
                'book_id' => $bookId,
                'nodes_fixed' => count($nodesToFix)
            ]);
        }

        return $stats;
    }

    /**
     * Normalize footnote HTML to canonical format.
     * Canonical: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
     */
    private function normalizeFootnoteHtml(string $html): string
    {
        // Pattern to match OLD format: sup with anchor inside
        $pattern = '/<sup([^>]*)>\s*<a[^>]*href="#([^"]+)"[^>]*>(\d+|\?)<\/a>\s*<\/sup>/i';

        $normalized = preg_replace_callback($pattern, function($matches) {
            $supAttrs = $matches[1];
            $footnoteId = $matches[2];
            $displayNumber = $matches[3];

            // Only process if this looks like a footnote (contains Fn)
            if (strpos($footnoteId, 'Fn') === false) {
                return $matches[0];
            }

            // Extract fn-count-id if present, otherwise use display number
            if (preg_match('/fn-count-id="([^"]*)"/', $supAttrs, $fnMatch)) {
                $fnCountId = $fnMatch[1];
            } else {
                $fnCountId = $displayNumber;
            }

            // New canonical format: no anchor, class on sup, text content directly
            return '<sup fn-count-id="' . $fnCountId . '" id="' . $footnoteId . '" class="footnote-ref">' . $displayNumber . '</sup>';
        }, $html);

        return $normalized ?? $html;
    }

    /**
     * Renumber all footnotes in a book based on document order (startLine).
     */
    private function renumberFootnotes(string $bookId): void
    {
        // Get all nodes with footnotes, ordered by startLine
        $nodesWithFootnotes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->where(function($q) {
                $q->where('content', 'like', '%fn-count-id%')
                  ->orWhere('content', 'like', '%footnote-ref%');
            })
            ->orderBy('startLine')
            ->get();

        if ($nodesWithFootnotes->isEmpty()) {
            return;
        }

        // Build footnoteId → displayNumber map in document order
        $footnoteMap = [];
        $displayNumber = 1;

        foreach ($nodesWithFootnotes as $node) {
            $footnotes = $this->extractFootnoteIdsFromHtml($node->content);
            foreach ($footnotes as $footnote) {
                $footnoteId = $footnote['id'];
                if (!isset($footnoteMap[$footnoteId])) {
                    $footnoteMap[$footnoteId] = $displayNumber++;
                }
            }
        }

        if (empty($footnoteMap)) {
            return;
        }

        // Update each node's HTML with correct display numbers
        foreach ($nodesWithFootnotes as $node) {
            $updatedContent = $this->updateFootnoteNumbersInHtml($node->content, $footnoteMap);

            if ($updatedContent !== $node->content) {
                DB::connection('pgsql_admin')->table('nodes')
                    ->where('book', $bookId)
                    ->where('startLine', $node->startLine)
                    ->update([
                        'content' => $updatedContent,
                        'updated_at' => now()
                    ]);
            }
        }
    }

    /**
     * Update fn-count-id attributes and text content in HTML content
     */
    private function updateFootnoteNumbersInHtml(string $html, array $footnoteMap): string
    {
        // New format: <sup fn-count-id="X" id="footnoteId" class="footnote-ref">N</sup>
        $updatedHtml = preg_replace_callback(
            '/<sup([^>]*)\bid="([^"]*(?:_Fn|Fn)[^"]*)"([^>]*)class="footnote-ref"([^>]*)>(\d+|\?)<\/sup>/i',
            function($matches) use ($footnoteMap) {
                $beforeId = $matches[1];
                $footnoteId = $matches[2];
                $betweenIdClass = $matches[3];
                $afterClass = $matches[4];
                $displayNumber = $matches[5];

                if (isset($footnoteMap[$footnoteId])) {
                    $newNumber = $footnoteMap[$footnoteId];
                    $attrs = $beforeId . 'id="' . $footnoteId . '"' . $betweenIdClass . 'class="footnote-ref"' . $afterClass;
                    // Update fn-count-id attribute
                    $attrs = preg_replace('/fn-count-id="[^"]*"/', 'fn-count-id="' . $newNumber . '"', $attrs);
                    return '<sup' . $attrs . '>' . $newNumber . '</sup>';
                }

                return $matches[0];
            },
            $html
        );

        // Old format fallback: <sup fn-count-id="..."><a ... href="#footnoteId">...</a></sup>
        $updatedHtml = preg_replace_callback(
            '/<sup([^>]*fn-count-id="[^"]*"[^>]*)>(\s*<a[^>]*href="#([^"]+)"[^>]*>)[^<]*(<\/a>\s*<\/sup>)/i',
            function($matches) use ($footnoteMap) {
                $supAttrs = $matches[1];
                $aTag = $matches[2];
                $footnoteId = $matches[3];
                $closing = $matches[4];

                if (isset($footnoteMap[$footnoteId])) {
                    $newNumber = $footnoteMap[$footnoteId];
                    // Update fn-count-id attribute
                    $supAttrs = preg_replace('/fn-count-id="[^"]*"/', 'fn-count-id="' . $newNumber . '"', $supAttrs);
                    return '<sup' . $supAttrs . '>' . $aTag . $newNumber . $closing;
                }

                return $matches[0];
            },
            $updatedHtml ?? $html
        );

        return $updatedHtml ?? $html;
    }

    /**
     * Extract footnote data from HTML content
     * Returns objects with {id, marker} to match JS format
     *
     * @return array Array of ['id' => string, 'marker' => string]
     */
    private function extractFootnoteIdsFromHtml(?string $html): array
    {
        if (empty($html)) {
            return [];
        }

        $footnotes = [];
        $seen = [];

        // New format: <sup fn-count-id="1" id="...Fn..." class="footnote-ref">1</sup>
        if (preg_match_all('/<sup([^>]*)id="([^"]*(?:_Fn|Fn)[^"]*)"([^>]*)class="footnote-ref"[^>]*>/i', $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $id = $match[2];
                if (!isset($seen[$id])) {
                    $attrs = $match[1] . $match[3];
                    $marker = '';
                    if (preg_match('/fn-count-id="([^"]*)"/', $attrs, $fnMatch)) {
                        $marker = $fnMatch[1];
                    }
                    $footnotes[] = ['id' => $id, 'marker' => $marker];
                    $seen[$id] = true;
                }
            }
        }

        // Also check reverse attribute order: class before id
        if (preg_match_all('/<sup([^>]*)class="footnote-ref"([^>]*)id="([^"]*(?:_Fn|Fn)[^"]*)"[^>]*>/i', $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $id = $match[3];
                if (!isset($seen[$id])) {
                    $attrs = $match[1] . $match[2];
                    $marker = '';
                    if (preg_match('/fn-count-id="([^"]*)"/', $attrs, $fnMatch)) {
                        $marker = $fnMatch[1];
                    }
                    $footnotes[] = ['id' => $id, 'marker' => $marker];
                    $seen[$id] = true;
                }
            }
        }

        // Old format fallback: <sup fn-count-id="..."><a href="#...Fn...">
        if (preg_match_all('/<sup([^>]*)>\s*<a[^>]*href="#([^"]*(?:_Fn|Fn)[^"]*)"[^>]*>/i', $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $id = $match[2];
                if (!isset($seen[$id])) {
                    $attrs = $match[1];
                    $marker = '';
                    if (preg_match('/fn-count-id="([^"]*)"/', $attrs, $fnMatch)) {
                        $marker = $fnMatch[1];
                    }
                    $footnotes[] = ['id' => $id, 'marker' => $marker];
                    $seen[$id] = true;
                }
            }
        }

        return $footnotes;
    }

    /**
     * Normalize a footnotes array to object format.
     * Handles both legacy string format and new object format.
     *
     * @param array $footnotes Array of strings or objects
     * @return array Array of ['id' => string, 'marker' => string]
     */
    private function normalizeFootnoteArray(array $footnotes): array
    {
        return array_map(function ($item) {
            if (is_string($item)) {
                // Legacy string format - convert to object
                return ['id' => $item, 'marker' => ''];
            }
            if (is_array($item) && isset($item['id'])) {
                // Already object format - ensure marker exists
                return [
                    'id' => $item['id'],
                    'marker' => $item['marker'] ?? ''
                ];
            }
            // Unknown format - skip
            return null;
        }, $footnotes);
    }

    /**
     * Check if footnotes array contains legacy string format.
     * Returns true if any item is a string (not object format).
     */
    private function hasLegacyFootnoteFormat(array $footnotes): bool
    {
        foreach ($footnotes as $item) {
            if (is_string($item)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if two footnote arrays match by comparing IDs.
     * Used to determine if stored footnotes need updating.
     *
     * @param array $stored Normalized stored footnotes
     * @param array $extracted Extracted footnotes from content
     * @return bool True if they match (same IDs in same order)
     */
    private function footnotesMatch(array $stored, array $extracted): bool
    {
        // Filter out nulls from normalization
        $stored = array_values(array_filter($stored, fn($item) => $item !== null));

        if (count($stored) !== count($extracted)) {
            return false;
        }

        for ($i = 0; $i < count($stored); $i++) {
            if ($stored[$i]['id'] !== $extracted[$i]['id']) {
                return false;
            }
        }

        return true;
    }

    /**
     * Extract node_id from HTML content's data-node-id attribute
     */
    private function extractNodeIdFromHtml(?string $html): ?string
    {
        if (empty($html)) {
            return null;
        }

        $dom = new \DOMDocument();
        libxml_use_internal_errors(true);
        $dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        libxml_clear_errors();

        $firstElement = $dom->firstChild;

        if ($firstElement && $firstElement instanceof \DOMElement) {
            $nodeId = $firstElement->getAttribute('data-node-id');
            return !empty($nodeId) ? $nodeId : null;
        }

        return null;
    }

    /**
     * Generate a unique node_id in format: {book}_{timestamp}_{random}
     */
    private function generateNodeId(string $bookId): string
    {
        $timestamp = round(microtime(true) * 1000);
        $random = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 9);
        return "{$bookId}_{$timestamp}_{$random}";
    }

    /**
     * Update content's id attribute and data-node-id to match new startLine
     */
    private function updateContentId(?string $html, int $newStartLine, string $nodeId): string
    {
        if (empty($html)) {
            return $html ?? '';
        }

        $pattern = '/^(<[a-z][a-z0-9]*)((?:\s+[^>]*)?)(>)/i';

        $replacement = function($matches) use ($newStartLine, $nodeId) {
            $tagStart = $matches[1];
            $attributes = $matches[2];
            $tagEnd = $matches[3];

            // Remove existing id and data-node-id attributes
            $attributes = preg_replace('/\s+id="[^"]*"/', '', $attributes);
            $attributes = preg_replace('/\s+data-node-id="[^"]*"/', '', $attributes);

            // Add new id and data-node-id
            $newAttributes = ' id="' . $newStartLine . '" data-node-id="' . htmlspecialchars($nodeId, ENT_QUOTES) . '"' . $attributes;

            return $tagStart . $newAttributes . $tagEnd;
        };

        $updatedHtml = preg_replace_callback($pattern, $replacement, $html, 1);

        return $updatedHtml ?? $html;
    }

    /**
     * Add data-node-id attribute to HTML content
     */
    private function addNodeIdToHtml(?string $html, string $nodeId): string
    {
        if (empty($html)) {
            return $html ?? '';
        }

        // Check if it already has the attribute
        if (strpos($html, 'data-node-id') !== false) {
            return $html;
        }

        // Use regex to add data-node-id to the first opening tag
        $pattern = '/^(<[a-z][a-z0-9]*)([\\s>])/i';
        $replacement = '$1 data-node-id="' . htmlspecialchars($nodeId, ENT_QUOTES) . '"$2';

        $updatedHtml = preg_replace($pattern, $replacement, $html, 1);

        return $updatedHtml ?? $html;
    }
}
