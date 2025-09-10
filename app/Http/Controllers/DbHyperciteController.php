<?php

namespace App\Http\Controllers;

use App\Models\PgHypercite;
use App\Models\PgNodeChunk;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class DbHyperciteController extends Controller
{
    public function bulkCreate(Request $request)
{
    try {
        $data = $request->all();
        
        if (isset($data['data']) && is_array($data['data'])) {
            foreach ($data['data'] as $item) {
                PgHypercite::create([
                    'book' => $item['book'] ?? null,
                    'hyperciteId' => $item['hyperciteId'] ?? null,
                    'hypercitedText' => $item['hypercitedText'] ?? null,
                    'hypercitedHTML' => $item['hypercitedHTML'] ?? null,
                    'startChar' => $item['startChar'] ?? null,
                    'endChar' => $item['endChar'] ?? null,
                    'relationshipStatus' => $item['relationshipStatus'] ?? null,
                    'citedIN' => $item['citedIN'] ?? [],
                    'time_since' => $item['time_since'] ?? null,
                    'raw_json' => $item,
                ]);
            }
            
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
                            'citedIN' => $item['citedIN'] ?? [],        // Remove json_encode()
                            'time_since' => $item['time_since'] ?? null,
                            'raw_json' => $item,                        // Remove json_encode()
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

    /**
     * Finds a single hypercite.
     * Assumes the 'author' middleware has already verified the session's
     * legitimacy (either as a logged-in user or a valid anonymous session).
     *
     * @param string $bookId
     * @param string $hyperciteId
     * @return \Illuminate\Http\JsonResponse
     */
    public function find($bookId, $hyperciteId)
    {
        Log::info("Authenticated hypercite lookup for book: {$bookId}, hypercite: {$hyperciteId}");

        $hypercite = PgHypercite::where('book', $bookId)
            ->where('hyperciteId', $hyperciteId)
            ->first();

        if (!$hypercite) {
            return response()->json(['error' => 'Hypercite not found.'], 404);
        }

        // ✅ YOUR NEW LOGIC: Fetch ALL nodeChunks for the entire book.
        $allNodeChunks = PgNodeChunk::where('book', $bookId)->get();

        if ($allNodeChunks->isEmpty()) {
            // This is a critical data error if the hypercite exists but the book content doesn't.
            Log::error("Data inconsistency: Hypercite '{$hyperciteId}' found, but NO nodeChunks exist for book '{$bookId}'.");
            return response()->json(['error' => 'Source document content is missing.'], 404);
        }

        Log::info("Hypercite and all " . $allNodeChunks->count() . " parent nodeChunks found for: {$hyperciteId}");

        // ✅ RETURN THE HYPERCITE AND THE FULL ARRAY OF CHUNKS.
        return response()->json([
            'hypercite' => $hypercite,
            'nodeChunks' => $allNodeChunks, // Note the plural 'nodeChunks'
        ]);
    }
}
