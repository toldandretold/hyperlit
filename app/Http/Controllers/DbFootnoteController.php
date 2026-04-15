<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Models\PgFootnote;
use App\Services\BookDeletionService;
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
                $existing = PgFootnote::where('book', $book)
                    ->where('footnoteId', $item['footnoteId'])
                    ->first();

                $previewNodes = isset($item['preview_nodes'])
                    ? json_encode($item['preview_nodes'])
                    : null;

                $subBookId = SubBookIdHelper::build($book, $item['footnoteId']);

                if ($existing) {
                    $updates = [
                        'content'     => $item['content'] ?? '',
                        'sub_book_id' => $subBookId,
                    ];
                    if ($previewNodes !== null) {
                        $updates['preview_nodes'] = $previewNodes;
                    }
                    PgFootnote::where('book', $book)
                        ->where('footnoteId', $item['footnoteId'])
                        ->update($updates);
                } else {
                    PgFootnote::create([
                        'book'          => $book,
                        'sub_book_id'   => $subBookId,
                        'footnoteId'    => $item['footnoteId'],
                        'content'       => $item['content'] ?? '',
                        'preview_nodes' => $previewNodes,
                    ]);
                }
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

    /**
     * Delink orphaned hypercites that reference a footnote's sub-book.
     * Does NOT delete the PgFootnote record or sub-book content — those are
     * preserved so a cut+paste can restore the footnote.
     */
    public function delink(Request $request)
    {
        try {
            $data = $request->all();

            Log::info('DbFootnoteController::delink - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
            ]);

            if (isset($data['data']) && is_array($data['data'])) {
                $delinkedCount = 0;

                $deletionService = new BookDeletionService();

                foreach ($data['data'] as $index => $item) {
                    $book = $item['book'] ?? null;
                    $footnoteId = $item['footnoteId'] ?? null;

                    if (!$book || !$footnoteId) {
                        Log::warning("Missing book or footnoteId at index {$index}");
                        continue;
                    }

                    // Look up the sub_book_id from the footnote record
                    $existingRecord = PgFootnote::where('book', $book)
                        ->where('footnoteId', $footnoteId)
                        ->first();

                    $subBookId = $existingRecord->sub_book_id
                        ?? SubBookIdHelper::build($book, $footnoteId);

                    try {
                        $deletionService->delinkOrphanedHypercites($subBookId);
                        $delinkedCount++;
                    } catch (\Exception $e) {
                        Log::warning('Footnote hypercite delink failed (non-fatal)', [
                            'sub_book_id' => $subBookId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }

                Log::info('DbFootnoteController::delink - Success', [
                    'delinked_count' => $delinkedCount,
                ]);

                return response()->json([
                    'success' => true,
                    'message' => 'Footnote hypercites delinked successfully',
                ]);
            }

            return response()->json([
                'success' => false,
                'message' => 'Invalid data format',
            ], 400);

        } catch (\Exception $e) {
            Log::error('DbFootnoteController::delink - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to delink footnote hypercites',
                'error' => $e->getMessage(),
            ], 500);
        }
    }
}
