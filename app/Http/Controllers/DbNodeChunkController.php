<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class DbNodeChunkController extends Controller
{
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
                        'raw_json' => json_encode($item),
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
            
            if (isset($data['data']) && is_array($data['data'])) {
                // Get the book name from the request body
                $book = $data['book'] ?? null;
                
                if ($book) {
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
                            'raw_json' => json_encode($item),
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
                } else {
                    Log::warning('DbNodeChunkController::upsert - Book name missing', [
                        'request_data' => $data
                    ]);
                    
                    return response()->json([
                        'success' => false,
                        'message' => 'Book name is required'
                    ], 400);
                }
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
            
            // Log incoming request data
            Log::info('DbNodeChunkController::targetedUpsert - Received data', [
                'request_data' => $data,
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $processedCount = 0;
                $deletedCount = 0;
                $upsertedCount = 0;
                
                foreach ($data['data'] as $index => $item) {
                    Log::debug("Processing targeted upsert item {$index}", ['item' => $item]);
                    
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
                    
                    // Existing upsert logic for regular updates/inserts
                    $result = PgNodeChunk::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'startLine' => $item['startLine'] ?? null,
                        ],
                        [
                            'chunk_id' => $item['chunk_id'] ?? null,
                            'content' => $item['content'] ?? null,
                            'footnotes' => $item['footnotes'] ?? [],
                            'hypercites' => $item['hypercites'] ?? [],
                            'hyperlights' => $item['hyperlights'] ?? [],
                            'plainText' => $item['plainText'] ?? null,
                            'type' => $item['type'] ?? null,
                            'raw_json' => $item,
                            'updated_at' => now(),
                        ]
                    );
                    
                    $upsertedCount++;
                    Log::debug("Upserted nodeChunk", [
                        'book' => $item['book'],
                        'startLine' => $item['startLine'],
                        'was_recently_created' => $result->wasRecentlyCreated,
                        'item_data' => $item
                    ]);
                    
                    $processedCount++;
                }
                
                Log::info('DbNodeChunkController::targetedUpsert - Success', [
                    'total_processed' => $processedCount,
                    'deleted_count' => $deletedCount,
                    'upserted_count' => $upsertedCount
                ]);
                
                return response()->json([
                    'success' => true, 
                    'message' => "Node chunks updated successfully (targeted)"
                ]);
            }
            
            Log::warning('DbNodeChunkController::targetedUpsert - Invalid data format', [
                'received_data' => $data
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
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

}