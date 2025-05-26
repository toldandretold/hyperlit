<?php

namespace App\Http\Controllers;

use App\Models\NodeChunk;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class NodeChunkController extends Controller
{
    public function bulkCreate(Request $request)
    {
        try {
            DB::beginTransaction();

            $book = $request->input('book');
            $chunks = $request->input('chunks');

            // Log the first chunk to see its structure
            Log::info('First chunk structure:', ['chunk' => $chunks[0] ?? 'no chunks']);

            // First, remove any existing chunks for this book
            NodeChunk::where('book', $book)->delete();

            // Insert all new chunks
            foreach ($chunks as $chunk) {
                NodeChunk::create([
                    'book' => $chunk['book'] ?? null,
                    'chunk_id' => $chunk['chunk_id'] ?? 0,
                    'startLine' => $chunk['startLine'] ?? 0,
                    'content' => $chunk['content'] ?? null,
                    'footnotes' => $chunk['footnotes'] ?? [],
                    'hypercites' => $chunk['hypercites'] ?? [],
                    'hyperlights' => $chunk['hyperlights'] ?? [],
                    'plainText' => $chunk['plainText'] ?? null,
                    'type' => $chunk['type'] ?? null,
                    'raw_json' => $chunk // Store the entire chunk as JSON
                ]);
            }

            DB::commit();

            return response()->json([
                'success' => true,
                'message' => "Successfully stored {$book} chunks",
                'count' => count($chunks)
            ]);

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Error in bulkCreate:', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
                'debug_info' => [
                    'first_chunk' => $chunks[0] ?? 'no chunks',
                    'error_trace' => $e->getTraceAsString()
                ]
            ], 500);
        }
    }
}
