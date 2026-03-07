<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Http\Controllers\Concerns\SubBookPreviewTrait;
use App\Models\PgHyperlight;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;

class DbNodeChunkController extends Controller
{
    use SubBookPreviewTrait;

    /**
     * Permission check for sub-book (slash-ID) node updates.
     *
     * All nodes — regular books, footnotes, and hyperlight annotations — are stored
     * in the same nodes table. Footnotes and hyperlights are treated as "sub-books"
     * whose book ID is a slash-delimited string identifying the parent and the item,
     * e.g. "booka/HL_abc123" or "booka/Fn_abc123".
     *
     * Ownership rules differ by type:
     *   - Hyperlight annotations: owned by whoever created the highlight (may not be
     *     the book owner — any user can annotate a public book).
     *   - Footnotes: owned by whoever owns the parent book.
     */
    private function checkSubBookPermission(Request $request, string $bookId): bool
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // Try hyperlight first — sub_book_id matches nodes.book directly
        $hyperlight = PgHyperlight::where('sub_book_id', $bookId)->first();

        if ($hyperlight) {
            if ($user && $hyperlight->creator) {
                return $hyperlight->creator === $user->name;
            }
            if (! $user && $hyperlight->creator_token && $anonymousToken) {
                return $hyperlight->creator_token === $anonymousToken;
            }

            return false;
        }

        // Fall back to parent book ownership (footnote path)
        $parsed = SubBookIdHelper::parse($bookId);
        $parentBook = $parsed['foundation'];

        $library = PgLibrary::where('book', $parentBook)->first();
        if (! $library) {
            Log::warning('Sub-book permission denied: parent book not found', [
                'bookId' => $bookId, 'parentBook' => $parentBook,
            ]);

            return false;
        }

        if ($user && $library->creator) {
            return $library->creator === $user->name;
        }
        if (! $user && $library->creator_token && $anonymousToken) {
            return $library->creator_token === $anonymousToken;
        }

        return false;
    }

    /**
     * This function uploads all nodes to nodes table. This includes nodes for regular
     * books, footnotes and hyperlight annotations. These are all stored as "books",
     * but in strings that indicate their parent. For example a highlight in booka
     * is itself booka/highlight_id.
     * (Authorization only - Authentication is handled by middleware)
     */
    private function checkBookPermission(Request $request, $bookId)
    {
        // Sub-book IDs (e.g. "book_xxx/Fn_xxx") use item-specific ownership rules
        if (str_contains($bookId, '/')) {
            return $this->checkSubBookPermission($request, $bookId);
        }

        $user = Auth::user();

        if ($user) {
            // Logged in user - check they own the book
            $book = PgLibrary::where('book', $bookId)
                ->where('creator', $user->name)
                ->first();

            if (! $book) {
                Log::warning('Book access denied for logged-in user', [
                    'book' => $bookId,
                    'user' => $user->name,
                    'reason' => 'book_not_owned',
                ]);

                return false;
            }

            Log::debug('Book access granted for logged-in user', [
                'book' => $bookId,
                'user' => $user->name,
            ]);

            return true;

        } else {
            // Anonymous user - middleware already validated the token
            // Just check if book belongs to this anonymous token
            $anonymousToken = $request->cookie('anon_token');

            // Token existence already validated by middleware, so we can trust it
            $book = PgLibrary::where('book', $bookId)
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator') // Make sure it's not owned by a logged-in user
                ->first();

            if (! $book) {
                Log::warning('Book access denied for anonymous user', [
                    'book' => $bookId,
                    'reason' => 'book_not_owned_by_token',
                ]);

                return false;
            }

            Log::debug('Book access granted for anonymous user', [
                'book' => $bookId,
            ]);

            return true;
        }
    }

    /**
     * Check if the update is only for public fields (hyperlights/hypercites)
     */
    private function isPublicFieldsOnlyUpdate($item)
    {
        $publicFields = ['hyperlights', 'hypercites', 'book', 'startLine'];
        $itemKeys = array_keys($item);

        // Remove special action fields
        $itemKeys = array_filter($itemKeys, function ($key) {
            return ! str_starts_with($key, '_');
        });

        $nonPublicFieldsWithValues = [];

        // Check if all fields are either public fields or null/empty
        foreach ($itemKeys as $key) {
            if (! in_array($key, $publicFields) && ! empty($item[$key])) {
                $nonPublicFieldsWithValues[$key] = $item[$key];
            }
        }

        $isPublicOnly = empty($nonPublicFieldsWithValues);

        Log::debug('Public fields check', [
            'is_public_only' => $isPublicOnly,
            'non_public_fields' => array_keys($nonPublicFieldsWithValues),
        ]);

        return $isPublicOnly;
    }

    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();

            Log::info('Bulk create started', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data)),
            ]);

            $bookId = $data['book'] ?? null;
            if (! $bookId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book ID is required',
                ], 400);
            }

            // Check book ownership permissions
            if (! $this->checkBookPermission($request, $bookId)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied',
                ], 403);
            }

            if (isset($data['data']) && is_array($data['data'])) {
                $records = [];

                foreach ($data['data'] as $item) {
                    $records[] = [
                        'book' => $item['book'] ?? null,
                        'chunk_id' => $item['chunk_id'] ?? 0,
                        'startLine' => $item['startLine'] ?? null,
                        'node_id' => $item['node_id'] ?? null,
                        'content' => $item['content'] ?? null,
                        'footnotes' => json_encode($item['footnotes'] ?? []),
                        // 🔄 NEW SYSTEM: Don't touch hypercites/hyperlights columns - leave existing data intact
                        // 'hypercites' and 'hyperlights' columns intentionally omitted
                        'plainText' => $item['plainText'] ?? null,
                        'type' => $item['type'] ?? null,
                        'raw_json' => json_encode($this->cleanItemForStorage($item)),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                }

                PgNodeChunk::insert($records);

                Log::info('Bulk create completed', [
                    'book' => $bookId,
                    'records_inserted' => count($records),
                ]);

                // Update preview_nodes for sub-books (best-effort, don't fail the request)
                if (str_contains($bookId, '/')) {
                    try {
                        $this->updateSubBookPreviewNodes($bookId);
                    } catch (\Exception $e) {
                        Log::warning('preview_nodes update failed (non-fatal)', [
                            'book' => $bookId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }

                return response()->json(['success' => true]);
            }

            return response()->json([
                'success' => false,
                'message' => 'Invalid data format',
            ], 400);

        } catch (\Exception $e) {
            Log::error('Bulk create failed', [
                'error' => $e->getMessage(),
                'book' => $data['book'] ?? 'unknown',
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    public function upsert(Request $request)
    {
        try {
            $data = $request->all();

            Log::info('Upsert started', [
                'book' => $data['book'] ?? 'not_specified',
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data)),
            ]);

            $book = $data['book'] ?? null;
            if (! $book) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book name is required',
                ], 400);
            }

            // Check book ownership permissions
            if (! $this->checkBookPermission($request, $book)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied',
                ], 403);
            }

            if (isset($data['data']) && is_array($data['data'])) {
                // SYNC AUDIT: This is the NUCLEAR upsert - deletes ALL nodes then re-inserts
                $deletedCount = PgNodeChunk::where('book', $book)->count();
                Log::channel('sync_audit')->warning('NUCLEAR_UPSERT', [
                    'book' => $book,
                    'existing_nodes_being_deleted' => $deletedCount,
                    'incoming_nodes' => count($data['data']),
                    'caller' => debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 3),
                ]);
                PgNodeChunk::where('book', $book)->delete();

                $records = [];
                foreach ($data['data'] as $item) {
                    $records[] = [
                        'book' => $item['book'] ?? $book,
                        'chunk_id' => $item['chunk_id'] ?? 0,
                        'startLine' => $item['startLine'] ?? null,
                        'node_id' => $item['node_id'] ?? null,
                        'content' => $item['content'] ?? null,
                        'footnotes' => json_encode($item['footnotes'] ?? []),
                        // 🔄 NEW SYSTEM: Don't touch hypercites/hyperlights columns - leave existing data intact
                        // 'hypercites' and 'hyperlights' columns intentionally omitted
                        'plainText' => $item['plainText'] ?? null,
                        'type' => $item['type'] ?? null,
                        'raw_json' => json_encode($this->cleanItemForStorage($item)),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                }

                // Bulk insert all records at once
                PgNodeChunk::insert($records);

                Log::info('Upsert completed', [
                    'book' => $book,
                    'records_inserted' => count($records),
                    'records_deleted' => $deletedCount,
                ]);

                // Update preview_nodes for sub-books (best-effort, don't fail the request)
                if (str_contains($book, '/')) {
                    try {
                        $this->updateSubBookPreviewNodes($book);
                    } catch (\Exception $e) {
                        Log::warning('preview_nodes update failed (non-fatal)', [
                            'book' => $book,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }

                return response()->json([
                    'success' => true,
                    'message' => "Node chunks synced successfully for book: {$book}",
                ]);
            }

            return response()->json([
                'success' => false,
                'message' => 'Invalid data format',
            ], 400);

        } catch (\Exception $e) {
            Log::error('Upsert failed', [
                'error' => $e->getMessage(),
                'book' => $data['book'] ?? 'unknown',
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    // In app/Http/Controllers/DbNodeChunkController.php

    // In app/Http/Controllers/DbNodeChunkController.php

    // In app/Http/Controllers/DbNodeChunkController.php

    // In app/Http/Controllers/DbNodeChunkController.php

    public function targetedUpsert(Request $request)
    {
        try {
            $data = $request->all();

            if (! isset($data['data']) || ! is_array($data['data']) || empty($data['data'])) {
                return response()->json(['success' => false, 'message' => 'Invalid data format'], 400);
            }

            // Group items by book to handle multi-book updates (e.g., hypercite delinks)
            $itemsByBook = [];
            foreach ($data['data'] as $item) {
                $book = $item['book'] ?? null;
                if (! $book) {
                    Log::warning('Skipping item without book ID', ['item' => $item]);

                    continue;
                }

                if (! isset($itemsByBook[$book])) {
                    $itemsByBook[$book] = [];
                }
                $itemsByBook[$book][] = $item;
            }

            Log::info('Targeted upsert processing', [
                'books' => array_keys($itemsByBook),
                'total_items' => count($data['data']),
            ]);

            // Process each book's items
            foreach ($itemsByBook as $bookId => $items) {
                $hasPermission = $this->checkBookPermission($request, $bookId);

                Log::info('Targeted upsert permissions check', [
                    'book' => $bookId,
                    'user_has_ownership_permission' => $hasPermission,
                    'items_count' => count($items),
                ]);

                foreach ($items as $item) {

                    if (isset($item['_action']) && $item['_action'] === 'delete') {
                        if ($hasPermission) {
                            PgNodeChunk::where('book', $item['book'])->where('startLine', $item['startLine'])->delete();
                        }

                        continue;
                    }

                    // Try to find by node_id first (for renumbering support)
                    // If node_id exists, it's the authoritative identifier
                    $existingChunk = null;
                    if (! empty($item['node_id'])) {
                        $existingChunk = PgNodeChunk::where('book', $item['book'])
                            ->where('node_id', $item['node_id'])
                            ->first();
                    }

                    // Fall back to startLine lookup (for backwards compatibility)
                    if (! $existingChunk) {
                        $existingChunk = PgNodeChunk::where('book', $item['book'])
                            ->where('startLine', $item['startLine'])
                            ->first();
                    }

                    Log::debug('Existing chunk loaded', [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                        'exists' => $existingChunk !== null,
                        'hypercites_raw' => $existingChunk ? $existingChunk->getAttributes()['hypercites'] ?? 'NULL_ATTR' : 'NO_CHUNK',
                        'hypercites_cast' => $existingChunk ? $existingChunk->hypercites : 'NO_CHUNK',
                    ]);

                    // --- REVISED LOGIC ---

                    $updateData = [];
                    // For owners, prepare all possible updatable fields.
                    if ($hasPermission) {
                        $updateData = [
                            'chunk_id' => $item['chunk_id'] ?? ($existingChunk ? $existingChunk->chunk_id : 0),
                            'node_id' => $item['node_id'] ?? ($existingChunk ? $existingChunk->node_id : null),
                            'content' => $item['content'] ?? ($existingChunk ? $existingChunk->content : null),
                            'footnotes' => $item['footnotes'] ?? ($existingChunk ? $existingChunk->footnotes : []),
                            'plainText' => $item['plainText'] ?? ($existingChunk ? $existingChunk->plainText : null),
                            'type' => $item['type'] ?? ($existingChunk ? $existingChunk->type : null),
                        ];
                    }

                    // 🔄 OLD SYSTEM: Safely merge hyperlights (for ALL users to prevent data loss).
                    // COMMENTED OUT - NEW SYSTEM uses normalized hyperlights table
                    /*
                    $dbHighlights = $existingChunk->hyperlights ?? []; // Eloquent casts this to a PHP array
                    $clientHighlights = $item['hyperlights'] ?? [];

                    // Use highlightID as a key for merging to prevent duplicates and handle updates.
                    $mergedHighlightsMap = array_reduce($dbHighlights, function ($carry, $highlight) {
                        if (!empty($highlight['highlightID'])) {
                            $carry[$highlight['highlightID']] = $highlight;
                        }
                        return $carry;
                    }, []);

                    foreach ($clientHighlights as $clientHighlight) {
                        unset($clientHighlight['is_user_highlight']);
                        if (empty($clientHighlight['highlightID'])) continue;

                        if (isset($clientHighlight['_deleted']) && $clientHighlight['_deleted'] === true) {
                            unset($mergedHighlightsMap[$clientHighlight['highlightID']]);
                        } else {
                            $mergedHighlightsMap[$clientHighlight['highlightID']] = $clientHighlight;
                        }
                    }

                    // The final PHP array of highlights.
                    $finalMergedHighlights = array_values($mergedHighlightsMap);

                    // Assign the PHP arrays directly to the update payload. Eloquent will handle encoding.
                    $updateData['hyperlights'] = $finalMergedHighlights;
                    */

                    // 🔄 NEW SYSTEM: Don't touch hyperlights column - leave existing data intact
                    // 'hyperlights' intentionally not added to $updateData

                    // 🔄 OLD SYSTEM: DEBUG logs and assignment for hypercites
                    // COMMENTED OUT - NEW SYSTEM uses normalized hypercites table
                    /*
                    // DEBUG: Log hypercites update
                    Log::debug('Hypercites update debug', [
                        'startLine' => $item['startLine'],
                        'incoming_hypercites' => $item['hypercites'] ?? 'NOT_SET',
                        'existing_hypercites' => $existingChunk->hypercites ?? 'NOT_SET',
                        'incoming_is_set' => isset($item['hypercites']),
                        'incoming_is_array' => isset($item['hypercites']) ? is_array($item['hypercites']) : false,
                        'incoming_count' => isset($item['hypercites']) && is_array($item['hypercites']) ? count($item['hypercites']) : 'N/A'
                    ]);

                    $updateData['hypercites'] = $item['hypercites'] ?? ($existingChunk->hypercites ?? []);

                    Log::debug('Hypercites final value', [
                        'startLine' => $item['startLine'],
                        'final_hypercites' => $updateData['hypercites'],
                        'final_count' => is_array($updateData['hypercites']) ? count($updateData['hypercites']) : 'NOT_ARRAY'
                    ]);
                    */

                    // 🔄 NEW SYSTEM: Don't touch hypercites column - leave existing data intact
                    // 'hypercites' intentionally not added to $updateData

                    // Rebuild the raw_json field with the most up-to-date, merged data.
                    $rawJson = $existingChunk->raw_json ?? $this->cleanItemForStorage($item);

                    // Ensure $rawJson is an array (in case cast didn't work or old data exists)
                    if (is_string($rawJson)) {
                        $rawJson = json_decode($rawJson, true) ?? [];
                    }
                    if (! is_array($rawJson)) {
                        $rawJson = [];
                    }

                    // Overwrite the raw_json fields with our authoritative, merged data.
                    // array_merge will combine the base data with our specific updates.
                    $rawJson = array_merge($rawJson, $updateData);

                    // Assign the final PHP array for raw_json. Eloquent will handle encoding.
                    $updateData['raw_json'] = $this->cleanItemForStorage($rawJson);

                    // --- END REVISED LOGIC ---

                    $updateData['updated_at'] = now();

                    Log::debug('About to save/update', [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                        'node_id' => $item['node_id'] ?? 'none',
                        'existing_found_by' => $existingChunk ? 'node_id or startLine' : 'none',
                        'updateData_keys' => array_keys($updateData),
                        // 🔄 NEW SYSTEM: hypercites/hyperlights no longer in $updateData
                        // 'updateData_hypercites' => $updateData['hypercites']
                    ]);

                    // If we found existing chunk (by node_id or startLine), update it
                    // This handles renumbering: node_id stays same, startLine changes
                    if ($existingChunk) {
                        // Update all fields including startLine
                        $existingChunk->fill($updateData);
                        $existingChunk->startLine = $item['startLine']; // Explicitly update startLine
                        $existingChunk->save();
                        $result = $existingChunk;
                    } else {
                        // Create new record - always include required NOT NULL fields
                        $result = PgNodeChunk::create(array_merge(
                            [
                                'book' => $item['book'],
                                'startLine' => $item['startLine'],
                                'chunk_id' => $item['chunk_id'] ?? 0,  // Required NOT NULL field
                                'content' => $item['content'] ?? '',    // Required NOT NULL field
                                'node_id' => $item['node_id'] ?? null,
                            ],
                            $updateData
                        ));
                    }

                    Log::debug('After updateOrCreate', [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                        'saved_hypercites' => $result->hypercites,
                        'saved_hypercites_count' => is_array($result->hypercites) ? count($result->hypercites) : 'NOT_ARRAY',
                    ]);
                }
            }

            // Update preview_nodes for any sub-books that were modified
            foreach (array_keys($itemsByBook) as $processedBookId) {
                if (str_contains($processedBookId, '/')) {
                    try {
                        $this->updateSubBookPreviewNodes($processedBookId);
                    } catch (\Exception $e) {
                        Log::warning('preview_nodes update failed (non-fatal)', [
                            'book' => $processedBookId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }
            }

            Log::info('Targeted upsert completed successfully');

            return response()->json(['success' => true, 'message' => 'Node chunks updated successfully (targeted)']);

        } catch (\Exception $e) {
            Log::error('Targeted upsert failed', [
                'error' => $e->getMessage(),
                'book' => $data['data'][0]['book'] ?? 'unknown',
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json(['success' => false, 'message' => 'Failed to sync data (targeted)', 'error' => $e->getMessage()], 500);
        }
    }

    /**
     * Get highlights that should be hidden from the current user but preserved in the node
     */
    private function getHiddenHighlightsForNode($bookId, $existingHighlights, Request $request)
    {
        if (empty($existingHighlights)) {
            return [];
        }

        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        $hiddenHighlights = [];

        foreach ($existingHighlights as $highlight) {
            $highlightId = $highlight['highlightID'] ?? null;
            if (! $highlightId) {
                continue;
            }

            // Check if this highlight should be hidden from current user
            $hyperlightRecord = PgHyperlight::where('book', $bookId)
                ->where('hyperlight_id', $highlightId)
                ->first();

            if (! $hyperlightRecord) {
                continue;
            }

            $shouldHide = false;

            // If highlight is marked as hidden
            if ($hyperlightRecord->hidden) {
                // Only show to the creator of the highlight
                if ($user) {
                    $shouldHide = ($hyperlightRecord->creator !== $user->name);
                } else {
                    $shouldHide = ($hyperlightRecord->creator_token !== $anonymousToken);
                }
            }

            if ($shouldHide) {
                $hiddenHighlights[] = $highlight;
            }
        }

        return $hiddenHighlights;
    }

    private function cleanItemForStorage($item)
    {
        // Create a copy to avoid modifying the original
        $cleanItem = $item;

        // Remove the raw_json field to prevent recursive nesting
        unset($cleanItem['raw_json']);

        // Also remove any other potentially problematic nested fields
        if (isset($cleanItem['full_library_array'])) {
            unset($cleanItem['full_library_array']);
        }

        return $cleanItem;
    }

    /**
     * Optimized bulk targeted upsert - replaces per-item loop with batch operations
     * Reduces 300+ queries to 3-5 queries for 150+ nodes
     */
    public function bulkTargetedUpsert(Request $request)
    {
        try {
            $data = $request->all();

            if (! isset($data['data']) || ! is_array($data['data']) || empty($data['data'])) {
                return response()->json(['success' => false, 'message' => 'Invalid data format'], 400);
            }

            // Group items by book
            $itemsByBook = [];
            foreach ($data['data'] as $item) {
                $book = $item['book'] ?? null;
                if (! $book) {
                    Log::warning('Skipping item without book ID', ['item' => $item]);

                    continue;
                }
                if (! isset($itemsByBook[$book])) {
                    $itemsByBook[$book] = [];
                }
                $itemsByBook[$book][] = $item;
            }

            Log::info('Bulk targeted upsert processing', [
                'books' => array_keys($itemsByBook),
                'total_items' => count($data['data']),
            ]);

            $totalDeleted = 0;
            $totalUpserted = 0;

            foreach ($itemsByBook as $bookId => $items) {
                $hasPermission = $this->checkBookPermission($request, $bookId);

                if (! $hasPermission) {
                    Log::warning("Permission denied for book {$bookId}");

                    continue;
                }

                // Separate deletes from upserts
                $toDelete = [];
                $toUpsert = [];

                foreach ($items as $item) {
                    if (isset($item['_action']) && $item['_action'] === 'delete') {
                        $toDelete[] = $item;
                    } else {
                        $toUpsert[] = $item;
                    }
                }

                // SYNC AUDIT: Snapshot before mutations
                $beforeCount = PgNodeChunk::where('book', $bookId)->count();
                Log::channel('sync_audit')->info('SYNC_START', [
                    'book' => $bookId,
                    'existing_nodes' => $beforeCount,
                    'incoming_deletes' => count($toDelete),
                    'incoming_upserts' => count($toUpsert),
                    'delete_startLines' => array_column($toDelete, 'startLine'),
                    'upsert_startLines' => array_column($toUpsert, 'startLine'),
                ]);

                // Phase 1: Batch delete (single query)
                if (! empty($toDelete)) {
                    $deleted = $this->batchDelete($bookId, $toDelete);
                    $totalDeleted += $deleted;
                }

                // Phase 2: Batch upsert
                if (! empty($toUpsert)) {
                    $upserted = $this->batchUpsert($bookId, $toUpsert);
                    $totalUpserted += $upserted;
                }

                // SYNC AUDIT: Snapshot after mutations
                $afterCount = PgNodeChunk::where('book', $bookId)->count();
                $delta = $afterCount - $beforeCount;
                Log::channel('sync_audit')->info('SYNC_DONE', [
                    'book' => $bookId,
                    'before' => $beforeCount,
                    'after' => $afterCount,
                    'delta' => $delta,
                    'deleted' => $totalDeleted,
                    'upserted' => $totalUpserted,
                ]);

                if ($delta < -1) {
                    Log::channel('sync_audit')->warning('SYNC_SUSPICIOUS: Net node loss > 1', [
                        'book' => $bookId,
                        'before' => $beforeCount,
                        'after' => $afterCount,
                        'delta' => $delta,
                    ]);
                }

                // Update preview_nodes for sub-books (best-effort, don't fail the request)
                if (str_contains($bookId, '/')) {
                    try {
                        $this->updateSubBookPreviewNodes($bookId);
                    } catch (\Exception $e) {
                        Log::warning('preview_nodes update failed (non-fatal)', [
                            'book' => $bookId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }
            }

            Log::info('Bulk targeted upsert completed', [
                'deleted' => $totalDeleted,
                'upserted' => $totalUpserted,
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Node chunks updated successfully (bulk)',
                'deleted' => $totalDeleted,
                'upserted' => $totalUpserted,
            ]);

        } catch (\Exception $e) {
            Log::error('Bulk targeted upsert failed', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data (bulk)',
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    /**
     * Batch delete nodes by startLine - single query instead of N queries
     */
    private function batchDelete(string $bookId, array $items): int
    {
        if (empty($items)) {
            return 0;
        }

        $startLines = array_column($items, 'startLine');

        // SYNC AUDIT: Log what we're about to delete BEFORE deleting
        $victims = \DB::table('nodes')
            ->where('book', $bookId)
            ->whereIn('startLine', $startLines)
            ->select('startLine', 'node_id', \DB::raw('LEFT(content, 80) as content_preview'))
            ->get();

        Log::channel('sync_audit')->info('DELETE_NODES', [
            'book' => $bookId,
            'requested_startLines' => $startLines,
            'found_count' => $victims->count(),
            'victims' => $victims->toArray(),
        ]);

        $deleted = \DB::table('nodes')
            ->where('book', $bookId)
            ->whereIn('startLine', $startLines)
            ->delete();

        return $deleted;
    }

    /**
     * Batch upsert nodes - handles dual-lookup (node_id first, then startLine fallback)
     */
    private function batchUpsert(string $bookId, array $items): int
    {
        if (empty($items)) {
            return 0;
        }

        // Separate items with node_id from those without
        $withNodeId = array_values(array_filter($items, fn ($item) => ! empty($item['node_id'])));
        $withoutNodeId = array_values(array_filter($items, fn ($item) => empty($item['node_id'])));

        $count = 0;

        // Phase 1: Upsert records WITH node_id (conflict on book + node_id)
        if (! empty($withNodeId)) {
            $count += $this->batchUpsertByNodeId($bookId, $withNodeId);
        }

        // Phase 2: Upsert records WITHOUT node_id (conflict on book + startLine)
        if (! empty($withoutNodeId)) {
            $count += $this->batchUpsertByStartLine($bookId, $withoutNodeId);
        }

        return $count;
    }

    /**
     * Upsert records using node_id as the conflict target
     * Uses raw SQL for true PostgreSQL UPSERT
     */
    private function batchUpsertByNodeId(string $bookId, array $items): int
    {
        if (empty($items)) {
            return 0;
        }

        // Pre-clear conflicting startLines (different node_ids claiming same startLine)
        // This handles undo scenarios where restored nodes need their original startLines back
        $startLines = [];
        $nodeIds = [];
        foreach ($items as $item) {
            if (isset($item['startLine']) && $item['startLine'] !== null) {
                $startLines[] = $item['startLine'];
            }
            if (isset($item['node_id']) && $item['node_id'] !== null) {
                $nodeIds[] = $item['node_id'];
            }
        }

        // Pre-clear orphaned rows (different node_ids claiming same startLine)
        // This handles edge cases like undo scenarios where restored nodes need their original startLines
        // Note: The (book, startLine) unique constraint is DEFERRABLE INITIALLY DEFERRED,
        // so bulk updates can temporarily have duplicates - uniqueness is checked at commit.
        if (! empty($startLines) && ! empty($nodeIds)) {
            // SYNC AUDIT: Query what will be pre-cleared BEFORE deleting
            $preClearVictims = \DB::table('nodes')
                ->where('book', $bookId)
                ->whereIn('startLine', $startLines)
                ->where(function ($q) use ($nodeIds) {
                    $q->whereNull('node_id')
                        ->orWhereNotIn('node_id', $nodeIds);
                })
                ->select('startLine', 'node_id', \DB::raw('LEFT(content, 80) as content_preview'))
                ->get();

            if ($preClearVictims->isNotEmpty()) {
                Log::channel('sync_audit')->warning('PRE_CLEAR_DELETE', [
                    'book' => $bookId,
                    'reason' => 'Conflicting startLines owned by different node_ids',
                    'victims' => $preClearVictims->toArray(),
                    'incoming_node_ids' => $nodeIds,
                ]);
            }

            $startLinePlaceholders = implode(',', array_fill(0, count($startLines), '?'));
            $nodeIdPlaceholders = implode(',', array_fill(0, count($nodeIds), '?'));

            $deleteSql = "
                DELETE FROM nodes
                WHERE book = ?
                AND \"startLine\" IN ($startLinePlaceholders)
                AND (node_id IS NULL OR node_id NOT IN ($nodeIdPlaceholders))
            ";

            $deleteBindings = array_merge([$bookId], $startLines, $nodeIds);
            $deleted = \DB::delete($deleteSql, $deleteBindings);

            if ($deleted > 0) {
                Log::channel('sync_audit')->info('PRE_CLEAR_RESULT', [
                    'book' => $bookId,
                    'deleted_count' => $deleted,
                ]);
            }
        }

        $now = now()->format('Y-m-d H:i:s');
        $values = [];
        $bindings = [];

        foreach ($items as $item) {
            $values[] = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
            $bindings[] = $bookId;
            $bindings[] = $item['node_id'];
            $bindings[] = $item['startLine'] ?? null;
            $bindings[] = $item['chunk_id'] ?? 0;
            $bindings[] = $item['content'] ?? null;
            $bindings[] = json_encode($item['footnotes'] ?? []);
            $bindings[] = $item['plainText'] ?? null;
            $bindings[] = $item['type'] ?? null;
            $bindings[] = json_encode($this->cleanItemForStorage($item));
            $bindings[] = $now;
            $bindings[] = $now;
        }

        $sql = '
            INSERT INTO nodes (book, node_id, "startLine", chunk_id, content, footnotes, "plainText", type, raw_json, created_at, updated_at)
            VALUES '.implode(', ', $values).'
            ON CONFLICT (book, node_id) WHERE node_id IS NOT NULL
            DO UPDATE SET
                "startLine" = EXCLUDED."startLine",
                chunk_id = EXCLUDED.chunk_id,
                content = EXCLUDED.content,
                footnotes = EXCLUDED.footnotes,
                "plainText" = EXCLUDED."plainText",
                type = EXCLUDED.type,
                raw_json = EXCLUDED.raw_json,
                updated_at = EXCLUDED.updated_at
        ';

        \DB::statement($sql, $bindings);

        Log::debug('Batch upserted '.count($items).' nodes by node_id', ['book' => $bookId]);

        return count($items);
    }

    /**
     * Upsert records using startLine as the conflict target (fallback for records without node_id)
     */
    private function batchUpsertByStartLine(string $bookId, array $items): int
    {
        if (empty($items)) {
            return 0;
        }

        $now = now()->format('Y-m-d H:i:s');
        $values = [];
        $bindings = [];

        foreach ($items as $item) {
            $values[] = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
            $bindings[] = $bookId;
            $bindings[] = $item['node_id'] ?? null;
            $bindings[] = $item['startLine'] ?? null;
            $bindings[] = $item['chunk_id'] ?? 0;
            $bindings[] = $item['content'] ?? null;
            $bindings[] = json_encode($item['footnotes'] ?? []);
            $bindings[] = $item['plainText'] ?? null;
            $bindings[] = $item['type'] ?? null;
            $bindings[] = json_encode($this->cleanItemForStorage($item));
            $bindings[] = $now;
            $bindings[] = $now;
        }

        $sql = '
            INSERT INTO nodes (book, node_id, "startLine", chunk_id, content, footnotes, "plainText", type, raw_json, created_at, updated_at)
            VALUES '.implode(', ', $values).'
            ON CONFLICT (book, "startLine")
            DO UPDATE SET
                node_id = COALESCE(EXCLUDED.node_id, nodes.node_id),
                chunk_id = EXCLUDED.chunk_id,
                content = EXCLUDED.content,
                footnotes = EXCLUDED.footnotes,
                "plainText" = EXCLUDED."plainText",
                type = EXCLUDED.type,
                raw_json = EXCLUDED.raw_json,
                updated_at = EXCLUDED.updated_at
        ';

        \DB::statement($sql, $bindings);

        Log::debug('Batch upserted '.count($items).' nodes by startLine', ['book' => $bookId]);

        return count($items);
    }
}
