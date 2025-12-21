<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DatabaseToIndexedDBController extends Controller
{
    /**
     * Check book visibility using SECURITY DEFINER function (bypasses RLS).
     * This allows distinguishing between "book doesn't exist" and "book exists but is private".
     *
     * @return object|null Returns object with book_exists, visibility, creator, creator_token or null if book doesn't exist
     */
    private function checkBookVisibility(string $bookId): ?object
    {
        $result = DB::selectOne('SELECT * FROM check_book_visibility(?)', [$bookId]);
        return $result;
    }

    /**
     * Check authorization for a book and return appropriate error response if unauthorized.
     *
     * @return JsonResponse|null Returns error response if unauthorized, null if authorized
     */
    private function checkBookAuthorization(Request $request, string $bookId): ?JsonResponse
    {
        // Use SECURITY DEFINER function to bypass RLS and check if book exists
        $bookInfo = $this->checkBookVisibility($bookId);

        // Book doesn't exist at all
        if (!$bookInfo) {
            return response()->json([
                'error' => 'Book not found',
                'book_id' => $bookId
            ], 404);
        }

        // Book is deleted
        if ($bookInfo->visibility === 'deleted') {
            Log::info('🗑️ Deleted book accessed', [
                'book_id' => $bookId
            ]);

            return response()->json([
                'error' => 'book_deleted',
                'message' => 'This book has been deleted',
                'is_deleted' => true,
                'book_id' => $bookId
            ], 410);
        }

        // Book is private - check authorization
        if ($bookInfo->visibility === 'private') {
            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            $authorized = false;

            // Check creator (username-based auth)
            if ($user && $bookInfo->creator === $user->name) {
                $authorized = true;
                Log::info('📗 Private book access granted via username', [
                    'book_id' => $bookId,
                    'user' => $user->name
                ]);
            }
            // Check creator_token (anonymous token-based auth)
            elseif (!$user && $anonymousToken && $bookInfo->creator_token === $anonymousToken) {
                $authorized = true;
                Log::info('📗 Private book access granted via anonymous token', [
                    'book_id' => $bookId
                ]);
            }

            if (!$authorized) {
                Log::warning('🔒 Private book access denied', [
                    'book_id' => $bookId,
                    'user' => $user ? $user->name : 'anonymous',
                    'has_token' => !empty($anonymousToken)
                ]);

                return response()->json([
                    'error' => 'access_denied',
                    'message' => 'You do not have permission to access this private book',
                    'is_private' => true,
                    'book_id' => $bookId
                ], 403);
            }
        }

        // Authorized - no error response needed
        return null;
    }

    /**
     * Get complete book data for IndexedDB import
     */
    public function getBookData(Request $request, string $bookId): JsonResponse
    {
        try {
            // 🔒 CRITICAL: Check book visibility and access permissions (bypasses RLS)
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            // Now query with RLS - will return the record since user is authorized
            $library = DB::table('library')->where('book', $bookId)->first();

            $visibleHyperlightIds = $this->getVisibleHyperlightIds($bookId);

            // Get node chunks for this book, filtering the highlights within them
            $nodeChunks = $this->getNodeChunks($bookId, $visibleHyperlightIds);
            
            if (empty($nodeChunks)) {
                return response()->json([
                    'error' => 'No data found for book',
                    'book_id' => $bookId
                ], 404);
            }

            // Get footnotes for this book
            $footnotes = $this->getFootnotes($bookId);
            
            // Get bibliography/references for this book
            $bibliography = $this->getBibliography($bookId);
            
            // Get hyperlights for this book
            $hyperlights = $this->getHyperlights($bookId);
            
            // Get hypercites for this book
            $hypercites = $this->getHypercites($bookId);
            
            // Get library data for this book
            $library = $this->getLibrary($bookId);

            // Structure data for efficient IndexedDB import
            $response = [
                'nodes' => $nodeChunks,
                'footnotes' => $footnotes,
                'bibliography' => $bibliography,
                'hyperlights' => $hyperlights,
                'hypercites' => $hypercites,
                'library' => $library,
                'metadata' => [
                    'book_id' => $bookId,
                    'total_chunks' => count($nodeChunks),
                    'total_footnotes' => $footnotes ? count($footnotes['data'] ?? []) : 0,
                    'total_bibliography' => $bibliography ? count($bibliography['data'] ?? []) : 0,
                    'total_hyperlights' => count($hyperlights ?? []),
                    'total_hypercites' => count($hypercites ?? []),
                    'generated_at' => now()->toISOString(),
                ]
            ];

            return response()->json($response);

        } catch (\Exception $e) {
            Log::error('Error fetching book data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch book data'
            ], 500);
        }
    }

    private function getVisibleHyperlightIds(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');

        $query = DB::table('hyperlights')
            ->where('book', $bookId)
            ->where(function($q) use ($user, $anonymousToken) {
                $q->where('hidden', false);

                // Prioritized auth: username first, then token only if no username
                if ($user) {
                    // Logged-in user: show highlights with matching username OR highlights with no username but matching token
                    $q->orWhere(function($subQ) use ($user, $anonymousToken) {
                        $subQ->where('creator', $user->name);
                        // Also show highlights that were created anonymously but user took ownership
                        if ($anonymousToken) {
                            $subQ->orWhere(function($tokenQ) use ($anonymousToken) {
                                $tokenQ->whereNull('creator')
                                       ->where('creator_token', $anonymousToken);
                            });
                        }
                    });
                } elseif ($anonymousToken) {
                    // Anonymous user: only show highlights with no username but matching token
                    $q->orWhere(function($subQ) use ($anonymousToken) {
                        $subQ->whereNull('creator')
                             ->where('creator_token', $anonymousToken);
                    });
                }
            });

        return $query->pluck('hyperlight_id')->toArray();
    }

    /**
     * Migrate node_id field for chunks missing it
     * Strategy: Full renumbering if decimals detected, otherwise sparse fill
     */
    private function migrateNodeIds(string $bookId): void
    {
        // Quick check: if all chunks have node_id, skip migration entirely
        $chunksWithoutNodeId = DB::table('nodes')
            ->where('book', $bookId)
            ->whereNull('node_id')
            ->count();

        if ($chunksWithoutNodeId === 0) {
            // All chunks already have node_id, skip expensive checks
            return;
        }

        // Check if any startLine has decimals (indicates messy paste operations)
        $hasDecimals = DB::table('nodes')
            ->where('book', $bookId)
            ->whereRaw('"startLine" != FLOOR("startLine")')
            ->exists();

        if ($hasDecimals) {
            // Book has decimals → needs full renumbering for clean slate
            $this->fullRenumberMigration($bookId);
        } else {
            // Book is clean → just fill missing node_ids
            $this->sparseFillNodeIds($bookId, $chunksWithoutNodeId);
        }
    }

    /**
     * Sparse fill: Only update chunks missing node_id (no renumbering)
     */
    private function sparseFillNodeIds(string $bookId, int $missingCount): void
    {
        Log::info('🔄 Starting sparse node_id fill (no renumbering)', [
            'book_id' => $bookId,
            'missing_count' => $missingCount
        ]);

        // Get ONLY chunks missing node_id
        $chunks = DB::table('nodes')
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

        // Choose strategy based on count
        if (count($toUpdate) > 100) {
            // Bulk update with UPDATE FROM VALUES (fast for many rows)
            $this->bulkUpdateNodeIds($toUpdate);
        } else {
            // Individual updates (fine for small counts)
            foreach ($toUpdate as $update) {
                // 🔒 SECURITY: Use parameterized query instead of string concatenation
                // The old code was vulnerable to SQL injection via raw_json
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
        }

        Log::info('✅ node_id migration completed (sparse fill)', [
            'book_id' => $bookId,
            'chunks_updated' => count($toUpdate)
        ]);
    }

    /**
     * Bulk update using parameterized queries (secure for many rows)
     * 🔒 SECURITY: Uses parameterized queries instead of PDO::quote()
     * PDO::quote() can be bypassed with multibyte character attacks (GBK/SJIS)
     */
    private function bulkUpdateNodeIds(array $updates): void
    {
        if (empty($updates)) return;

        // Process in chunks to avoid memory issues while using parameterized queries
        foreach (array_chunk($updates, 50) as $chunk) {
            foreach ($chunk as $update) {
                // 🔒 SECURITY: Use parameterized query instead of PDO::quote()
                // PDO::quote() can be bypassed with multibyte character attacks
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
        }
    }

    /**
     * Full renumbering: Clean slate with 100-unit gaps
     * Used when book has decimal startLines from paste operations
     */
    private function fullRenumberMigration(string $bookId): void
    {
        Log::info('🔄 Starting full renumbering migration (decimals detected)', [
            'book_id' => $bookId
        ]);

        // Get ALL chunks for this book, ordered by startLine
        $chunks = DB::table('nodes')
            ->where('book', $bookId)
            ->orderBy('startLine')
            ->get();

        $toInsert = [];
        $nodesPerChunk = 100; // Each chunk contains 100 nodes

        foreach ($chunks as $index => $chunk) {
            // Calculate new values with 100-unit gaps
            $newStartLine = ($index + 1) * 100; // 100, 200, 300...

            // Calculate chunk_id: group every 100 nodes into a chunk
            // Nodes 0-99 → chunk 0, nodes 100-199 → chunk 1, etc.
            $chunkIndex = floor($index / $nodesPerChunk);
            $newChunkId = $chunkIndex;    // 0, 1, 2...

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

            $toInsert[] = [
                'book' => $chunk->book,
                'startLine' => $newStartLine,
                'chunk_id' => $newChunkId,
                'node_id' => $nodeId,
                'content' => $updatedContent,
                'plainText' => $chunk->plainText ?? null,
                'type' => $chunk->type ?? null,
                'footnotes' => $chunk->footnotes ?? '[]',
                'raw_json' => $updatedRawJson,
                'created_at' => $chunk->created_at ?? now(),
                'updated_at' => now(),
            ];
        }

        // Use DELETE + INSERT (much faster than UPDATE for bulk renumbering)
        if (!empty($toInsert)) {
            DB::transaction(function () use ($bookId, $toInsert) {
                // Delete all old rows
                DB::table('nodes')
                    ->where('book', $bookId)
                    ->delete();

                // Bulk insert new rows (500 at a time to avoid memory issues)
                foreach (array_chunk($toInsert, 500) as $chunk) {
                    DB::table('nodes')->insert($chunk);
                }
            });

            // Update library timestamp
            DB::table('library')
                ->where('book', $bookId)
                ->update(['timestamp' => round(microtime(true) * 1000)]);

            Log::info('✅ Full renumbering completed', [
                'book_id' => $bookId,
                'nodes_renumbered' => count($toInsert),
                'startLine_range' => '100-' . (count($toInsert) * 100),
                'chunk_id_range' => '0-' . ((floor((count($toInsert) - 1) / 100)) * 100)
            ]);
        }
    }

    /**
     * Extract node_id from HTML content's data-node-id attribute
     */
    private function extractNodeIdFromHtml(?string $html): ?string
    {
        if (empty($html)) {
            return null;
        }

        // Use DOMDocument to parse HTML and extract data-node-id
        $dom = new \DOMDocument();

        // Suppress warnings for malformed HTML
        libxml_use_internal_errors(true);

        // Load HTML with UTF-8 encoding
        $dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);

        libxml_clear_errors();

        // Get the first element
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
        $timestamp = round(microtime(true) * 1000); // milliseconds
        $random = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 9);
        return "{$bookId}_{$timestamp}_{$random}";
    }

    /**
     * Update content's id attribute and data-node-id to match new startLine
     * Used during renumbering migration
     */
    private function updateContentId(?string $html, int $newStartLine, string $nodeId): string
    {
        if (empty($html)) {
            return $html ?? '';
        }

        // Pattern to match the first opening tag with optional existing id and data-node-id
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

        if ($updatedHtml !== null && $updatedHtml !== $html) {
            Log::debug('Updated content ID during renumbering', [
                'new_startLine' => $newStartLine,
                'node_id' => $nodeId,
                'original' => substr($html, 0, 100),
                'updated' => substr($updatedHtml, 0, 100)
            ]);
            return $updatedHtml;
        }

        // Fallback: return original
        Log::warning('Could not update content ID', [
            'new_startLine' => $newStartLine,
            'node_id' => $nodeId,
            'html' => substr($html, 0, 100)
        ]);
        return $html;
    }

    /**
     * Add data-node-id attribute to HTML content
     * Uses regex for reliability with HTML fragments
     */
    private function addNodeIdToHtml(?string $html, string $nodeId): string
    {
        if (empty($html)) {
            return $html ?? '';
        }

        // Check if it already has the attribute
        if (strpos($html, 'data-node-id') !== false) {
            return $html; // Already has it
        }

        // Use regex to add data-node-id to the first opening tag
        // Matches: <tagname (any attributes)>
        // Replaces with: <tagname data-node-id="..." (any attributes)>
        $pattern = '/^(<[a-z][a-z0-9]*)([\s>])/i';
        $replacement = '$1 data-node-id="' . htmlspecialchars($nodeId, ENT_QUOTES) . '"$2';

        $updatedHtml = preg_replace($pattern, $replacement, $html, 1);

        if ($updatedHtml !== null && $updatedHtml !== $html) {
            Log::debug('Added data-node-id to HTML', [
                'node_id' => $nodeId,
                'original' => substr($html, 0, 100),
                'updated' => substr($updatedHtml, 0, 100)
            ]);
            return $updatedHtml;
        }

        // Fallback: return original
        Log::warning('Could not add data-node-id to HTML', [
            'node_id' => $nodeId,
            'html' => substr($html, 0, 100)
        ]);
        return $html;
    }

    /**
     * Migrate footnotes array for nodes where nodes.footnotes doesn't match nodes.content.
     * Also normalizes HTML to canonical format.
     * Fixes: empty footnotes column, orphaned IDs, missing IDs, non-canonical HTML.
     * Similar to migrateNodeIds() - runs once per book, only fixes mismatches.
     */
    private function migrateNodeFootnotes(string $bookId): void
    {
        // Get all nodes that might have footnotes (quick filter)
        $nodesWithFootnoteMarkers = DB::table('nodes')
            ->where('book', $bookId)
            ->where(function($q) {
                $q->where('content', 'like', '%fn-count-id%')
                  ->orWhere('content', 'like', '%Fn%');
            })
            ->get();

        if ($nodesWithFootnoteMarkers->isEmpty()) {
            return;
        }

        $nodesToFix = [];

        foreach ($nodesWithFootnoteMarkers as $node) {
            $storedFootnotes = json_decode($node->footnotes ?? '[]', true) ?: [];

            // Normalize HTML to canonical format and extract footnote IDs
            $normalizedContent = $this->normalizeFootnoteHtml($node->content);
            $contentFootnotes = $this->extractFootnoteIdsFromHtml($normalizedContent);

            $needsUpdate = false;
            $updateData = ['updated_at' => now()];

            // Check if footnotes array needs updating
            if ($storedFootnotes !== $contentFootnotes) {
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
            return;
        }

        Log::info('🔄 Fixing footnotes (format + array)', [
            'book_id' => $bookId,
            'nodes_to_fix' => count($nodesToFix)
        ]);

        // Update nodes
        foreach ($nodesToFix as $fix) {
            DB::table('nodes')
                ->where('book', $bookId)
                ->where('startLine', $fix['startLine'])
                ->update($fix['updateData']);
        }

        Log::info('✅ Footnotes fixed, now renumbering', [
            'book_id' => $bookId,
            'nodes_fixed' => count($nodesToFix)
        ]);

        // Renumber all footnotes in document order
        $this->renumberFootnotes($bookId);
    }

    /**
     * Normalize footnote HTML to canonical format.
     * Canonical: <sup fn-count-id="1" id="footnoteIdref"><a class="footnote-ref" href="#footnoteId">1</a></sup>
     *
     * Handles old formats:
     * - data-footnote-id attribute (remove, use href instead)
     * - Missing class="footnote-ref" on <a>
     * - Wrong id format on <sup>
     */
    private function normalizeFootnoteHtml(string $html): string
    {
        // Pattern to match any footnote sup element
        // Captures: full sup tag, attributes, anchor tag with href, footnote ID, display number
        $pattern = '/<sup([^>]*)>(\s*<a[^>]*href="#([^"]+)"[^>]*>)(\d+|\?)(<\/a>\s*<\/sup>)/i';

        $normalized = preg_replace_callback($pattern, function($matches) {
            $supAttrs = $matches[1];
            $aTagStart = $matches[2];
            $footnoteId = $matches[3];
            $displayNumber = $matches[4];
            $closing = $matches[5];

            // Only process if this looks like a footnote (contains Fn)
            if (strpos($footnoteId, 'Fn') === false) {
                return $matches[0];
            }

            // Build canonical sup attributes
            // Extract fn-count-id if present, otherwise use display number
            if (preg_match('/fn-count-id="([^"]*)"/', $supAttrs, $fnMatch)) {
                $fnCountId = $fnMatch[1];
            } else {
                $fnCountId = $displayNumber;
            }

            // Canonical format: fn-count-id and id only (no data-footnote-id)
            $canonicalSupAttrs = ' fn-count-id="' . $fnCountId . '" id="' . $footnoteId . 'ref"';

            // Build canonical anchor tag
            $canonicalATag = '<a class="footnote-ref" href="#' . $footnoteId . '">';

            return '<sup' . $canonicalSupAttrs . '>' . $canonicalATag . $displayNumber . '</a></sup>';
        }, $html);

        return $normalized ?? $html;
    }

    /**
     * Renumber all footnotes in a book based on document order (startLine).
     * Updates fn-count-id attributes and link text in HTML content.
     */
    private function renumberFootnotes(string $bookId): void
    {
        // Get all nodes with footnotes, ordered by startLine
        $nodesWithFootnotes = DB::table('nodes')
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
            $footnoteIds = $this->extractFootnoteIdsFromHtml($node->content);
            foreach ($footnoteIds as $footnoteId) {
                if (!isset($footnoteMap[$footnoteId])) {
                    $footnoteMap[$footnoteId] = $displayNumber++;
                }
            }
        }

        if (empty($footnoteMap)) {
            return;
        }

        Log::info('🔢 Renumbering footnotes', [
            'book_id' => $bookId,
            'total_footnotes' => count($footnoteMap)
        ]);

        // Update each node's HTML with correct display numbers
        $updatedCount = 0;
        foreach ($nodesWithFootnotes as $node) {
            $updatedContent = $this->updateFootnoteNumbersInHtml($node->content, $footnoteMap);

            if ($updatedContent !== $node->content) {
                DB::table('nodes')
                    ->where('book', $bookId)
                    ->where('startLine', $node->startLine)
                    ->update([
                        'content' => $updatedContent,
                        'updated_at' => now()
                    ]);
                $updatedCount++;
            }
        }

        Log::info('✅ Footnote renumbering completed', [
            'book_id' => $bookId,
            'nodes_updated' => $updatedCount
        ]);
    }

    /**
     * Update fn-count-id attributes and link text in HTML content
     */
    private function updateFootnoteNumbersInHtml(string $html, array $footnoteMap): string
    {
        // Update <sup fn-count-id="X"> and the link text inside
        // Pattern matches: <sup fn-count-id="..."><a ... href="#footnoteId">...</a></sup>
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

                return $matches[0]; // No change
            },
            $html
        );

        return $updatedHtml ?? $html;
    }

    /**
     * Extract footnote IDs from HTML content
     * Matches href="#bookId_Fn..." or href="#bookIdFn..." patterns
     */
    private function extractFootnoteIdsFromHtml(?string $html): array
    {
        if (empty($html)) {
            return [];
        }

        $footnoteIds = [];

        // Match href="#...Fn..." pattern (captures IDs containing Fn or _Fn)
        if (preg_match_all('/href="#([^"]*(?:_Fn|Fn)[^"]*)"/', $html, $matches)) {
            foreach ($matches[1] as $id) {
                if (!in_array($id, $footnoteIds)) {
                    $footnoteIds[] = $id;
                }
            }
        }

        return $footnoteIds;
    }

    /**
     * Get node chunks for a book - matches your IndexedDB structure
     */
    private function getNodeChunks(string $bookId, array $visibleHyperlightIds): array
    {
        // Run migrations first (before loading chunks)
        $this->migrateNodeIds($bookId);
        $this->migrateNodeFootnotes($bookId);

        // Get processed highlights with is_user_highlight flag
        $processedHighlights = $this->getHyperlights($bookId);

        $highlightLookup = [];
        foreach ($processedHighlights as $highlight) {
            $highlightLookup[$highlight['hyperlight_id']] = $highlight;
        }

        // Pre-fetch ALL hyperlights and hypercites for this book (avoid N+1 queries)
        $hyperlightsByNode = $this->getAllHyperlightsByNode($bookId, $visibleHyperlightIds, $highlightLookup);
        $hypercitesByNode = $this->getAllHypercitesByNode($bookId);

        $chunks = DB::table('nodes')
            ->where('book', $bookId)
            ->orderBy('chunk_id')
            ->get()
            ->map(function ($chunk) use ($hyperlightsByNode, $hypercitesByNode) {
                $nodeUUID = $chunk->node_id;

                // Get pre-fetched annotations for this node (O(1) lookup)
                $finalHyperlights = $hyperlightsByNode[$nodeUUID] ?? [];
                $finalHypercites = $hypercitesByNode[$nodeUUID] ?? [];

                return [
                    'book' => $chunk->book,
                    'chunk_id' => (int) $chunk->chunk_id,
                    'startLine' => (float) $chunk->startLine,
                    'node_id' => $chunk->node_id,
                    'content' => $chunk->content,
                    'plainText' => $chunk->plainText,
                    'type' => $chunk->type,
                    'footnotes' => json_decode($chunk->footnotes ?? '[]', true),
                    'hypercites' => $finalHypercites,
                    'hyperlights' => array_values($finalHyperlights),
                    'raw_json' => json_decode($chunk->raw_json ?? '{}', true),
                ];
            })
            ->toArray();

        Log::info('Node chunks loaded', [
            'book' => $bookId,
            'chunks' => count($chunks),
            'highlights' => count($hyperlightsByNode),
            'hypercites' => count($hypercitesByNode)
        ]);

        return $chunks;
    }

    /**
     * Fetch ALL hyperlights for a book in one query
     * Returns array indexed by node_id for O(1) lookup
     */
    private function getAllHyperlightsByNode(string $bookId, array $visibleIds, array $lookup): array
    {
        if (empty($visibleIds)) {
            return [];
        }

        // Query all hyperlights for this book
        $hyperlights = DB::table('hyperlights')
            ->where('book', $bookId)
            ->whereIn('hyperlight_id', $visibleIds)
            ->get();

        // Group by node_id
        $byNode = [];
        foreach ($hyperlights as $hl) {
            $nodeIds = json_decode($hl->node_id ?? '[]', true);
            $charData = json_decode($hl->charData ?? '{}', true);

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;

                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'highlightID' => $hl->hyperlight_id,
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'annotation' => $hl->annotation,
                    'time_since' => $hl->time_since,
                    'hidden' => $hl->hidden ?? false,
                    'is_user_highlight' => $lookup[$hl->hyperlight_id]['is_user_highlight'] ?? false
                ];
            }
        }

        return $byNode;
    }

    /**
     * Fetch ALL hypercites for a book in one query
     * Returns array indexed by node_id for O(1) lookup
     */
    private function getAllHypercitesByNode(string $bookId): array
    {
        // Query all hypercites for this book
        $hypercites = DB::table('hypercites')
            ->where('book', $bookId)
            ->get();

        // Group by node_id
        $byNode = [];
        foreach ($hypercites as $hc) {
            $nodeIds = json_decode($hc->node_id ?? '[]', true);
            $charData = json_decode($hc->charData ?? '{}', true);

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;

                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'hyperciteId' => $hc->hyperciteId,
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'relationshipStatus' => $hc->relationshipStatus,
                    'citedIN' => json_decode($hc->citedIN ?? '[]', true),
                    'time_since' => $hc->time_since
                ];
            }
        }

        return $byNode;
    }

    /**
     * Get footnotes for a book
     */
    private function getFootnotes(string $bookId): ?array
    {
        $footnotes = DB::table('footnotes')
            ->where('book', $bookId)
            ->get();

        if ($footnotes->isEmpty()) {
            return null;
        }

        // Convert to the format expected by the frontend
        $footnotesData = [];
        foreach ($footnotes as $footnote) {
            $footnotesData[$footnote->footnoteId] = $footnote->content;
        }

        return [
            'book' => $bookId,
            'data' => $footnotesData,
        ];
    }

    /**
     * Get bibliography/references for a book
     */
    private function getBibliography(string $bookId): ?array
    {
        $references = DB::table('bibliography')
            ->where('book', $bookId)
            ->get();

        if ($references->isEmpty()) {
            return null;
        }

        // Convert to the format expected by the frontend
        $bibliographyData = [];
        foreach ($references as $reference) {
            $bibliographyData[$reference->referenceId] = $reference->content;
        }

        return [
            'book' => $bookId,
            'data' => $bibliographyData,
        ];
    }

    /**
     * Get hyperlights for a book
     */
    private function getHyperlights(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');

        Log::info('🔍 getHyperlights started', [
            'book_id' => $bookId,
            'user_id' => $user ? $user->id : null,
            'user_name' => $user ? $user->name : null,
            'is_logged_in' => !is_null($user),
            'anonymous_token' => $anonymousToken ? 'present' : 'null'
        ]);

        $hyperlights = DB::table('hyperlights')
            ->where('book', $bookId)
            ->where(function($query) use ($user, $anonymousToken) {
                $query->where('hidden', false);

                if ($user) {
                    $query->orWhere('creator', $user->name);
                }

                if ($anonymousToken) {
                    $query->orWhere('creator_token', $anonymousToken);
                }
            })
            ->orderBy('hyperlight_id')
            ->get()
            ->map(function ($hyperlight) use ($user, $anonymousToken, $bookId) {
                // Determine if this highlight belongs to the current user
                // Prioritized auth: if highlight has username (creator), ONLY use username-based auth
                $isUserHighlight = false;

                if ($hyperlight->creator) {
                    // Highlight has username - ONLY check username-based auth (ignore token)
                    $isUserHighlight = $user && $hyperlight->creator === $user->name;
                } elseif ($hyperlight->creator_token) {
                    // Highlight has no username, only token - check token-based auth
                    // This works for both anonymous users AND logged-in users who created pre-login
                    // (they still have the same anon_token cookie)
                    $isUserHighlight = $anonymousToken && $hyperlight->creator_token === $anonymousToken;
                }

                Log::info('🔍 Processing hyperlight in getHyperlights', [
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'creator' => $hyperlight->creator,
                    'creator_token' => $hyperlight->creator_token ? 'present' : 'null',
                    'current_user_name' => $user ? $user->name : 'null',
                    'current_anon_token' => $anonymousToken ? 'present' : 'null',
                    'is_user_highlight' => $isUserHighlight
                ]);

                // 🔒 SECURITY: Never expose creator_token in API responses
                // Only the owner needs to know ownership, which is indicated by is_user_highlight
                // Also sanitize raw_json to remove creator_token
                // Note: raw_json may be double-encoded (JSON string containing JSON string)
                $rawJson = json_decode($hyperlight->raw_json ?? '{}', true);
                if (is_string($rawJson)) {
                    // Double-encoded - decode again
                    $rawJson = json_decode($rawJson, true);
                }
                if (is_array($rawJson)) {
                    unset($rawJson['creator_token']);
                }

                return [
                    'book' => $hyperlight->book,
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'node_id' => json_decode($hyperlight->node_id ?? '[]', true),
                    'charData' => json_decode($hyperlight->charData ?? '{}', true),
                    'annotation' => $hyperlight->annotation,
                    'highlightedHTML' => $hyperlight->highlightedHTML,
                    'highlightedText' => $hyperlight->highlightedText,
                    'startLine' => $hyperlight->startLine,
                    'raw_json' => $rawJson,
                    'time_since' => $hyperlight->time_since,
                    'is_user_highlight' => $isUserHighlight,
                    'creator' => $hyperlight->creator,
                    // creator_token intentionally omitted - security sensitive
                ];
            })
            ->toArray();
        
        Log::info('🔍 getHyperlights completed', [
            'book_id' => $bookId,
            'total_count' => count($hyperlights),
            'user_highlights_count' => count(array_filter($hyperlights, function($h) { return $h['is_user_highlight']; })),
            'sample_highlight' => count($hyperlights) > 0 ? $hyperlights[0] : null
        ]);

        return $hyperlights;
    }

    /**
     * Get hypercites for a book
     */
    private function getHypercites(string $bookId): array
    {
        $hypercites = DB::table('hypercites')
            ->where('book', $bookId)
            ->orderBy('hyperciteId')
            ->get()
            ->map(function ($hypercite) {
                return [
                    'book' => $hypercite->book,
                    'hyperciteId' => $hypercite->hyperciteId,
                    'node_id' => json_decode($hypercite->node_id ?? '[]', true),
                    'charData' => json_decode($hypercite->charData ?? '{}', true),
                    'citedIN' => json_decode($hypercite->citedIN ?? '[]', true),
                    'hypercitedHTML' => $hypercite->hypercitedHTML,
                    'hypercitedText' => $hypercite->hypercitedText,
                    'relationshipStatus' => $hypercite->relationshipStatus,
                    'raw_json' => json_decode($hypercite->raw_json ?? '{}', true),
                ];
            })
            ->toArray();

        return $hypercites;
    }

    /**
     * Get library data for a book
     */
   private function getLibrary(string $bookId): ?array
    {
        $library = DB::table('library')
            ->where('book', $bookId)
            ->first();

        if (!$library) {
            return null;
        }

        // 🔒 SECURITY: Determine if current user owns this book
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');
        $isOwner = false;

        if ($library->creator) {
            // Book has username - check username-based auth
            $isOwner = $user && $library->creator === $user->name;
        } elseif ($library->creator_token) {
            // Book has no username, only token - check token-based auth for anonymous
            $isOwner = !$user && $anonymousToken && hash_equals($library->creator_token, $anonymousToken);
        }

        Log::info('Library record from database', [
            'book_id' => $bookId,
            'timestamp' => $library->timestamp,
            'timestamp_type' => gettype($library->timestamp),
            'creator' => $library->creator,
            'creator_token' => $library->creator_token ? 'present' : 'null',
            'is_owner' => $isOwner
        ]);

        // 🔒 SECURITY: Never expose creator_token in API responses
        // Use is_owner boolean instead so frontend knows ownership without seeing tokens
        // Also sanitize raw_json to remove creator_token
        // Note: raw_json may be double-encoded (JSON string containing JSON string)
        $rawJson = json_decode($library->raw_json ?? '{}', true);
        if (is_string($rawJson)) {
            // Double-encoded - decode again
            $rawJson = json_decode($rawJson, true);
        }
        if (is_array($rawJson)) {
            unset($rawJson['creator_token']);
        }

        return [
            'book' => $library->book,
            'author' => $library->author,
            'bibtex' => $library->bibtex,
            'fileName' => $library->fileName,
            'fileType' => $library->fileType,
            'journal' => $library->journal,
            'note' => $library->note,
            'pages' => $library->pages,
            'publisher' => $library->publisher,
            'school' => $library->school,
            'timestamp' => $library->timestamp,
            'annotations_updated_at' => $library->annotations_updated_at ?? 0,
            'title' => $library->title,
            'type' => $library->type,
            'url' => $library->url,
            'year' => $library->year,
            'creator' => $library->creator,
            // creator_token intentionally omitted - security sensitive
            'is_owner' => $isOwner,
            'visibility' => $library->visibility ?? 'public',
            'listed' => $library->listed ?? true,
            'raw_json' => $rawJson,
        ];
    }

    /**
     * Get just library data for a specific book
     */
    public function getBookLibrary(Request $request, string $bookId): JsonResponse
    {
        try {
            Log::info('getBookLibrary called', ['book_id' => $bookId]);

            // Library records (bibliographic metadata) are publicly accessible
            // even for private books, as they may be cited in public documents.
            // The privacy restriction applies to nodes (actual content), not citations.
            $libraryRecord = DB::table('library')->where('book', $bookId)->first();

            if (!$libraryRecord) {
                return response()->json([
                    'error' => 'Library record not found for book',
                    'book_id' => $bookId
                ], 404);
            }

            $library = $this->getLibrary($bookId);
            
            if (!$library) {
                return response()->json([
                    'error' => 'Library record not found for book',
                    'book_id' => $bookId
                ], 404);
            }

            Log::info('Returning library data to client', [
                'book_id' => $bookId,
                'timestamp_in_response' => $library['timestamp'] ?? 'NOT_SET',
                'full_library_array' => $library
            ]);

            return response()->json([
                'success' => true,
                'library' => $library,
                'book_id' => $bookId
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching library data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch library data'
            ], 500);
        }
    }

    /**
     * Get just metadata for cache validation
     */
    public function getBookMetadata(Request $request, string $bookId): JsonResponse
    {
        try {
            // 🔒 CRITICAL: Check book visibility and access permissions (bypasses RLS)
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            $chunkCount = DB::table('nodes')
                ->where('book', $bookId)
                ->count();

            if ($chunkCount === 0) {
                return response()->json([
                    'error' => 'Book not found'
                ], 404);
            }

            $latestUpdate = DB::table('nodes')
                ->where('book', $bookId)
                ->max('updated_at');

            return response()->json([
                'book_id' => $bookId,
                'chunk_count' => $chunkCount,
                'last_modified' => $latestUpdate,
                'exists' => true,
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching book metadata', [
                'book_id' => $bookId,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }
    }

    /**
     * Get list of available books
     * SECURITY: Only returns public books, or private books owned by the current user
     */
    public function getAvailableBooks(Request $request): JsonResponse
    {
        try {
            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            // Build query with visibility filtering
            $query = DB::table('nodes')
                ->join('library', 'nodes.book', '=', 'library.book')
                ->select('nodes.book')
                ->selectRaw('COUNT(*) as chunk_count')
                ->selectRaw('MAX(nodes.updated_at) as last_modified')
                ->where(function ($q) use ($user, $anonymousToken) {
                    // Public books are visible to everyone
                    $q->where('library.visibility', 'public');

                    // Private books visible only to owner
                    if ($user) {
                        $q->orWhere(function ($sub) use ($user) {
                            $sub->where('library.visibility', 'private')
                                ->where('library.creator', $user->name);
                        });
                    }

                    // Anonymous users can see their own private books via token
                    if ($anonymousToken) {
                        $q->orWhere(function ($sub) use ($anonymousToken) {
                            $sub->where('library.visibility', 'private')
                                ->where('library.creator_token', $anonymousToken);
                        });
                    }
                })
                // Exclude deleted books
                ->where('library.visibility', '!=', 'deleted')
                ->groupBy('nodes.book')
                ->orderBy('nodes.book');

            $books = $query->get();

            return response()->json([
                'books' => $books->toArray(),
                'total_books' => $books->count(),
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching available books', [
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }
    }
}