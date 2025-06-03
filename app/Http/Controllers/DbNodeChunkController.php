<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use Illuminate\Http\Request;

class DbNodeChunkController extends Controller
{
    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            if (isset($data['data']) && is_array($data['data'])) {
                $records = [];
                
                foreach ($data['data'] as $item) {
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

                
                return response()->json(['success' => true]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
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
            
            if (isset($data['data']) && is_array($data['data'])) {
                // Get the book name from the request body
                $book = $data['book'] ?? null;
                
                if ($book) {
                    // Clear existing data only for this specific book
                    PgNodeChunk::where('book', $book)->delete();
                    
                    $records = [];
                    foreach ($data['data'] as $item) {
                        $records[] = [
                            'book' => $item['book'] ?? $book, // Use book from request if item doesn't have it
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
                    
                    return response()->json([
                        'success' => true, 
                        'message' => "Node chunks synced successfully for book: {$book}"
                    ]);
                } else {
                    return response()->json([
                        'success' => false,
                        'message' => 'Book name is required'
                    ], 400);
                }
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
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
            
            if (isset($data['data']) && is_array($data['data'])) {
                foreach ($data['data'] as $item) {
                    PgNodeChunk::updateOrCreate(
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
                }
                
                return response()->json([
                    'success' => true, 
                    'message' => "Node chunks updated successfully (targeted)"
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data (targeted)',
                'error' => $e->getMessage()
            ], 500);
        }
    }


}
