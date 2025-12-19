<?php

namespace App\Http\Controllers;

use App\Models\PgHypercite;
use App\Models\PgNodeChunk;
use App\Models\PgLibrary;
use App\Models\AnonymousSession;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DbHyperciteController extends Controller
{
    private function isValidAnonymousToken($token)
    {
        // Anonymous sessions valid for 90 days (reduced from 365 for security)
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->exists();
    }

    /**
     * Check if user has permission to modify the hypercite
     * SECURITY: Legacy hypercites require book ownership check
     * For new hypercites, enforce creator ownership
     *
     * @param Request $request
     * @param string|null $creator - Hypercite creator username
     * @param string|null $creatorToken - Hypercite creator token
     * @param string|null $bookId - Book ID (required for legacy record check)
     */
    private function checkHypercitePermission(Request $request, $creator = null, $creatorToken = null, $bookId = null)
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // SECURITY FIX: Legacy hypercites require book ownership
        if (!$creator && !$creatorToken) {
            if (!$bookId) {
                Log::warning('Legacy hypercite access denied - no book ID provided for ownership check');
                return false;
            }

            // Check if user owns the BOOK containing this legacy hypercite
            $library = PgLibrary::where('book', $bookId)->first();

            if (!$library) {
                // No library record - allow for backwards compatibility with very old data
                Log::info('Legacy hypercite access granted (no library record)', ['book' => $bookId]);
                return true;
            }

            $isBookOwner = ($user && $library->creator === $user->name) ||
                           ($anonymousToken && $library->creator_token === $anonymousToken);

            if ($isBookOwner) {
                Log::info('Legacy hypercite access granted (book owner)', [
                    'book' => $bookId,
                    'user' => $user ? $user->name : 'anonymous'
                ]);
                return true;
            }

            Log::warning('Legacy hypercite access denied (not book owner)', [
                'book' => $bookId,
                'user' => $user ? $user->name : 'anonymous'
            ]);
            return false;
        }

        if ($user) {
            // Logged in user - check they are the creator
            if ($creator && $creator === $user->name) {
                Log::info('Logged-in user hypercite access granted', [
                    'user' => $user->name,
                    'creator' => $creator
                ]);
                return true;
            }

            Log::warning('Logged-in user hypercite access denied', [
                'user' => $user->name,
                'creator' => $creator,
                'reason' => 'not_creator'
            ]);
            return false;

        } else {
            // Anonymous user - check server-managed token from cookie
            $anonymousToken = $request->cookie('anon_token');

            if (!$anonymousToken) {
                Log::warning('Anonymous user missing cookie token for hypercite');
                return false;
            }

            // Validate the token exists in our database
            if (!$this->isValidAnonymousToken($anonymousToken)) {
                Log::warning('Anonymous user invalid token for hypercite', [
                    'token' => $anonymousToken,
                    'reason' => 'token_not_in_database'
                ]);
                return false;
            }

            if ($creatorToken && $creatorToken === $anonymousToken) {
                // Update last used time for the anonymous session
                AnonymousSession::where('token', $anonymousToken)
                    ->update(['last_used_at' => now()]);

                Log::info('Anonymous user hypercite access granted', [
                    'token' => $anonymousToken,
                    'creator_token' => $creatorToken
                ]);
                return true;
            }

            Log::warning('Anonymous user hypercite access denied', [
                'token' => $anonymousToken,
                'creator_token' => $creatorToken,
                'reason' => 'token_mismatch'
            ]);
            return false;
        }
    }

    public function bulkCreate(Request $request)
{
    try {
        $data = $request->all();

        Log::info('DbHyperciteController::bulkCreate - Received data', [
            'data_count' => isset($data['data']) ? count($data['data']) : 0,
            'request_size' => strlen(json_encode($data))
        ]);

        if (isset($data['data']) && is_array($data['data'])) {
            $records = [];
            $user = Auth::user();
            $anonymousToken = $user ? null : $request->cookie('anon_token');

            foreach ($data['data'] as $index => $item) {
                // Backend sets the creator fields based on auth state
                // For logged-in users: creator_token = null (RLS uses JOIN to users table)
                // For anonymous users: creator_token = anon token (RLS checks this)
                $creator = $user ? $user->name : null;
                $creator_token = $user ? null : $anonymousToken;

                // Check permission using backend-generated auth
                $bookId = $item['book'] ?? null;
                if (!$this->checkHypercitePermission(
                    $request,
                    $creator,
                    $creator_token,
                    $bookId
                )) {
                    Log::warning("Permission denied for hypercite at index {$index}", [
                        'creator' => $creator,
                        'creator_token' => $creator_token,
                        'book' => $bookId
                    ]);
                    continue; // Skip this item
                }

                $record = [
                    'book' => $item['book'] ?? null,
                    'hyperciteId' => $item['hyperciteId'] ?? null,
                    'node_id' => $item['node_id'] ?? null,
                    'charData' => $item['charData'] ?? null,
                    'hypercitedText' => $item['hypercitedText'] ?? null,
                    'hypercitedHTML' => $item['hypercitedHTML'] ?? null,
                    'relationshipStatus' => $item['relationshipStatus'] ?? null,
                    'citedIN' => $item['citedIN'] ?? [],
                    'creator' => $creator,
                    'creator_token' => $creator_token,
                    'time_since' => $item['time_since'] ?? floor(time()),
                    'raw_json' => $this->cleanItemForStorage($item),
                    'created_at' => now(),
                    'updated_at' => now(),
                ];

                $records[] = $record;
            }

            if (empty($records)) {
                return response()->json([
                    'success' => false,
                    'message' => 'No valid records to insert - access denied for all items'
                ], 403);
            }

            PgHypercite::insert($records);

            // Update annotations_updated_at for affected books
            $bookIds = array_column($records, 'book');
            $this->updateAnnotationsTimestamp($bookIds);

            Log::info('DbHyperciteController::bulkCreate - Success', [
                'records_inserted' => count($records)
            ]);

            return response()->json(['success' => true]);
        }

        return response()->json([
            'success' => false,
            'message' => 'Invalid data format'
        ], 400);

    } catch (\Exception $e) {
        Log::error('DbHyperciteController::bulkCreate - Exception', [
            'error' => $e->getMessage(),
            'trace' => $e->getTraceAsString()
        ]);

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

            Log::info('DbHyperciteController::upsert - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);

            if (isset($data['data']) && is_array($data['data'])) {
                $processedCount = 0;
                $processedBookIds = [];
                $user = Auth::user();
                $anonymousToken = $user ? null : $request->cookie('anon_token');

                foreach ($data['data'] as $index => $item) {
                    // For upserts, we need to check if the record exists first
                    $existingRecord = PgHypercite::where('book', $item['book'] ?? null)
                        ->where('hyperciteId', $item['hyperciteId'] ?? null)
                        ->first();

                    $bookId = $item['book'] ?? null;

                    if ($existingRecord) {
                        // Check permission against existing record
                        if (!$this->checkHypercitePermission(
                            $request,
                            $existingRecord->creator,
                            $existingRecord->creator_token,
                            $existingRecord->book
                        )) {
                            Log::warning("Permission denied for existing hypercite update at index {$index}", [
                                'hyperciteId' => $item['hyperciteId'] ?? null,
                                'book' => $existingRecord->book,
                                'existing_creator' => $existingRecord->creator,
                                'existing_creator_token' => $existingRecord->creator_token
                            ]);
                            continue; // Skip this item
                        }

                        // For existing records, keep the original creator info
                        $creator = $existingRecord->creator;
                        $creator_token = $existingRecord->creator_token;
                    } else {
                        // New record - use backend-generated auth
                        // For logged-in users: creator_token = null (RLS uses JOIN to users table)
                        // For anonymous users: creator_token = anon token (RLS checks this)
                        $creator = $user ? $user->name : null;
                        $creator_token = $user ? null : $anonymousToken;

                        // Check permission for new record
                        if (!$this->checkHypercitePermission(
                            $request,
                            $creator,
                            $creator_token,
                            $bookId
                        )) {
                            Log::warning("Permission denied for new hypercite at index {$index}", [
                                'creator' => $creator,
                                'creator_token' => $creator_token,
                                'book' => $bookId
                            ]);
                            continue; // Skip this item
                        }
                    }

                    Log::debug('Upserting hypercite', [
                        'book' => $item['book'] ?? null,
                        'hyperciteId' => $item['hyperciteId'] ?? null,
                        'relationshipStatus' => $item['relationshipStatus'] ?? null,
                        'citedIN' => $item['citedIN'] ?? []
                    ]);

                    PgHypercite::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'hyperciteId' => $item['hyperciteId'] ?? null,
                        ],
                        [
                            'node_id' => $item['node_id'] ?? null,
                            'charData' => $item['charData'] ?? null,
                            'hypercitedText' => $item['hypercitedText'] ?? null,
                            'hypercitedHTML' => $item['hypercitedHTML'] ?? null,
                            'relationshipStatus' => $item['relationshipStatus'] ?? null,
                            'citedIN' => $item['citedIN'] ?? [],
                            'creator' => $creator,
                            'creator_token' => $creator_token,
                            'time_since' => $item['time_since'] ?? floor(time()),
                            'raw_json' => $this->cleanItemForStorage($item),
                            'updated_at' => now(),
                        ]
                    );

                    $processedCount++;
                    if ($bookId) {
                        $processedBookIds[] = $bookId;
                    }
                }

                // Update annotations_updated_at for affected books
                $this->updateAnnotationsTimestamp($processedBookIds);

                Log::info('DbHyperciteController::upsert - Success', [
                    'records_processed' => $processedCount
                ]);

                return response()->json([
                    'success' => true,
                    'message' => 'Hypercites synced successfully'
                ]);
            }

            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);

        } catch (\Exception $e) {
            Log::error('DbHyperciteController::upsert - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Finds a single hypercite.
     * SECURITY: Checks book visibility before returning data.
     *
     * @param Request $request
     * @param string $bookId
     * @param string $hyperciteId
     * @return \Illuminate\Http\JsonResponse
     */
    public function find(Request $request, $bookId, $hyperciteId)
    {
        Log::info("Hypercite lookup for book: {$bookId}, hypercite: {$hyperciteId}");

        // SECURITY: Check if user has access to this book
        $library = PgLibrary::where('book', $bookId)->first();

        if ($library && $library->visibility !== 'public') {
            // Private book - check ownership
            $user = Auth::user();
            $anonToken = $request->cookie('anon_token');

            $isOwner = ($user && $library->creator === $user->name) ||
                       ($anonToken && $library->creator_token === $anonToken);

            if (!$isOwner) {
                Log::warning("Unauthorized hypercite access attempt", [
                    'book' => $bookId,
                    'hypercite' => $hyperciteId,
                    'user' => $user ? $user->name : 'anonymous'
                ]);
                return response()->json(['error' => 'Access denied.'], 403);
            }
        }

        $hypercite = PgHypercite::where('book', $bookId)
            ->where('hyperciteId', $hyperciteId)
            ->first();

        if (!$hypercite) {
            return response()->json(['error' => 'Hypercite not found.'], 404);
        }

        // Fetch ALL nodeChunks for the entire book.
        $allNodeChunks = PgNodeChunk::where('book', $bookId)->get();

        if ($allNodeChunks->isEmpty()) {
            // This is a critical data error if the hypercite exists but the book content doesn't.
            Log::error("Data inconsistency: Hypercite '{$hyperciteId}' found, but NO nodeChunks exist for book '{$bookId}'.");
            return response()->json(['error' => 'Source document content is missing.'], 404);
        }

        Log::info("Hypercite and all " . $allNodeChunks->count() . " parent nodeChunks found for: {$hyperciteId}");

        return response()->json([
            'hypercite' => $hypercite,
            'nodes' => $allNodeChunks,
        ]);
    }

    private function cleanItemForStorage($item)
    {
        $cleanItem = is_array($item) ? $item : (array) $item;

        // Remove raw_json to prevent recursive nesting
        unset($cleanItem['raw_json']);

        // Remove any other problematic nested fields
        unset($cleanItem['full_library_array']);

        return $cleanItem;
    }

    /**
     * Update annotations_updated_at timestamp for the given books.
     * This is called after any citation modification to enable efficient sync.
     *
     * Uses SECURITY DEFINER function to bypass RLS, allowing users to update
     * the timestamp on public books they don't own (when adding citations).
     *
     * @param array $bookIds - Array of book IDs that had citations modified
     */
    private function updateAnnotationsTimestamp(array $bookIds)
    {
        if (empty($bookIds)) {
            return;
        }

        $now = round(microtime(true) * 1000);
        $uniqueBookIds = array_unique($bookIds);

        // Use SECURITY DEFINER function to bypass RLS for this specific update
        foreach ($uniqueBookIds as $bookId) {
            DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, $now]);
        }

        Log::info('Updated annotations_updated_at for books (hypercites)', [
            'books' => $uniqueBookIds,
            'timestamp' => $now
        ]);
    }
}
