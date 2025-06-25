<?php

namespace App\Http\Controllers;

use App\Models\PgHyperlight;
use Illuminate\Http\Request;

class DbHyperlightController extends Controller
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
                        'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        'highlightedText' => $item['highlightedText'] ?? null,
                        'highlightedHTML' => $item['highlightedHTML'] ?? null,
                        'annotation' => $item['annotation'] ?? null,
                        'startChar' => $item['startChar'] ?? null,
                        'endChar' => $item['endChar'] ?? null,
                        'startLine' => $item['startLine'] ?? null,
                        'creator' => $item['creator'] ?? null,
                        'creator_token' => $item['creator_token'] ?? null,
                        'time_since' => $item['time_since'] ?? floor(time()), // Add time_since support
                        'raw_json' => json_encode($item),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                    
                    $records[] = $record;
                }
                
                PgHyperlight::insert($records);
                
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
                    PgHyperlight::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        ],
                        [
                            'highlightedText' => $item['highlightedText'] ?? null,
                            'highlightedHTML' => $item['highlightedHTML'] ?? null,
                            'annotation' => $item['annotation'] ?? null,
                            'startChar' => $item['startChar'] ?? null,
                            'endChar' => $item['endChar'] ?? null,
                            'startLine' => $item['startLine'] ?? null,
                            'creator' => $item['creator'] ?? null,
                            'creator_token' => $item['creator_token'] ?? null,
                            'time_since' => $item['time_since'] ?? floor(time()), // Add time_since support
                            'raw_json' => json_encode($item),
                            'updated_at' => now(),
                        ]
                    );
                }
                
                return response()->json(['success' => true, 'message' => 'Hyperlights synced successfully']);
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

    public function delete(Request $request)
    {
        try {
            $data = $request->all();
            
            if (isset($data['data']) && is_array($data['data'])) {
                foreach ($data['data'] as $item) {
                    PgHyperlight::where('book', $item['book'] ?? null)
                               ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                               ->delete();
                }
                
                return response()->json(['success' => true, 'message' => 'Hyperlights deleted successfully']);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to delete data',
                'error' => $e->getMessage()
            ], 500);
        }
    }
}