<?php

namespace App\Http\Controllers;

use App\Models\PgHypercite;
use Illuminate\Http\Request;

class DbHyperciteController extends Controller
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
                        'hyperciteId' => $item['hyperciteId'] ?? null,
                        'hypercitedText' => $item['hypercitedText'] ?? null,
                        'hypercitedHTML' => $item['hypercitedHTML'] ?? null,
                        'startChar' => $item['startChar'] ?? null,
                        'endChar' => $item['endChar'] ?? null,
                        'relationshipStatus' => $item['relationshipStatus'] ?? null,
                        'citedIN' => json_encode($item['citedIN'] ?? []),
                        'raw_json' => json_encode($item),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                    
                    $records[] = $record;
                }
                
                PgHypercite::insert($records);
                
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

    // Add this new upsert method
    public function upsert(Request $request)
    {
        try {
            $data = $request->all();
            
            if (isset($data['data']) && is_array($data['data'])) {
                foreach ($data['data'] as $item) {
                    PgHypercite::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'hyperciteId' => $item['hyperciteId'] ?? null,
                        ],
                        [
                            'hypercitedText' => $item['hypercitedText'] ?? null,
                            'hypercitedHTML' => $item['hypercitedHTML'] ?? null,
                            'startChar' => $item['startChar'] ?? null,
                            'endChar' => $item['endChar'] ?? null,
                            'relationshipStatus' => $item['relationshipStatus'] ?? null,
                            'citedIN' => json_encode($item['citedIN'] ?? []),
                            'raw_json' => json_encode($item),
                            'updated_at' => now(),
                        ]
                    );
                }
                
                return response()->json(['success' => true, 'message' => 'Hypercites synced successfully']);
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
}
