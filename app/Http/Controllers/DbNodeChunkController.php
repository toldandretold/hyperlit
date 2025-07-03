<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use App\Models\PgLibrary;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DbNodeChunkController extends Controller
{
    /**
     * Check if user has permission to modify the book
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
                Log::warning('Logged-in user access denied', [
                    'user' => $user->name,
                    'book' => $bookId,
                    'reason' => 'book_not_owned'
                ]);
                return false;
            }
            
            Log::info('Logged-in user access granted', [
                'user' => $user->name,
                'book' => $bookId
            ]);
            return true;
            
        } else {
            // Anonymous user - check UUID matches
            $anonymousToken = $request->input('anonymous_token');
            
            if (!$anonymousToken) {
                Log::warning('Anonymous user missing token', ['book' => $bookId]);
                return false;
            }
            
            $book = PgLibrary::where('book', $bookId)
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator') // Make sure it's not owned by a logged-in user
                ->first();
                
            if (!$book) {
                Log::warning('Anonymous user access denied', [
                    'token' => $anonymousToken,
                    'book' => $bookId,
                    'reason' => 'token_mismatch_or_book_owned'
                ]);
                return false;
            }
            
            Log::info('Anonymous user access granted', [
                'token' => $anonymousToken,
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
        
        Log::debug('Checking if public fields only', [
            'item_keys' => $itemKeys,
            'public_fields' => $publicFields,
            'non_public_fields_with_values' => []
        ]);
        
        $nonPublicFieldsWithValues = [];
        
        // Check if all fields are either public fields or null/empty
        foreach ($itemKeys as $key) {
            if (!in_array($key, $publicFields) && !empty($item[$key])) {
                $nonPublicFieldsWithValues[$key] = $item[$key];
            }
        }
        
        $isPublicOnly = empty($nonPublicFieldsWithValues);
        
        Log::debug('Public fields check result', [
            'is_public_only' => $isPublicOnly,
            'non_public_fields_with_values' => $nonPublicFieldsWithValues
        ]);
        
        return $isPublicOnly;
    }

    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            // Log incoming request data
            Log::info('DbNodeChunkController::bulkCreate - Received data', [
                'request_data' => $data,
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            // Get book ID and check permissions
            $bookId = $data['book'] ?? null;
            if (!$bookId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book ID is required'
                ], 400);
            }
            
            // Check permissions
            if (!$this->checkBookPermission($request, $bookId)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied'
                ], 403);
            }
            
            if (isset($data['data']) && is_array($data['data'])) {
                $records = [];
                
                foreach ($data['data'] as $index => $item) {
                    Log::debug("Processing item {$index}", ['item' => $item]);
                    
                    $record = [
                        'book' => $item['book'] ?? null,
                        'chunk_id' => $item['chunk_id'] ?? 0,
                        'startLine' => $item['startLine'] ?? null,
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
                    
                    $records[] = $record;
                }
                
                PgNodeChunk::insert($records);
                
                Log::info('DbNodeChunkController::bulkCreate - Success', [
                    'records_inserted' => count($records)
                ]);
                
                return response()->json(['success' => true]);
            }
            
            Log::warning('DbNodeChunkController::bulkCreate - Invalid data format', [
                'received_data' => $data
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbNodeChunkController::bulkCreate - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
                'request_data' => $request->all()
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
            
            // Log incoming request data
            Log::info('DbNodeChunkController::upsert - Received data', [
                'request_data' => $data,
                'book' => $data['book'] ?? 'not_specified',
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            // Get book ID and check permissions
            $book = $data['book'] ?? null;
            if (!$book) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book name is required'
                ], 400);
            }
            
            // Check permissions
            if (!$this->checkBookPermission($request, $book)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied'
                ], 403);
            }
            
            if (isset($data['data']) && is_array($data['data'])) {
                Log::info("Clearing existing data for book: {$book}");
                
                // Clear existing data only for this specific book
                $deletedCount = PgNodeChunk::where('book', $book)->count();
                PgNodeChunk::where('book', $book)->delete();
                
                Log::info("Deleted {$deletedCount} existing records for book: {$book}");
                
                $records = [];
                foreach ($data['data'] as $index => $item) {
                    Log::debug("Processing upsert item {$index}", ['item' => $item]);
                    
                    $records[] = [
                        'book' => $item['book'] ?? $book,
                        'chunk_id' => $item['chunk_id'] ?? 0,
                        'startLine' => $item['startLine'] ?? null,
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
                
                Log::info('DbNodeChunkController::upsert - Success', [
                    'book' => $book,
                    'records_inserted' => count($records),
                    'records_deleted' => $deletedCount
                ]);
                
                return response()->json([
                    'success' => true, 
                    'message' => "Node chunks synced successfully for book: {$book}"
                ]);
            }
            
            Log::warning('DbNodeChunkController::upsert - Invalid data format', [
                'received_data' => $data
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbNodeChunkController::upsert - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
                'request_data' => $request->all()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    public function targetedUpsert(Request $request)
    {
        try {
            $data = $request->all();

             // Add this debugging
            Log::info('DbNodeChunkController::targetedUpsert - DEBUG START', [
                'has_data' => isset($data['data']),
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'anonymous_token' => $request->input('anonymous_token'),
                'auth_user' => Auth::user() ? Auth::user()->name : 'not_logged_in',
                'first_item_sample' => isset($data['data'][0]) ? [
                    'book' => $data['data'][0]['book'] ?? 'missing',
                    'startLine' => $data['data'][0]['startLine'] ?? 'missing',
                    'has_hyperlights' => isset($data['data'][0]['hyperlights']),
                    'has_hypercites' => isset($data['data'][0]['hypercites']),
                    'has_content' => isset($data['data'][0]['content']),
                    'all_keys' => array_keys($data['data'][0])
                ] : 'no_data'
            ]);
            
            // Log incoming request data
            Log::info('DbNodeChunkController::targetedUpsert - Received data', [
                'request_data' => $data,
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            // For targeted upsert, we need to check the book from the first item
            // since each item might be for the same book
            if (!isset($data['data']) || !is_array($data['data']) || empty($data['data'])) {
                return response()->json([
                    'success' => false,
                    'message' => 'Invalid data format'
                ], 400);
            }
            
            // Get book ID from first item
            $firstItem = $data['data'][0];
            $bookId = $firstItem['book'] ?? null;
            
            if (!$bookId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book ID is required'
                ], 400);
            }
            
            // Check if this is a public-fields-only update
            $isPublicUpdate = true;
            foreach ($data['data'] as $item) {
                if (!$this->isPublicFieldsOnlyUpdate($item)) {
                    $isPublicUpdate = false;
                    break;
                }
            }
            
            // Only check book permissions if it's not a public update
            if (!$isPublicUpdate && !$this->checkBookPermission($request, $bookId)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Access denied'
                ], 403);
            }
            
            Log::info('Permission check result', [
                'book' => $bookId,
                'is_public_update' => $isPublicUpdate,
                'permission_required' => !$isPublicUpdate
            ]);
            
            $processedCount = 0;
            $deletedCount = 0;
            $upsertedCount = 0;
            
            foreach ($data['data'] as $index => $item) {
                Log::debug("Processing targeted upsert item {$index}", ['item' => $item]);
                
                // Verify each item is for the same book (security check)
                if (($item['book'] ?? null) !== $bookId) {
                    Log::warning('Book mismatch in targeted upsert', [
                        'expected_book' => $bookId,
                        'item_book' => $item['book'] ?? null,
                        'item_index' => $index
                    ]);
                    continue; // Skip this item
                }
                
                // Handle deletion requests
                if (isset($item['_action']) && $item['_action'] === 'delete') {
                    $deleted = PgNodeChunk::where('book', $item['book'])
                        ->where('startLine', $item['startLine'])
                        ->delete();
                    
                    $deletedCount += $deleted;
                    Log::info("Deleted nodeChunk", [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                        'deleted_count' => $deleted,
                        'item_data' => $item
                    ]);
                    
                    $processedCount++;
                    continue;
                }
                
                // Prepare update data based on whether it's a public update
                if ($isPublicUpdate) {
                    // Only update public fields
                    $updateData = [
                        'hyperlights' => $item['hyperlights'] ?? [],
                        'hypercites' => $item['hypercites'] ?? [],
                        'updated_at' => now(),
                    ];
                } else {
                    // Full update (user owns the book)
                    $updateData = [
                        'chunk_id' => $item['chunk_id'] ?? null,
                        'content' => $item['content'] ?? null,
                        'footnotes' => $item['footnotes'] ?? [],
                        'hypercites' => $item['hypercites'] ?? [],
                        'hyperlights' => $item['hyperlights'] ?? [],
                        'plainText' => $item['plainText'] ?? null,
                        'type' => $item['type'] ?? null,
                        'raw_json' => $item,
                        'updated_at' => now(),
                    ];
                }
                
                // Existing upsert logic for regular updates/inserts
                $result = PgNodeChunk::updateOrCreate(
                    [
                        'book' => $item['book'] ?? null,
                        'startLine' => $item['startLine'] ?? null,
                    ],
                    $updateData
                );
                
                $upsertedCount++;
                Log::debug("Upserted nodeChunk", [
                    'book' => $item['book'],
                    'startLine' => $item['startLine'],
                    'was_recently_created' => $result->wasRecentlyCreated,
                    'is_public_update' => $isPublicUpdate,
                    'item_data' => $item
                ]);
                
                $processedCount++;
            }
            
            Log::info('DbNodeChunkController::targetedUpsert - Success', [
                'total_processed' => $processedCount,
                'deleted_count' => $deletedCount,
                'upserted_count' => $upsertedCount,
                'is_public_update' => $isPublicUpdate
            ]);

             Log::info('Permission check details', [
            'book' => $bookId,
            'is_public_update' => $isPublicUpdate,
            'permission_check_result' => !$isPublicUpdate ? $this->checkBookPermission($request, $bookId) : 'skipped_for_public',
            'will_proceed' => $isPublicUpdate || $this->checkBookPermission($request, $bookId)
        ]);
            
            return response()->json([
                'success' => true, 
                'message' => "Node chunks updated successfully (targeted)"
            ]);
            

        } catch (\Exception $e) {
            Log::error('DbNodeChunkController::targetedUpsert - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
                'request_data' => $request->all()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data (targeted)',
                'error' => $e->getMessage()
            ], 500);
        }
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