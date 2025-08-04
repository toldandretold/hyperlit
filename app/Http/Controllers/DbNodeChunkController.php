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

    public function targetedUpsert(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('Targeted upsert started', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            if (!isset($data['data']) || !is_array($data['data']) || empty($data['data'])) {
                return response()->json(['success' => false, 'message' => 'Invalid data format'], 400);
            }
            
            $firstItem = $data['data'][0];
            $bookId = $firstItem['book'] ?? null;
            
            if (!$bookId) {
                return response()->json(['success' => false, 'message' => 'Book ID is required'], 400);
            }

            // ===================== THE FIX STARTS HERE =====================

            // We check permission once for the book, as it's the same for the whole batch.
            $hasPermission = $this->checkBookPermission($request, $bookId);

            Log::info('Targeted upsert permissions check', [
                'book' => $bookId,
                'user_has_ownership_permission' => $hasPermission
            ]);

            $processedCount = 0;
            $deletedCount = 0;
            $upsertedCount = 0;
            
            foreach ($data['data'] as $index => $item) {
                if (($item['book'] ?? null) !== $bookId) {
                    Log::warning('Book mismatch in targeted upsert', [
                        'expected_book' => $bookId,
                        'item_book' => $item['book'] ?? null,
                        'item_index' => $index
                    ]);
                    continue;
                }
                
                if (isset($item['_action']) && $item['_action'] === 'delete') {
                    // Deletion should only be allowed for owners
                    if ($hasPermission) {
                        $deleted = PgNodeChunk::where('book', $item['book'])
                            ->where('startLine', $item['startLine'])
                            ->delete();
                        $deletedCount += $deleted;
                    } else {
                        Log::warning('Attempted deletion by non-owner denied.', [
                            'book' => $bookId,
                            'startLine' => $item['startLine'] ?? 'unknown'
                        ]);
                    }
                    $processedCount++;
                    continue;
                }
                
                // Build the update payload based on permissions
                if ($hasPermission) {
                    // OWNER: Can update all fields
                    $updateData = [
                        'chunk_id' => $item['chunk_id'] ?? null,
                        'content' => $item['content'] ?? null,
                        'footnotes' => $item['footnotes'] ?? [],
                        'hypercites' => $item['hypercites'] ?? [],
                        'hyperlights' => $item['hyperlights'] ?? [],
                        'plainText' => $item['plainText'] ?? null,
                        'type' => $item['type'] ?? null,
                        'raw_json' => $this->cleanItemForStorage($item), // Use helper here
                        'updated_at' => now(),
                    ];
                } else {
                    // NON-OWNER (PUBLIC): Can ONLY update public fields.
                    // We explicitly ignore any other fields sent in the request.
                    $updateData = [
                        'hyperlights' => $item['hyperlights'] ?? [],
                        'hypercites' => $item['hypercites'] ?? [],
                        'updated_at' => now(),
                    ];
                }
                
                // Upsert the record with the permission-filtered data
                PgNodeChunk::updateOrCreate(
                    [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                    ],
                    $updateData
                );
                
                $upsertedCount++;
                $processedCount++;
            }
            
            // ===================== THE FIX ENDS HERE =====================

            Log::info('Targeted upsert completed', [
                'book' => $bookId,
                'total_processed' => $processedCount,
                'deleted_count' => $deletedCount,
                'upserted_count' => $upsertedCount,
            ]);
            
            return response()->json([
                'success' => true, 
                'message' => "Node chunks updated successfully (targeted)"
            ]);

        } catch (\Exception $e) {
            Log::error('Targeted upsert failed', [
                'error' => $e->getMessage(),
                'book' => $data['data'][0]['book'] ?? 'unknown',
                'trace' => $e->getTraceAsString() // More detailed logging
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