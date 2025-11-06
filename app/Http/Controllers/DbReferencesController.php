<?php

namespace App\Http\Controllers;

// Use your custom model names
use App\Models\PgFootnote;
use App\Models\PgReference;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;

// CORRECTED: The class name now matches the filename
class DbReferencesController extends Controller
{
    /**
     * Upserts (updates or creates) a batch of footnotes for a given book.
     */
    public function upsertFootnotes(Request $request)
    {
        $validator = Validator::make($request->all(), [
            'book' => 'required|string',
            'data' => 'required|array',
            'data.*.footnoteId' => 'required|string',
            'data.*.content' => 'required|string',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $bookId = $request->input('book');
        $footnotes = $request->input('data');
        $upsertedCount = 0;

        try {
            foreach ($footnotes as $item) {
                // CORRECTED: Use your PgFootnote model
                PgFootnote::updateOrCreate(
                    ['book' => $bookId, 'footnoteId' => $item['footnoteId']],
                    ['content' => $item['content']]
                );
                $upsertedCount++;
            }

            Log::info("Upserted {$upsertedCount} footnotes for book: {$bookId}");
            return response()->json(['success' => true, 'message' => "Synced {$upsertedCount} footnotes."]);

        } catch (\Exception $e) {
            Log::error("Footnote sync failed for book {$bookId}: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Server error during footnote sync.'], 500);
        }
    }

    /**
     * Upserts (updates or creates) a batch of references for a given book.
     */
    public function upsertReferences(Request $request)
    {
        $validator = Validator::make($request->all(), [
            'book' => 'required|string',
            'data' => 'required|array',
            'data.*.referenceId' => 'required|string',
            'data.*.content' => 'required|string',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $bookId = $request->input('book');
        $references = $request->input('data');
        $upsertedCount = 0;

        try {
            foreach ($references as $item) {
                // Use DB::table() instead of Eloquent because the model has a composite primary key
                // which doesn't work well with updateOrCreate()
                \DB::table('bibliography')->updateOrInsert(
                    ['book' => $bookId, 'referenceId' => $item['referenceId']],
                    [
                        'book' => $bookId,
                        'referenceId' => $item['referenceId'],
                        'content' => $item['content'],
                        'updated_at' => now(),
                        'created_at' => now(),
                    ]
                );
                $upsertedCount++;
            }

            Log::info("Upserted {$upsertedCount} references for book: {$bookId}");
            return response()->json(['success' => true, 'message' => "Synced {$upsertedCount} references."]);

        } catch (\Exception $e) {
            Log::error("Reference sync failed for book {$bookId}: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Server error during reference sync.'], 500);
        }
    }
}