<?php

namespace App\Http\Controllers;

use App\Models\PgHypercite;
use App\Models\PgNode;
use App\Models\PgLibrary;
use App\Models\AnonymousSession;
use App\Http\Responses\ApiResponse;
use App\Services\Security\NodeHtmlSanitizer;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;

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

    /**
     * SAVE path for the `hypercites` store (create). The client sends a TS `HyperciteRecord` list;
     * `creator`/`creator_token` are backend-set from auth (never client). Per-row write shape:
     *   array{book: string, hyperciteId: string, node_id: string[], charData: array<string, array{charStart:int,charEnd:int}>,
     *     hypercitedText: ?string, hypercitedHTML: ?string, relationshipStatus: ?string, citedIN: string[], time_since?: int}
     */
    public function bulkCreate(Request $request)
{
    try {
        $data = $request->all();

        Log::info('DbHyperciteController::bulkCreate - Received data', [
            'data_count' => is_array($data['data'] ?? null) ? count($data['data']) : 0,
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
                    'hypercitedText' => NodeHtmlSanitizer::clean($item['hypercitedText'] ?? null),
                    'hypercitedHTML' => NodeHtmlSanitizer::clean($item['hypercitedHTML'] ?? null),
                    'relationshipStatus' => NodeHtmlSanitizer::clean($item['relationshipStatus'] ?? null),
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

            // Keep the deep-link index fresh for these new cites (best-effort; no-op if cache cold).
            $indexUpdates = [];
            foreach ($records as $rec) {
                $nids = is_array($rec['node_id'] ?? null) ? $rec['node_id'] : json_decode($rec['node_id'] ?? '[]', true);
                if (!empty($rec['book']) && !empty($rec['hyperciteId']) && !empty($nids)) {
                    $indexUpdates[$rec['book']][$rec['hyperciteId']] = $nids[0];
                }
            }
            $this->refreshAnnotationIndex($indexUpdates);

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
    /**
     * SAVE path for the `hypercites` store (update-or-create on book+hyperciteId). Same per-row write
     * shape as bulkCreate (a TS `HyperciteRecord`). On an existing row the ORIGINAL creator/creator_token
     * are preserved (no privilege escalation); a new row uses backend-generated auth.
     */
    public function upsert(Request $request)
    {
        // F5/F6/F7: validate inline (NOT a Form Request — this method is also called
        // internally by UnifiedSyncController with a plain Request, which a Form
        // Request type-hint would reject). `present|array` preserves prior behaviour
        // (empty array allowed); a missing/non-array `data` now returns the standard
        // 422 envelope instead of a bare 400.
        $validator = Validator::make($request->all(), ['data' => 'present|array']);
        if ($validator->fails()) {
            return ApiResponse::validationError($validator->errors());
        }

        try {
            $data = $request->all();

            Log::info('DbHyperciteController::upsert - Received data', [
                'data_count' => is_array($data['data'] ?? null) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);

            if (isset($data['data']) && is_array($data['data'])) {
                // E2EE backstop (docs/e2ee.md): encrypted books only ever store ciphertext.
                foreach ($data['data'] as $guardItem) {
                    \App\Services\E2ee\EncryptedBookGuard::rejectPlaintextWrites(
                        $guardItem['book'] ?? '',
                        [$guardItem],
                        ['hypercitedText', 'hypercitedHTML'],
                    );
                }

                $processedCount = 0;
                $processedBookIds = [];
                $indexUpdates = [];   // book => [hyperciteId => firstNodeId] for the cached deep-link index
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
                        'relationshipStatus' => NodeHtmlSanitizer::clean($item['relationshipStatus'] ?? null),
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
                            'hypercitedText' => NodeHtmlSanitizer::clean($item['hypercitedText'] ?? null),
                            'hypercitedHTML' => NodeHtmlSanitizer::clean($item['hypercitedHTML'] ?? null),
                            'relationshipStatus' => NodeHtmlSanitizer::clean($item['relationshipStatus'] ?? null),
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
                        // Keep the deep-link index fresh: a cite created after the last cache warm
                        // isn't in index.json. Record id → its first node (chunk resolved in bulk below).
                        $nids = is_array($item['node_id'] ?? null)
                            ? $item['node_id']
                            : json_decode($item['node_id'] ?? '[]', true);
                        if (!empty($nids) && !empty($item['hyperciteId'])) {
                            $indexUpdates[$bookId][$item['hyperciteId']] = $nids[0];
                        }
                    }
                }

                // Best-effort: append the new/updated cites to each book's cached index (no-op if cold;
                // never affects the save — the live resolver fallback covers any gap).
                $this->refreshAnnotationIndex($indexUpdates);

                // Bump each touched book's annotations_updated_at so clients holding a
                // CACHED copy re-hydrate annotations on next load. Without this the source
                // book of a citation stayed at annotations_updated_at=0 forever, so a plain
                // refresh trusted the stale cache and the new cite only showed in a fresh
                // (cache-less) window. SECURITY DEFINER fn handles the cross-book case where
                // the citer doesn't own the cited public book.
                $this->updateAnnotationsTimestamp($processedBookIds);

                Log::info('DbHyperciteController::upsert - Success', [
                    'records_processed' => $processedCount
                ]);

                return ApiResponse::ok([], 'Hypercites synced successfully');
            }

            // Unreachable now that `data` is validated as present|array above; kept
            // as a defensive fallback, in the standard shape (422, not the old 400).
            return ApiResponse::error('Invalid data format', 422);

        } catch (\Illuminate\Database\QueryException $qe) {
            // Malformed input that trips a DB constraint/data rule (null PK, FK miss, bad type —
            // SQLSTATE class 23/22) is a CLIENT error: return 422, not a 500.
            $sqlState = (string) $qe->getCode();
            if (str_starts_with($sqlState, '23') || str_starts_with($sqlState, '22')) {
                return ApiResponse::error('Invalid hypercite data', 422, ['error' => config('app.debug') ? $qe->getMessage() : null]);
            }
            Log::error('DbHyperciteController::upsert - QueryException', ['error' => $qe->getMessage()]);
            return ApiResponse::error('Failed to sync data', 500, ['error' => $qe->getMessage()]);
        } catch (\Symfony\Component\HttpKernel\Exception\HttpException $e) {
            throw $e; // E2EE guard 422 — render via the framework handler
            } catch (\Exception $e) {
            Log::error('DbHyperciteController::upsert - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return ApiResponse::error('Failed to sync data', 500, ['error' => $e->getMessage()]);
        }
    }

    /**
     * Best-effort: append created/updated annotation id→chunk mappings to each book's cached deep-link
     * index, so a deep-link to a cite made AFTER the last cache warm uses the fast index path instead of
     * the live table query. No-op when the cache is cold; never affects the save (live fallback covers it).
     *
     * @param array<string, array<string, ?string>> $indexUpdates  book => [id => firstNodeId]
     */
    private function refreshAnnotationIndex(array $indexUpdates): void
    {
        if (empty($indexUpdates)) {
            return;
        }
        try {
            $cache = app(\App\Services\BookCache::class);
            foreach ($indexUpdates as $book => $idToNode) {
                $cache->addToIndex($book, $cache->chunkIdsForNodes($book, $idToNode));
            }
        } catch (\Throwable $e) {
            Log::warning('Annotation index refresh failed (live fallback covers it)', ['error' => $e->getMessage()]);
        }
    }

    /**
     * Finds a single hypercite — the citation-card / fetch-on-demand resolution endpoint
     * (frontend callers: resources/js/indexedDB/hypercites/helpers.ts resolveHypercite +
     * fetchHyperciteRecord). Two variants:
     *   default        → { hypercite: {...HyperciteRecord...}, nodes: array<int, {...node chunk...}> }
     *   ?scope=record  → { hypercite: {...HyperciteRecord...} }  (skips the all-nodes payload —
     *                    used by deep-link fetch-on-demand where the book is already hydrated)
     * The hypercite is SANITIZED: `creator_token` is never sent (top-level nor inside raw_json);
     * only the computed `is_user_hypercite` boolean is exposed (mirrors
     * DatabaseToIndexedDBController::getHypercites()).
     * SECURITY: enforces book visibility/ownership before returning data.
     *
     * @param Request $request
     * @param string $bookId
     * @param string $hyperciteId
     * @return \Illuminate\Http\JsonResponse
     */
    public function find(Request $request, $bookId, $hyperciteId)
    {
        Log::info("Hypercite lookup for book: {$bookId}, hypercite: {$hyperciteId}");

        $user = Auth::user();
        $anonToken = $request->cookie('anon_token');

        // SECURITY: Check if user has access to this book
        $library = PgLibrary::where('book', $bookId)->first();

        if ($library && $library->visibility !== 'public') {
            // Private book - check ownership
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

        // Ownership (same prioritised creator > token > co-author logic as getHypercites())
        $isUserHypercite = false;
        if ($hypercite->creator) {
            $isUserHypercite = $user && $hypercite->creator === $user->name;
        } elseif ($hypercite->creator_token) {
            $isUserHypercite = $anonToken && $hypercite->creator_token === $anonToken;
        }
        if (!$isUserHypercite && $user) {
            // access_granted co-author grant (AI Archivist cites on the asking user's behalf)
            $granted = $hypercite->access_granted;
            if (is_string($granted)) $granted = json_decode($granted, true);
            $isUserHypercite = is_array($granted) && array_key_exists($user->name, $granted);
        }

        // Explicit wire shape — creator_token intentionally never sent (security sensitive),
        // and stripped from the raw_json copy too.
        $rawJson = $hypercite->raw_json ?? [];
        unset($rawJson['creator_token']);
        $sanitized = [
            'book' => $hypercite->book,
            'hyperciteId' => $hypercite->hyperciteId,
            'node_id' => $hypercite->node_id ?? [],
            'charData' => $hypercite->charData ?? (object) [],
            'citedIN' => $hypercite->citedIN ?? [],
            'hypercitedHTML' => $hypercite->hypercitedHTML,
            'hypercitedText' => $hypercite->hypercitedText,
            'relationshipStatus' => $hypercite->relationshipStatus,
            'time_since' => $hypercite->time_since,
            'raw_json' => $rawJson,
            'creator' => $hypercite->creator,
            'is_user_hypercite' => $isUserHypercite,
        ];

        if ($request->query('scope') === 'record') {
            return response()->json(['hypercite' => $sanitized]);
        }

        // Fetch ALL nodes for the entire book (legacy full variant for resolveHypercite).
        $allNodes = PgNode::where('book', $bookId)->get();

        if ($allNodes->isEmpty()) {
            // This is a critical data error if the hypercite exists but the book content doesn't.
            Log::error("Data inconsistency: Hypercite '{$hyperciteId}' found, but NO nodes exist for book '{$bookId}'.");
            return response()->json(['error' => 'Source document content is missing.'], 404);
        }

        Log::info("Hypercite and all " . $allNodes->count() . " parent nodes found for: {$hyperciteId}");

        return response()->json([
            'hypercite' => $sanitized,
            'nodes' => $allNodes,
        ]);
    }

    private function cleanItemForStorage($item)
    {
        $cleanItem = is_array($item) ? $item : (array) $item;

        // Remove raw_json to prevent recursive nesting
        unset($cleanItem['raw_json']);

        // Remove any other problematic nested fields
        unset($cleanItem['full_library_array']);

        // 🔒 raw_json is returned by the read API, so sanitise its HTML too.
        if (isset($cleanItem['hypercitedHTML'])) {
            $cleanItem['hypercitedHTML'] = NodeHtmlSanitizer::clean($cleanItem['hypercitedHTML']);
        }

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

        // Use SECURITY DEFINER function to bypass RLS for this specific update.
        // Best-effort: a failure to bump the freshness signal must NEVER fail the
        // citation save itself (mirrors refreshAnnotationIndex). A per-book try
        // means one bad book id can't skip the others.
        foreach ($uniqueBookIds as $bookId) {
            try {
                DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, $now]);
            } catch (\Throwable $e) {
                Log::warning('Failed to bump annotations_updated_at (hypercites)', [
                    'book' => $bookId,
                    'error' => $e->getMessage(),
                ]);
            }
        }

        Log::info('Updated annotations_updated_at for books (hypercites)', [
            'books' => $uniqueBookIds,
            'timestamp' => $now
        ]);
    }
}
