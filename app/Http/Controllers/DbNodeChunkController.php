<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use App\Models\PgLibrary;
use App\Models\PgHyperlight;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DbNodeChunkController extends Controller
{
    /**
     * Check if user has permission to modify the book
     * (Authorization only - Authentication is handled by middleware)
     */
    private function checkBookPermission(Request $request, $bookId)
    {
        $user = Auth::user();
        
        if ($user) {
            // Logged in user - check they own the book
            $book = PgLibrary::where('book', $bookId)
                ->where('creator', $user->name)
                ->first();
                
            if (!$book) {
                Log::warning('Book access denied for logged-in user', [
                    'book' => $bookId,
                    'user' => $user->name,
                    'reason' => 'book_not_owned'
                ]);
                return false;
            }
            
            Log::debug('Book access granted for logged-in user', [
                'book' => $bookId,
                'user' => $user->name
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
                
            if (!$book) {
                Log::warning('Book access denied for anonymous user', [
                    'book' => $bookId,
                    'reason' => 'book_not_owned_by_token'
                ]);
                return false;
            }
            
            Log::debug('Book access granted for anonymous user', [
                'book' => $bookId
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
        $itemKeys = array_filter($itemKeys, function($key) {
            return !str_starts_with($key, '_');
        });
        
        $nonPublicFieldsWithValues = [];
        
        // Check if all fields are either public fields or null/empty
        foreach ($itemKeys as $key) {
            if (!in_array($key, $publicFields) && !empty($item[$key])) {
                $nonPublicFieldsWithValues[$key] = $item[$key];
            }
        }
        
        $isPublicOnly = empty($nonPublicFieldsWithValues);
        
        Log::debug('Public fields check', [
            'is_public_only' => $isPublicOnly,
            'non_public_fields' => array_keys($nonPublicFieldsWithValues)
        ]);
        
        return $isPublicOnly;
    }

    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('Bulk create started', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            $bookId = $data['book'] ?? null;
            if (!$bookId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book ID is required'
                ], 400);
            }
            
            // Check book ownership permissions
            if (!$this->checkBookPermission($request, $bookId)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied'
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
                        'hypercites' => json_encode($item['hypercites'] ?? []),
                        'hyperlights' => json_encode($item['hyperlights'] ?? []),
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
                    'records_inserted' => count($records)
                ]);
                
                return response()->json(['success' => true]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('Bulk create failed', [
                'error' => $e->getMessage(),
                'book' => $data['book'] ?? 'unknown'
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
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
                'request_size' => strlen(json_encode($data))
            ]);
            
            $book = $data['book'] ?? null;
            if (!$book) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book name is required'
                ], 400);
            }
            
            // Check book ownership permissions
            if (!$this->checkBookPermission($request, $book)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied'
                ], 403);
            }
            
            if (isset($data['data']) && is_array($data['data'])) {
                // Clear existing data only for this specific book
                $deletedCount = PgNodeChunk::where('book', $book)->count();
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
                        'hypercites' => json_encode($item['hypercites'] ?? []),
                        'hyperlights' => json_encode($item['hyperlights'] ?? []),
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
                    'records_deleted' => $deletedCount
                ]);
                
                return response()->json([
                    'success' => true, 
                    'message' => "Node chunks synced successfully for book: {$book}"
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('Upsert failed', [
                'error' => $e->getMessage(),
                'book' => $data['book'] ?? 'unknown'
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
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

        if (!isset($data['data']) || !is_array($data['data']) || empty($data['data'])) {
            return response()->json(['success' => false, 'message' => 'Invalid data format'], 400);
        }

        // Group items by book to handle multi-book updates (e.g., hypercite delinks)
        $itemsByBook = [];
        foreach ($data['data'] as $item) {
            $book = $item['book'] ?? null;
            if (!$book) {
                Log::warning('Skipping item without book ID', ['item' => $item]);
                continue;
            }

            if (!isset($itemsByBook[$book])) {
                $itemsByBook[$book] = [];
            }
            $itemsByBook[$book][] = $item;
        }

        Log::info('Targeted upsert processing', [
            'books' => array_keys($itemsByBook),
            'total_items' => count($data['data'])
        ]);

        // Process each book's items
        foreach ($itemsByBook as $bookId => $items) {
            $hasPermission = $this->checkBookPermission($request, $bookId);

            Log::info('Targeted upsert permissions check', [
                'book' => $bookId,
                'user_has_ownership_permission' => $hasPermission,
                'items_count' => count($items)
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
            if (!empty($item['node_id'])) {
                $existingChunk = PgNodeChunk::where('book', $item['book'])
                    ->where('node_id', $item['node_id'])
                    ->first();
            }

            // Fall back to startLine lookup (for backwards compatibility)
            if (!$existingChunk) {
                $existingChunk = PgNodeChunk::where('book', $item['book'])
                    ->where('startLine', $item['startLine'])
                    ->first();
            }

            Log::debug('Existing chunk loaded', [
                'book' => $item['book'],
                'startLine' => $item['startLine'],
                'exists' => $existingChunk !== null,
                'hypercites_raw' => $existingChunk ? $existingChunk->getAttributes()['hypercites'] ?? 'NULL_ATTR' : 'NO_CHUNK',
                'hypercites_cast' => $existingChunk ? $existingChunk->hypercites : 'NO_CHUNK'
            ]);

            // --- REVISED LOGIC ---

            $updateData = [];
            // For owners, prepare all possible updatable fields.
            if ($hasPermission) {
                $updateData = [
                    'chunk_id' => $item['chunk_id'] ?? ($existingChunk->chunk_id ?? null),
                    'node_id' => $item['node_id'] ?? ($existingChunk->node_id ?? null),
                    'content' => $item['content'] ?? ($existingChunk->content ?? null),
                    'footnotes' => $item['footnotes'] ?? ($existingChunk->footnotes ?? []),
                    'plainText' => $item['plainText'] ?? ($existingChunk->plainText ?? null),
                    'type' => $item['type'] ?? ($existingChunk->type ?? null),
                ];
            }
            
            // Safely merge hyperlights (for ALL users to prevent data loss).
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
            
            // Rebuild the raw_json field with the most up-to-date, merged data.
            $rawJson = $existingChunk->raw_json ?? $this->cleanItemForStorage($item);

            // Ensure $rawJson is an array (in case cast didn't work or old data exists)
            if (is_string($rawJson)) {
                $rawJson = json_decode($rawJson, true) ?? [];
            }
            if (!is_array($rawJson)) {
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
                'updateData_hypercites' => $updateData['hypercites']
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
                // Create new record
                $result = PgNodeChunk::create(array_merge(
                    ['book' => $item['book'], 'startLine' => $item['startLine']],
                    $updateData
                ));
            }

            Log::debug('After updateOrCreate', [
                'book' => $item['book'],
                'startLine' => $item['startLine'],
                'saved_hypercites' => $result->hypercites,
                'saved_hypercites_count' => is_array($result->hypercites) ? count($result->hypercites) : 'NOT_ARRAY'
            ]);
            }
        }

        Log::info('Targeted upsert completed successfully');
        return response()->json(['success' => true, 'message' => "Node chunks updated successfully (targeted)"]);

    } catch (\Exception $e) {
        Log::error('Targeted upsert failed', [
            'error' => $e->getMessage(),
            'book' => $data['data'][0]['book'] ?? 'unknown',
            'trace' => $e->getTraceAsString()
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
            if (!$highlightId) continue;
            
            // Check if this highlight should be hidden from current user
            $hyperlightRecord = PgHyperlight::where('book', $bookId)
                ->where('hyperlight_id', $highlightId)
                ->first();
                
            if (!$hyperlightRecord) continue;
            
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
}