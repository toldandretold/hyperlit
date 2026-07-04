<?php

namespace App\Http\Controllers;

use App\Http\Responses\ApiResponse;
use App\Models\PgReference;
use App\Services\Security\NodeHtmlSanitizer;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;

class DbReferencesController extends Controller
{
    /**
     * Upserts (updates or creates) a batch of references for a given book — SAVE path for the
     * `bibliography` store. The client sends a TS `BibliographyRecord` list; the Validator below
     * declares the accepted request shape:
     *   array{book: string, data: array<int, array{
     *     referenceId: string, source_id?: ?string, canonical_source_id?: ?string (uuid), content: string
     *   }>}
     * Each row is written to bibliography via updateOrInsert (book/referenceId/source_id/
     * canonical_source_id/content). `source_has_nodes` is NOT written — it's derived on read (getBibliography).
     */
    public function upsertReferences(Request $request)
    {
        $validator = Validator::make($request->all(), [
            'book' => 'required|string',
            'data' => 'required|array',
            'data.*.referenceId' => 'required|string',
            'data.*.source_id' => 'nullable|string',
            'data.*.canonical_source_id' => 'nullable|string|uuid',
            'data.*.content' => 'required|string',
        ]);

        if ($validator->fails()) {
            // F5: standard envelope ({success:false, message, errors}) — was bare {errors}.
            return ApiResponse::validationError($validator->errors());
        }

        $bookId = $request->input('book');
        $references = $request->input('data');
        $upsertedCount = 0;

        // E2EE backstop (docs/e2ee.md): encrypted books only ever store ciphertext.
        \App\Services\E2ee\EncryptedBookGuard::rejectPlaintextWrites($bookId, $references, ['content']);

        try {
            foreach ($references as $item) {
                // Use DB::table() instead of Eloquent because the model has a composite primary key
                // which doesn't work well with updateOrCreate()
                \DB::table('bibliography')->updateOrInsert(
                    ['book' => $bookId, 'referenceId' => $item['referenceId']],
                    [
                        'book' => $bookId,
                        'referenceId' => $item['referenceId'],
                        'source_id' => $item['source_id'] ?? null,
                        'canonical_source_id' => $item['canonical_source_id'] ?? null,
                        'content' => NodeHtmlSanitizer::clean($item['content']),
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