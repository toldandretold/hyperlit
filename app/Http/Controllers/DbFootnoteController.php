<?php

namespace App\Http\Controllers;

use App\Models\PgFootnote;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class DbFootnoteController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        // Log the entire request for debugging
        Log::info('Footnote request received:', [
            'book' => $request->input('book'),
            'has_data' => $request->has('data'),
            'data_type' => gettype($request->input('data')),
            'raw_content' => $request->getContent()
        ]);

        // Validate the request
        $validated = $request->validate([
            'book' => 'required|string',
            'data' => 'nullable'  // Add more specific validation rules if needed
        ]);

        // Safe logging of data sample
        $data = $request->input('data');
        $dataSample = is_array($data) ? array_slice($data, 0, 2) : $data;
        
        Log::info('Footnote data received:', [
            'book' => $request->input('book'),
            'data_sample' => $dataSample
        ]);

        return $this->handleDatabaseSync(
            $request,
            PgFootnote::class,
            ['book', 'data'],
            false
        );
    }

    public function upsert(Request $request)
    {
        try {
            Log::info('Footnote upsert request received:', [
                'book' => $request->input('book'),
                'has_data' => $request->has('data'),
                'data_type' => gettype($request->input('data'))
            ]);

            $validated = $request->validate([
                'book' => 'required|string',
                'data' => 'required|array',
                'data.*.footnoteId' => 'required|string',
                'data.*.content' => 'present',
            ]);

            $book = $validated['book'];
            $footnotes = $validated['data'];
            $upsertedCount = 0;

            foreach ($footnotes as $item) {
                PgFootnote::updateOrCreate(
                    [
                        'book' => $book,
                        'footnoteId' => $item['footnoteId'],
                    ],
                    [
                        'content' => $item['content'] ?? '',
                    ]
                );
                $upsertedCount++;
            }

            Log::info('Footnote upserted successfully', [
                'book' => $book,
                'footnote_id' => $book,
                'count' => $upsertedCount
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Footnotes synced successfully',
                'book' => $book
            ]);

        } catch (\Exception $e) {
            Log::error('Footnote upsert error:', [
                'error' => $e->getMessage(),
                'book' => $request->input('book')
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to sync footnotes',
                'error' => $e->getMessage()
            ], 500);
        }
    }
}
