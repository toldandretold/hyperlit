<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;
use App\Models\PgNodeChunk;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;
use App\Models\PgLibrary;

class BeaconSyncController extends Controller
{
    public function handleSync(Request $request)
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // Determine the ownership key and value based on user state
        $ownerKey = null;
        $ownerValue = null;

        if ($user) {
            // Logged-in user
            $ownerKey = 'creator';
            // Your DbNodeChunkController uses $user->name, but user ID is more standard.
            // Let's stick with ID for consistency, but you can change to name if needed.
            $ownerValue = $user->id; 
            Log::info('Beacon sync initiated by user: ' . $ownerValue);
        } elseif ($anonymousToken) {
            // Anonymous user with a token
            $ownerKey = 'creator_token';
            $ownerValue = $anonymousToken;
            Log::info('Beacon sync initiated by anonymous token.');
        } else {
            // No user and no token, cannot proceed.
            Log::error('Beacon sync failed: No authenticated user or anonymous token.');
            return response()->json(['message' => 'Authentication required.'], 401);
        }

        $validator = Validator::make($request->all(), [
            'book' => 'required|string',
            'updates' => 'present|array',
            'updates.nodeChunks' => 'present|array',
            'updates.hyperlights' => 'present|array',
            'updates.hypercites' => 'present|array',
            'updates.library' => 'present|nullable|array',
            'deletions' => 'present|array',
            'deletions.nodeChunks' => 'present|array',
            'deletions.hyperlights' => 'present|array',
        ]);

        if ($validator->fails()) {
            Log::error('Beacon sync validation failed.', $validator->errors()->toArray());
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $payload = $validator->validated();
        $bookId = $payload['book'];

        try {
            DB::transaction(function () use ($ownerKey, $ownerValue, $bookId, $payload) {
                $updates = $payload['updates'];
                $deletions = $payload['deletions'];

                if (!empty($updates['nodeChunks'])) {
                    foreach ($updates['nodeChunks'] as $chunk) {
                        // ✅ FIX: Add 'raw_json' to the data being saved
                        $chunkData = array_merge($chunk, ['raw_json' => json_encode($chunk)]);
                        
                        PgNodeChunk::updateOrCreate(
                            ['book' => $bookId, 'startLine' => $chunk['startLine']],
                            $chunkData // Use the new array that includes raw_json
                        );
                    }
                }

                if (!empty($updates['hyperlights'])) {
                    foreach ($updates['hyperlights'] as $light) {
                        // ✅ FIX: Add 'raw_json' here too
                        $lightData = array_merge($light, [
                            $ownerKey => $ownerValue,
                            'raw_json' => json_encode($light)
                        ]);
                        PgHyperlight::updateOrCreate(
                            ['book' => $bookId, 'hyperlight_id' => $light['hyperlight_id']],
                            $lightData
                        );
                    }
                }

                if (!empty($updates['hypercites'])) {
                    foreach ($updates['hypercites'] as $cite) {
                        // ✅ FIX: Add 'raw_json' here too
                        $citeData = array_merge($cite, [
                            $ownerKey => $ownerValue,
                            'raw_json' => json_encode($cite)
                        ]);
                        PgHypercite::updateOrCreate(
                            ['book' => $bookId, 'hyperciteId' => $cite['hyperciteId']],
                            $citeData
                        );
                    }
                }

                if (!empty($updates['library'])) {
                    // Check existing record to preserve newer timestamps
                    $existingLibrary = PgLibrary::where('book', $bookId)->first();
                    
                    $libraryData = array_merge($updates['library'], [
                        $ownerKey => $ownerValue,
                        'raw_json' => json_encode($updates['library'])
                    ]);
                    
                    // Preserve newer timestamps - never downgrade
                    if ($existingLibrary && $existingLibrary->timestamp && $libraryData['timestamp']) {
                        if ($existingLibrary->timestamp > $libraryData['timestamp']) {
                            // Keep existing newer timestamp and related fields
                            $libraryData['timestamp'] = $existingLibrary->timestamp;
                            $libraryData['title'] = $existingLibrary->title;
                            $libraryData['bibtex'] = $existingLibrary->bibtex;
                            
                            Log::info('Beacon sync: Preserving newer library data', [
                                'book' => $bookId,
                                'existing_timestamp' => $existingLibrary->timestamp,
                                'beacon_timestamp' => $updates['library']['timestamp'],
                                'preserved_title' => $existingLibrary->title
                            ]);
                        }
                    }
                    
                    PgLibrary::updateOrCreate(
                        ['book' => $bookId],
                        $libraryData
                    );
                }

                // --- 2. Process Deletions ---
                if (!empty($deletions['nodeChunks'])) {
                    $startLinesToDelete = array_column($deletions['nodeChunks'], 'startLine');
                    PgNodeChunk::where('book', $bookId)
                        ->whereIn('startLine', $startLinesToDelete)
                        ->delete();
                }

                if (!empty($deletions['hyperlights'])) {
                    $idsToDelete = array_column($deletions['hyperlights'], 'hyperlight_id');
                    PgHyperlight::where($ownerKey, $ownerValue) // Use the dynamic owner key
                        ->where('book', $bookId)
                        ->whereIn('hyperlight_id', $idsToDelete)
                        ->delete();
                }
            });

        } catch (\Exception $e) {
            Log::error('Beacon sync transaction failed: ' . $e->getMessage(), [
                $ownerKey => $ownerValue,
                'book' => $bookId,
                'trace' => $e->getTraceAsString()
            ]);
            return response()->json(['message' => 'Server error during beacon sync.'], 500);
        }

        Log::info('Beacon sync completed successfully', [
            $ownerKey => $ownerValue,
            'book' => $bookId
        ]);
        return response()->noContent();
    }
}