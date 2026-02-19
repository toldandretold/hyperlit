<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DatabaseToIndexedDBController extends Controller
{
    /**
     * Check book visibility using SECURITY DEFINER function (bypasses RLS).
     * This allows distinguishing between "book doesn't exist" and "book exists but is private".
     *
     * @return object|null Returns object with book_exists, visibility, creator, creator_token or null if book doesn't exist
     */
    private function checkBookVisibility(string $bookId): ?object
    {
        $result = DB::selectOne('SELECT * FROM check_book_visibility(?)', [$bookId]);
        return $result;
    }

    /**
     * Check authorization for a book and return appropriate error response if unauthorized.
     *
     * @return JsonResponse|null Returns error response if unauthorized, null if authorized
     */
    private function checkBookAuthorization(Request $request, string $bookId): ?JsonResponse
    {
        // Use SECURITY DEFINER function to bypass RLS and check if book exists
        $bookInfo = $this->checkBookVisibility($bookId);

        // Book doesn't exist at all
        if (!$bookInfo) {
            return response()->json([
                'error' => 'Book not found',
                'book_id' => $bookId
            ], 404);
        }

        // Book is deleted
        if ($bookInfo->visibility === 'deleted') {
            Log::info('🗑️ Deleted book accessed', [
                'book_id' => $bookId
            ]);

            return response()->json([
                'error' => 'book_deleted',
                'message' => 'This book has been deleted',
                'is_deleted' => true,
                'book_id' => $bookId
            ], 410);
        }

        // Book is private - check authorization
        if ($bookInfo->visibility === 'private') {
            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            $authorized = false;

            // Check creator (username-based auth)
            if ($user && $bookInfo->creator === $user->name) {
                $authorized = true;
                Log::info('📗 Private book access granted via username', [
                    'book_id' => $bookId,
                    'user' => $user->name
                ]);
            }
            // Check creator_token (anonymous token-based auth)
            elseif (!$user && $anonymousToken && $bookInfo->creator_token === $anonymousToken) {
                $authorized = true;
                Log::info('📗 Private book access granted via anonymous token', [
                    'book_id' => $bookId
                ]);
            }

            if (!$authorized) {
                Log::warning('🔒 Private book access denied', [
                    'book_id' => $bookId,
                    'user' => $user ? $user->name : 'anonymous',
                    'has_token' => !empty($anonymousToken)
                ]);

                return response()->json([
                    'error' => 'access_denied',
                    'message' => 'You do not have permission to access this private book',
                    'is_private' => true,
                    'book_id' => $bookId
                ], 403);
            }
        }

        // Authorized - no error response needed
        return null;
    }

    /**
     * Get complete book data for IndexedDB import
     */
    public function getBookData(Request $request, string $bookId): JsonResponse
    {
        try {
            // 🔒 CRITICAL: Check book visibility and access permissions (bypasses RLS)
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            // Now query with RLS - will return the record since user is authorized
            $library = DB::table('library')->where('book', $bookId)->first();

            $visibleHyperlightIds = $this->getVisibleHyperlightIds($bookId);

            // Get node chunks for this book, filtering the highlights within them
            $nodeChunks = $this->getNodeChunks($bookId, $visibleHyperlightIds);
            
            if (empty($nodeChunks)) {
                return response()->json([
                    'error' => 'No data found for book',
                    'book_id' => $bookId
                ], 404);
            }

            // Get footnotes for this book
            $footnotes = $this->getFootnotes($bookId);
            
            // Get bibliography/references for this book
            $bibliography = $this->getBibliography($bookId);
            
            // Get hyperlights for this book
            $hyperlights = $this->getHyperlights($bookId);
            
            // Get hypercites for this book
            $hypercites = $this->getHypercites($bookId);
            
            // Get library data for this book
            $library = $this->getLibrary($bookId);

            // Structure data for efficient IndexedDB import
            $response = [
                'nodes' => $nodeChunks,
                'footnotes' => $footnotes,
                'bibliography' => $bibliography,
                'hyperlights' => $hyperlights,
                'hypercites' => $hypercites,
                'library' => $library,
                'metadata' => [
                    'book_id' => $bookId,
                    'total_chunks' => count($nodeChunks),
                    'total_footnotes' => $footnotes ? count($footnotes['data'] ?? []) : 0,
                    'total_bibliography' => $bibliography ? count($bibliography['data'] ?? []) : 0,
                    'total_hyperlights' => count($hyperlights ?? []),
                    'total_hypercites' => count($hypercites ?? []),
                    'generated_at' => now()->toISOString(),
                ]
            ];

            return response()->json($response);

        } catch (\Exception $e) {
            Log::error('Error fetching book data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch book data'
            ], 500);
        }
    }

    private function getVisibleHyperlightIds(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');

        $query = DB::table('hyperlights')
            ->where('book', $bookId)
            ->where(function($q) use ($user, $anonymousToken) {
                $q->where('hidden', false);

                // Prioritized auth: username first, then token only if no username
                if ($user) {
                    // Logged-in user: show highlights with matching username OR highlights with no username but matching token
                    $q->orWhere(function($subQ) use ($user, $anonymousToken) {
                        $subQ->where('creator', $user->name);
                        // Also show highlights that were created anonymously but user took ownership
                        if ($anonymousToken) {
                            $subQ->orWhere(function($tokenQ) use ($anonymousToken) {
                                $tokenQ->whereNull('creator')
                                       ->where('creator_token', $anonymousToken);
                            });
                        }
                    });
                } elseif ($anonymousToken) {
                    // Anonymous user: only show highlights with no username but matching token
                    $q->orWhere(function($subQ) use ($anonymousToken) {
                        $subQ->whereNull('creator')
                             ->where('creator_token', $anonymousToken);
                    });
                }
            });

        return $query->pluck('hyperlight_id')->toArray();
    }

    /**
     * Get node chunks for a book - matches your IndexedDB structure
     */
    private function getNodeChunks(string $bookId, array $visibleHyperlightIds): array
    {

        // Get processed highlights with is_user_highlight flag
        $processedHighlights = $this->getHyperlights($bookId);

        $highlightLookup = [];
        foreach ($processedHighlights as $highlight) {
            $highlightLookup[$highlight['hyperlight_id']] = $highlight;
        }

        // Pre-fetch ALL hyperlights and hypercites for this book (avoid N+1 queries)
        $hyperlightsByNode = $this->getAllHyperlightsByNode($bookId, $visibleHyperlightIds, $highlightLookup);
        $hypercitesByNode = $this->getAllHypercitesByNode($bookId);

        $chunks = DB::table('nodes')
            ->where('book', $bookId)
            ->orderBy('chunk_id')
            ->get()
            ->map(function ($chunk) use ($hyperlightsByNode, $hypercitesByNode) {
                $nodeUUID = $chunk->node_id;

                // Get pre-fetched annotations for this node (O(1) lookup)
                $finalHyperlights = $hyperlightsByNode[$nodeUUID] ?? [];
                $finalHypercites = $hypercitesByNode[$nodeUUID] ?? [];

                return [
                    'book' => $chunk->book,
                    'chunk_id' => (int) $chunk->chunk_id,
                    'startLine' => (float) $chunk->startLine,
                    'node_id' => $chunk->node_id,
                    'content' => $chunk->content,
                    'plainText' => $chunk->plainText,
                    'type' => $chunk->type,
                    'footnotes' => json_decode($chunk->footnotes ?? '[]', true),
                    'hypercites' => $finalHypercites,
                    'hyperlights' => array_values($finalHyperlights),
                    'raw_json' => json_decode($chunk->raw_json ?? '{}', true),
                ];
            })
            ->toArray();

        Log::info('Node chunks loaded', [
            'book' => $bookId,
            'chunks' => count($chunks),
            'highlights' => count($hyperlightsByNode),
            'hypercites' => count($hypercitesByNode)
        ]);

        return $chunks;
    }

    /**
     * Fetch ALL hyperlights for a book in one query
     * Returns array indexed by node_id for O(1) lookup
     */
    private function getAllHyperlightsByNode(string $bookId, array $visibleIds, array $lookup): array
    {
        if (empty($visibleIds)) {
            return [];
        }

        // Query all hyperlights for this book
        $hyperlights = DB::table('hyperlights')
            ->where('book', $bookId)
            ->whereIn('hyperlight_id', $visibleIds)
            ->get();

        // Group by node_id
        $byNode = [];
        foreach ($hyperlights as $hl) {
            $nodeIds = json_decode($hl->node_id ?? '[]', true);
            $charData = json_decode($hl->charData ?? '{}', true);

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;

                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'highlightID' => $hl->hyperlight_id,
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'annotation' => $hl->annotation,
                    'preview_nodes' => $hl->preview_nodes
                        ? json_decode($hl->preview_nodes, true)
                        : null,
                    'time_since' => $hl->time_since,
                    'hidden' => $hl->hidden ?? false,
                    'is_user_highlight' => $lookup[$hl->hyperlight_id]['is_user_highlight'] ?? false
                ];
            }
        }

        return $byNode;
    }

    /**
     * Fetch ALL hypercites for a book in one query
     * Returns array indexed by node_id for O(1) lookup
     */
    private function getAllHypercitesByNode(string $bookId): array
    {
        // Query all hypercites for this book
        $hypercites = DB::table('hypercites')
            ->where('book', $bookId)
            ->get();

        // Group by node_id
        $byNode = [];
        foreach ($hypercites as $hc) {
            $nodeIds = json_decode($hc->node_id ?? '[]', true);
            $charData = json_decode($hc->charData ?? '{}', true);

            foreach ($nodeIds as $nodeUUID) {
                $nodeCharData = $charData[$nodeUUID] ?? null;

                if (!$nodeCharData) {
                    continue;
                }

                if (!isset($byNode[$nodeUUID])) {
                    $byNode[$nodeUUID] = [];
                }

                $byNode[$nodeUUID][] = [
                    'hyperciteId' => $hc->hyperciteId,
                    'charStart' => $nodeCharData['charStart'],
                    'charEnd' => $nodeCharData['charEnd'],
                    'relationshipStatus' => $hc->relationshipStatus,
                    'citedIN' => json_decode($hc->citedIN ?? '[]', true),
                    'time_since' => $hc->time_since
                ];
            }
        }

        return $byNode;
    }

    /**
     * Get footnotes for a book
     */
    private function getFootnotes(string $bookId): ?array
    {
        $footnotes = DB::table('footnotes')
            ->where('book', $bookId)
            ->get();

        if ($footnotes->isEmpty()) {
            return null;
        }

        $footnotesData = [];
        foreach ($footnotes as $footnote) {
            $footnotesData[$footnote->footnoteId] = [
                'content'       => $footnote->content,
                'preview_nodes' => $footnote->preview_nodes
                    ? json_decode($footnote->preview_nodes, true)
                    : null,
            ];
        }

        return [
            'book' => $bookId,
            'data' => $footnotesData,
        ];
    }

    /**
     * Get bibliography/references for a book
     */
    private function getBibliography(string $bookId): ?array
    {
        $references = DB::table('bibliography')
            ->leftJoin('library', 'bibliography.source_id', '=', 'library.book')
            ->select('bibliography.*', 'library.has_nodes as source_has_nodes')
            ->where('bibliography.book', $bookId)
            ->get();

        if ($references->isEmpty()) {
            return null;
        }

        // Convert to full record format including source_id for linked citations
        $bibliographyData = [];
        foreach ($references as $reference) {
            $bibliographyData[$reference->referenceId] = [
                'content' => $reference->content,
                'source_id' => $reference->source_id ?? null,
                'source_has_nodes' => $reference->source_has_nodes, // null → treated as true (backward compat)
            ];
        }

        return [
            'book' => $bookId,
            'data' => $bibliographyData,
        ];
    }

    /**
     * Get hyperlights for a book
     */
    private function getHyperlights(string $bookId): array
    {
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');

        Log::info('🔍 getHyperlights started', [
            'book_id' => $bookId,
            'user_id' => $user ? $user->id : null,
            'user_name' => $user ? $user->name : null,
            'is_logged_in' => !is_null($user),
            'anonymous_token' => $anonymousToken ? 'present' : 'null'
        ]);

        $hyperlights = DB::table('hyperlights')
            ->where('book', $bookId)
            ->where(function($query) use ($user, $anonymousToken) {
                $query->where('hidden', false);

                if ($user) {
                    $query->orWhere('creator', $user->name);
                }

                if ($anonymousToken) {
                    $query->orWhere('creator_token', $anonymousToken);
                }
            })
            ->orderBy('hyperlight_id')
            ->get()
            ->map(function ($hyperlight) use ($user, $anonymousToken, $bookId) {
                // Determine if this highlight belongs to the current user
                // Prioritized auth: if highlight has username (creator), ONLY use username-based auth
                $isUserHighlight = false;

                if ($hyperlight->creator) {
                    // Highlight has username - ONLY check username-based auth (ignore token)
                    $isUserHighlight = $user && $hyperlight->creator === $user->name;
                } elseif ($hyperlight->creator_token) {
                    // Highlight has no username, only token - check token-based auth
                    // This works for both anonymous users AND logged-in users who created pre-login
                    // (they still have the same anon_token cookie)
                    $isUserHighlight = $anonymousToken && $hyperlight->creator_token === $anonymousToken;
                }

                Log::info('🔍 Processing hyperlight in getHyperlights', [
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'creator' => $hyperlight->creator,
                    'creator_token' => $hyperlight->creator_token ? 'present' : 'null',
                    'current_user_name' => $user ? $user->name : 'null',
                    'current_anon_token' => $anonymousToken ? 'present' : 'null',
                    'is_user_highlight' => $isUserHighlight
                ]);

                // 🔒 SECURITY: Never expose creator_token in API responses
                // Only the owner needs to know ownership, which is indicated by is_user_highlight
                // Also sanitize raw_json to remove creator_token
                // Note: raw_json may be double-encoded (JSON string containing JSON string)
                $rawJson = json_decode($hyperlight->raw_json ?? '{}', true);
                if (is_string($rawJson)) {
                    // Double-encoded - decode again
                    $rawJson = json_decode($rawJson, true);
                }
                if (is_array($rawJson)) {
                    unset($rawJson['creator_token']);
                }

                return [
                    'book' => $hyperlight->book,
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'node_id' => json_decode($hyperlight->node_id ?? '[]', true),
                    'charData' => json_decode($hyperlight->charData ?? '{}', true),
                    'annotation' => $hyperlight->annotation,
                    'preview_nodes' => $hyperlight->preview_nodes
                        ? json_decode($hyperlight->preview_nodes, true)
                        : null,
                    'highlightedHTML' => $hyperlight->highlightedHTML,
                    'highlightedText' => $hyperlight->highlightedText,
                    'startLine' => $hyperlight->startLine,
                    'raw_json' => $rawJson,
                    'time_since' => $hyperlight->time_since,
                    'is_user_highlight' => $isUserHighlight,
                    'creator' => $hyperlight->creator,
                    // creator_token intentionally omitted - security sensitive
                ];
            })
            ->toArray();
        
        Log::info('🔍 getHyperlights completed', [
            'book_id' => $bookId,
            'total_count' => count($hyperlights),
            'user_highlights_count' => count(array_filter($hyperlights, function($h) { return $h['is_user_highlight']; })),
            'sample_highlight' => count($hyperlights) > 0 ? $hyperlights[0] : null
        ]);

        return $hyperlights;
    }

    /**
     * Get hypercites for a book
     */
    private function getHypercites(string $bookId): array
    {
        $hypercites = DB::table('hypercites')
            ->where('book', $bookId)
            ->orderBy('hyperciteId')
            ->get()
            ->map(function ($hypercite) {
                return [
                    'book' => $hypercite->book,
                    'hyperciteId' => $hypercite->hyperciteId,
                    'node_id' => json_decode($hypercite->node_id ?? '[]', true),
                    'charData' => json_decode($hypercite->charData ?? '{}', true),
                    'citedIN' => json_decode($hypercite->citedIN ?? '[]', true),
                    'hypercitedHTML' => $hypercite->hypercitedHTML,
                    'hypercitedText' => $hypercite->hypercitedText,
                    'relationshipStatus' => $hypercite->relationshipStatus,
                    'raw_json' => json_decode($hypercite->raw_json ?? '{}', true),
                ];
            })
            ->toArray();

        return $hypercites;
    }

    /**
     * Get library data for a book
     */
   private function getLibrary(string $bookId): ?array
    {
        $library = DB::table('library')
            ->where('book', $bookId)
            ->first();

        if (!$library) {
            return null;
        }

        // 🔒 SECURITY: Determine if current user owns this book
        $user = Auth::user();
        $anonymousToken = request()->cookie('anon_token');
        $isOwner = false;

        if ($library->creator) {
            // Book has username - check username-based auth
            $isOwner = $user && $library->creator === $user->name;
        } elseif ($library->creator_token) {
            // Book has no username, only token - check token-based auth for anonymous
            $isOwner = !$user && $anonymousToken && hash_equals($library->creator_token, $anonymousToken);
        }

        Log::info('Library record from database', [
            'book_id' => $bookId,
            'timestamp' => $library->timestamp,
            'timestamp_type' => gettype($library->timestamp),
            'creator' => $library->creator,
            'creator_token' => $library->creator_token ? 'present' : 'null',
            'is_owner' => $isOwner
        ]);

        // 🔒 SECURITY: Never expose creator_token in API responses
        // Use is_owner boolean instead so frontend knows ownership without seeing tokens
        // Also sanitize raw_json to remove creator_token
        // Note: raw_json may be double-encoded (JSON string containing JSON string)
        $rawJson = json_decode($library->raw_json ?? '{}', true);
        if (is_string($rawJson)) {
            // Double-encoded - decode again
            $rawJson = json_decode($rawJson, true);
        }
        if (is_array($rawJson)) {
            unset($rawJson['creator_token']);
        }

        return [
            'book' => $library->book,
            'author' => $library->author,
            'bibtex' => $library->bibtex,
            'fileName' => $library->fileName,
            'fileType' => $library->fileType,
            'journal' => $library->journal,
            'note' => $library->note,
            'pages' => $library->pages,
            'publisher' => $library->publisher,
            'school' => $library->school,
            'timestamp' => $library->timestamp,
            'annotations_updated_at' => $library->annotations_updated_at ?? 0,
            'title' => $library->title,
            'type' => $library->type,
            'url' => $library->url,
            'year' => $library->year,
            'creator' => $library->creator,
            // creator_token intentionally omitted - security sensitive
            'is_owner' => $isOwner,
            'visibility' => $library->visibility ?? 'public',
            'listed' => $library->listed ?? true,
            'raw_json' => $rawJson,
        ];
    }

    /**
     * Get just library data for a specific book
     */
    public function getBookLibrary(Request $request, string $bookId): JsonResponse
    {
        try {
            Log::info('getBookLibrary called', ['book_id' => $bookId]);

            // Library records (bibliographic metadata) are publicly accessible
            // even for private books, as they may be cited in public documents.
            // The privacy restriction applies to nodes (actual content), not citations.
            $libraryRecord = DB::table('library')->where('book', $bookId)->first();

            if (!$libraryRecord) {
                return response()->json([
                    'error' => 'Library record not found for book',
                    'book_id' => $bookId
                ], 404);
            }

            $library = $this->getLibrary($bookId);
            
            if (!$library) {
                return response()->json([
                    'error' => 'Library record not found for book',
                    'book_id' => $bookId
                ], 404);
            }

            Log::info('Returning library data to client', [
                'book_id' => $bookId,
                'timestamp_in_response' => $library['timestamp'] ?? 'NOT_SET',
                'full_library_array' => $library
            ]);

            return response()->json([
                'success' => true,
                'library' => $library,
                'book_id' => $bookId
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching library data', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'error' => 'Internal server error',
                'message' => 'Failed to fetch library data'
            ], 500);
        }
    }

    /**
     * Get just metadata for cache validation
     */
    public function getBookMetadata(Request $request, string $bookId): JsonResponse
    {
        try {
            // 🔒 CRITICAL: Check book visibility and access permissions (bypasses RLS)
            $authError = $this->checkBookAuthorization($request, $bookId);
            if ($authError) {
                return $authError;
            }

            $chunkCount = DB::table('nodes')
                ->where('book', $bookId)
                ->count();

            if ($chunkCount === 0) {
                return response()->json([
                    'error' => 'Book not found'
                ], 404);
            }

            $latestUpdate = DB::table('nodes')
                ->where('book', $bookId)
                ->max('updated_at');

            return response()->json([
                'book_id' => $bookId,
                'chunk_count' => $chunkCount,
                'last_modified' => $latestUpdate,
                'exists' => true,
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching book metadata', [
                'book_id' => $bookId,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }
    }

    /**
     * Get full sub-book data for IndexedDB import.
     * Sub-book IDs are two segments: {parentBook}/{subId} (e.g. TheBible/HL_12345).
     * Delegates to getBookData() with the reconstructed full ID.
     */
    public function getSubBookData(Request $request, string $parentBook, string $subId): JsonResponse
    {
        return $this->getBookData($request, $parentBook . '/' . $subId);
    }

    /**
     * Get sub-book metadata for cache validation.
     */
    public function getSubBookMetadata(Request $request, string $parentBook, string $subId): JsonResponse
    {
        return $this->getBookMetadata($request, $parentBook . '/' . $subId);
    }

    /**
     * Get sub-book library record.
     */
    public function getSubBookLibrary(Request $request, string $parentBook, string $subId): JsonResponse
    {
        return $this->getBookLibrary($request, $parentBook . '/' . $subId);
    }

    /**
     * Get list of available books
     * SECURITY: Only returns public books, or private books owned by the current user
     */
    public function getAvailableBooks(Request $request): JsonResponse
    {
        try {
            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            // Build query with visibility filtering
            $query = DB::table('nodes')
                ->join('library', 'nodes.book', '=', 'library.book')
                ->select('nodes.book')
                ->selectRaw('COUNT(*) as chunk_count')
                ->selectRaw('MAX(nodes.updated_at) as last_modified')
                ->where(function ($q) use ($user, $anonymousToken) {
                    // Public books are visible to everyone
                    $q->where('library.visibility', 'public');

                    // Private books visible only to owner
                    if ($user) {
                        $q->orWhere(function ($sub) use ($user) {
                            $sub->where('library.visibility', 'private')
                                ->where('library.creator', $user->name);
                        });
                    }

                    // Anonymous users can see their own private books via token
                    if ($anonymousToken) {
                        $q->orWhere(function ($sub) use ($anonymousToken) {
                            $sub->where('library.visibility', 'private')
                                ->where('library.creator_token', $anonymousToken);
                        });
                    }
                })
                // Exclude deleted books
                ->where('library.visibility', '!=', 'deleted')
                ->groupBy('nodes.book')
                ->orderBy('nodes.book');

            $books = $query->get();

            return response()->json([
                'books' => $books->toArray(),
                'total_books' => $books->count(),
            ]);

        } catch (\Exception $e) {
            Log::error('Error fetching available books', [
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => 'Internal server error'
            ], 500);
        }
    }
}