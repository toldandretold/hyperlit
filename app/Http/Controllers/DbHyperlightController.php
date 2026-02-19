<?php

namespace App\Http\Controllers;

use App\Models\PgHyperlight;
use App\Models\PgLibrary;
use App\Models\AnonymousSession;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DbHyperlightController extends Controller
{
    private function isValidAnonymousToken($token)
    {
        // Anonymous sessions valid for 90 days (reduced from 365 for security)
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->exists();
    }

    /**
     * Check if user has permission to modify the hyperlight
     * SECURITY: Legacy hyperlights require book ownership check
     *
     * @param Request $request
     * @param string|null $creator - Hyperlight creator username
     * @param string|null $creatorToken - Hyperlight creator token
     * @param string|null $bookId - Book ID (required for legacy record check)
     */
    private function checkHyperlightPermission(Request $request, $creator = null, $creatorToken = null, $bookId = null)
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        if ($user) {
            // Logged in user - check they are the creator
            if ($creator && $creator === $user->name) {
                Log::info('Logged-in user hyperlight access granted', [
                    'user' => $user->name,
                    'creator' => $creator
                ]);
                return true;
            }

            // SECURITY: For legacy records, check if user owns the book
            if (!$creator && !$creatorToken && $bookId) {
                $library = PgLibrary::where('book', $bookId)->first();
                if ($library && $library->creator === $user->name) {
                    Log::info('Logged-in user hyperlight access granted (book owner)', [
                        'user' => $user->name,
                        'book' => $bookId
                    ]);
                    return true;
                }
            }

            Log::warning('Logged-in user hyperlight access denied', [
                'user' => $user->name,
                'creator' => $creator,
                'reason' => 'not_creator'
            ]);
            return false;

        } else {
            // Anonymous user - check server-managed token from cookie
            if (!$anonymousToken) {
                Log::warning('Anonymous user missing cookie token for hyperlight');
                return false;
            }

            // Validate the token exists in our database
            if (!$this->isValidAnonymousToken($anonymousToken)) {
                Log::warning('Anonymous user invalid token for hyperlight', [
                    'token' => $anonymousToken,
                    'reason' => 'token_not_in_database'
                ]);
                return false;
            }

            // 🔒 SECURITY FIX: Legacy records (no creator_token) are now READ-ONLY
            // Previously, book owners could modify other users' legacy highlights.
            // Now, legacy records cannot be modified by anyone - they are immutable.
            // This prevents book owners from deleting/modifying other users' old work.
            if ($creatorToken === null) {
                Log::warning('Legacy hyperlight modification denied - legacy records are read-only', [
                    'book' => $bookId,
                    'token' => $anonymousToken
                ]);
                return false;
            }

            if ($creatorToken && $creatorToken === $anonymousToken) {
                // Update last used time for the anonymous session
                AnonymousSession::where('token', $anonymousToken)
                    ->update(['last_used_at' => now()]);

                Log::info('Anonymous user hyperlight access granted', [
                    'token' => $anonymousToken,
                    'creator_token' => $creatorToken
                ]);
                return true;
            }

            Log::warning('Anonymous user hyperlight access denied', [
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
            
            Log::info('DbHyperlightController::bulkCreate - Received data', [
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
                    $bookId = $item['book'] ?? null;

                    // Check permission using backend-generated auth
                    if (!$this->checkHyperlightPermission(
                        $request,
                        $creator,
                        $creator_token,
                        $bookId
                    )) {
                        Log::warning("Permission denied for hyperlight at index {$index}", [
                            'creator' => $creator,
                            'creator_token' => $creator_token,
                            'book' => $bookId
                        ]);
                        continue; // Skip this item
                    }
                    
                    $record = [
                        'book' => $item['book'] ?? null,
                        'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        'node_id' => $item['node_id'] ?? null,
                        'charData' => $item['charData'] ?? null,
                        'highlightedText' => $item['highlightedText'] ?? null,
                        'highlightedHTML' => $item['highlightedHTML'] ?? null,
                        'annotation' => $item['annotation'] ?? null,
                        'startLine' => $item['startLine'] ?? null,
                        'creator' => $creator,
                        'creator_token' => $creator_token,
                        'time_since' => $item['time_since'] ?? floor(time()),
                        'raw_json' => json_encode($this->cleanItemForStorage($item)),
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
                
                PgHyperlight::insert($records);

                Log::info('DbHyperlightController::bulkCreate - Success', [
                    'records_inserted' => count($records)
                ]);

                return response()->json(['success' => true]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::bulkCreate - Exception', [
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

    public function upsert(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::upsert - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $processedCount = 0;
                $processedBookIds = [];
                $user = Auth::user();
                $anonymousToken = $user ? null : $request->cookie('anon_token');

                foreach ($data['data'] as $index => $item) {
                    $bookId = $item['book'] ?? null;

                    // For upserts, we need to check if the record exists first
                    $existingRecord = PgHyperlight::where('book', $bookId)
                        ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                        ->first();

                    if ($existingRecord) {
                        // Check permission against existing record
                        if (!$this->checkHyperlightPermission(
                            $request,
                            $existingRecord->creator,
                            $existingRecord->creator_token,
                            $existingRecord->book
                        )) {
                            Log::warning("Permission denied for existing hyperlight update at index {$index}", [
                                'hyperlight_id' => $item['hyperlight_id'] ?? null,
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
                        if (!$this->checkHyperlightPermission(
                            $request,
                            $creator,
                            $creator_token,
                            $bookId
                        )) {
                            Log::warning("Permission denied for new hyperlight at index {$index}", [
                                'creator' => $creator,
                                'creator_token' => $creator_token,
                                'book' => $bookId
                            ]);
                            continue; // Skip this item
                        }
                    }

                    Log::info("Processing hyperlight for upsert", [
                        'hyperlight_id' => $item['hyperlight_id'] ?? 'N/A',
                        'annotation_value' => $item['annotation'] ?? '---NULL OR NOT SET---'
                    ]);
                    
                    PgHyperlight::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        ],
                        [
                            'node_id' => $item['node_id'] ?? null,
                            'charData' => $item['charData'] ?? [],
                            'highlightedText' => $item['highlightedText'] ?? null,
                            'highlightedHTML' => $item['highlightedHTML'] ?? null,
                            'annotation' => $item['annotation'] ?? null,
                            'preview_nodes' => isset($item['preview_nodes'])
                                ? json_encode($item['preview_nodes'])
                                : null,
                            'startLine' => $item['startLine'] ?? null,
                            'creator' => $creator,
                            'creator_token' => $creator_token,
                            'time_since' => $item['time_since'] ?? floor(time()),
                            'raw_json' => json_encode($this->cleanItemForStorage($item)),
                            'updated_at' => now(),
                        ]
                    );

                    $processedCount++;
                    if ($bookId) {
                        $processedBookIds[] = $bookId;
                    }
                }

                Log::info('DbHyperlightController::upsert - Success', [
                    'records_processed' => $processedCount
                ]);

                return response()->json([
                    'success' => true,
                    'message' => 'Hyperlights synced successfully'
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::upsert - Exception', [
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

    public function delete(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::delete - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $deletedCount = 0;
                $deletedBookIds = [];

                foreach ($data['data'] as $index => $item) {
                    // Find the existing record to check permissions
                    $existingRecord = PgHyperlight::where('book', $item['book'] ?? null)
                        ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                        ->first();

                    if (!$existingRecord) {
                        Log::warning("Hyperlight not found for deletion at index {$index}", [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null
                        ]);
                        continue;
                    }

                    // Check permission using existing record's creator info
                    if (!$this->checkHyperlightPermission(
                        $request,
                        $existingRecord->creator,
                        $existingRecord->creator_token,
                        $existingRecord->book
                    )) {
                        Log::warning("Permission denied for hyperlight deletion at index {$index}", [
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                            'book' => $existingRecord->book,
                            'creator' => $existingRecord->creator,
                            'creator_token' => $existingRecord->creator_token
                        ]);
                        continue; // Skip this item
                    }

                    $bookId = $existingRecord->book;
                    $existingRecord->delete();
                    $deletedCount++;
                    if ($bookId) {
                        $deletedBookIds[] = $bookId;
                    }
                }

                Log::info('DbHyperlightController::delete - Success', [
                    'records_deleted' => $deletedCount
                ]);

                return response()->json([
                    'success' => true,
                    'message' => 'Hyperlights deleted successfully'
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::delete - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to delete data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    public function hide(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::hide - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $hiddenCount = 0;
                $hiddenBookIds = [];

                foreach ($data['data'] as $index => $item) {
                    // Find the existing record
                    $existingRecord = PgHyperlight::where('book', $item['book'] ?? null)
                        ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                        ->first();

                    if (!$existingRecord) {
                        Log::warning("Hyperlight not found for hiding at index {$index}", [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null
                        ]);
                        continue;
                    }

                    // SECURITY: Only book owner can hide highlights in their book
                    $user = Auth::user();
                    $anonymousToken = $user ? null : $request->cookie('anon_token');

                    // Check if current user owns the book
                    $bookId = $item['book'] ?? null;
                    $library = PgLibrary::where('book', $bookId)->first();

                    $isBookOwner = $library && (
                        ($user && $library->creator === $user->name) ||
                        (!$user && $anonymousToken && $library->creator_token === $anonymousToken)
                    );

                    if (!$isBookOwner) {
                        Log::warning("Hide permission denied - user doesn't own book", [
                            'book' => $bookId,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                            'user' => $user?->name,
                            'has_anon_token' => !empty($anonymousToken)
                        ]);
                        continue;
                    }

                    // Set hidden flag to true
                    $existingRecord->hidden = true;
                    $existingRecord->save();

                    $hiddenCount++;
                    if ($bookId) {
                        $hiddenBookIds[] = $bookId;
                    }

                    Log::info("Hidden highlight {$item['hyperlight_id']} in book {$item['book']}");
                }

                Log::info('DbHyperlightController::hide - Success', [
                    'records_hidden' => $hiddenCount
                ]);

                return response()->json([
                    'success' => true,
                    'message' => 'Hyperlights hidden successfully'
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::hide - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to hide highlights',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    private function cleanItemForStorage($item)
    {
        // Create a copy to avoid modifying the original
        $cleanItem = $item;

        // Remove the raw_json field to prevent recursive nesting
        unset($cleanItem['raw_json']);

        // Also remove any other potentially problematic nested fields
        if (isset($cleanItem['full_library_array'])) {
            unset($cleanItem['full_library_array']);
        }

        return $cleanItem;
    }

    /**
     * Update annotations_updated_at timestamp for the given books.
     * This is called after any highlight modification to enable efficient sync.
     *
     * Uses SECURITY DEFINER function to bypass RLS, allowing users to update
     * the timestamp on public books they don't own (when adding highlights).
     *
     * @param array $bookIds - Array of book IDs that had highlights modified
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

        Log::info('Updated annotations_updated_at for books', [
            'books' => $uniqueBookIds,
            'timestamp' => $now
        ]);
    }
}