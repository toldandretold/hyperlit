<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use Illuminate\Http\Request;

class DbLibraryController extends Controller
{
    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            // Library data comes as a single object, not an array
            if (isset($data['data']) && is_object($data['data'])) {
                $item = $data['data'];
                
                $record = [
                    'book' => $item['book'] ?? null,
                    'citationID' => $item['citationID'] ?? null,
                    'title' => $item['title'] ?? null,
                    'author' => $item['author'] ?? null,
                    'type' => $item['type'] ?? null,
                    'timestamp' => $item['timestamp'] ?? null,
                    'bibtex' => $item['bibtex'] ?? null,
                    'year' => $item['year'] ?? null,
                    'publisher' => $item['publisher'] ?? null,
                    'journal' => $item['journal'] ?? null,
                    'pages' => $item['pages'] ?? null,
                    'url' => $item['url'] ?? null,
                    'note' => $item['note'] ?? null,
                    'school' => $item['school'] ?? null,
                    'fileName' => $item['fileName'] ?? null,
                    'fileType' => $item['fileType'] ?? null,
                    'recent' => $item['recent'] ?? null,
                    'total_views' => $item['total_views'] ?? 0,
                    'total_highlights' => $item['total_highlights'] ?? 0,
                    'total_citations' => $item['total_citations'] ?? 0,
                    'raw_json' => json_encode($item),
                    'created_at' => now(),
                    'updated_at' => now(),
                ];
                
                PgLibrary::create($record); // Use create for single record
                
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
            
            // Library data comes as a single object, not an array
            if (isset($data['data']) && (is_object($data['data']) || is_array($data['data']))) {
                $item = (array) $data['data']; // Convert to array for easier handling
                
                PgLibrary::updateOrCreate(
                    [
                        'book' => $item['book'] ?? null,
                        'citationID' => $item['citationID'] ?? null,
                    ],
                    [
                        'title' => $item['title'] ?? null,
                        'author' => $item['author'] ?? null,
                        'type' => $item['type'] ?? null,
                        'timestamp' => $item['timestamp'] ?? null,
                        'bibtex' => $item['bibtex'] ?? null,
                        'year' => $item['year'] ?? null,
                        'publisher' => $item['publisher'] ?? null,
                        'journal' => $item['journal'] ?? null,
                        'pages' => $item['pages'] ?? null,
                        'url' => $item['url'] ?? null,
                        'note' => $item['note'] ?? null,
                        'school' => $item['school'] ?? null,
                        'fileName' => $item['fileName'] ?? null,
                        'fileType' => $item['fileType'] ?? null,
                        'recent' => $item['recent'] ?? null,
                        'total_views' => $item['total_views'] ?? 0,
                        'total_highlights' => $item['total_highlights'] ?? 0,
                        'total_citations' => $item['total_citations'] ?? 0,
                        'raw_json' => json_encode($item),
                        'updated_at' => now(),
                    ]
                );
                
                return response()->json(['success' => true, 'message' => 'Library synced successfully']);
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
