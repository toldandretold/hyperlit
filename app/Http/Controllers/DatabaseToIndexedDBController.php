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
     * Get complete book data for IndexedDB import
     */
    public function getBookData(Request $request, string $bookId): JsonResponse
    {
        try {
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
                'nodeChunks' => $nodeChunks,
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

                if ($user) {
                    $q->orWhere('creator', $user->name);
                }

                if ($anonymousToken) {
                    $q->orWhere('creator_token', $anonymousToken);
                }
            });

        return $query->pluck('hyperlight_id')->toArray();
    }

    /**
     * Get node chunks for a book - matches your IndexedDB structure
     */
    private function getNodeChunks(string $bookId, array $visibleHyperlightIds): array
    {
        Log::info('🔍 getNodeChunks started', [
            'book_id' => $bookId,
            'visible_highlight_ids_count' => count($visibleHyperlightIds),
            'visible_highlight_ids' => $visibleHyperlightIds
        ]);

        // Get processed highlights with is_user_highlight flag
        $processedHighlights = $this->getHyperlights($bookId);
        Log::info('🔍 getNodeChunks: processed highlights retrieved', [
            'processed_highlights_count' => count($processedHighlights),
            'sample_highlight' => count($processedHighlights) > 0 ? $processedHighlights[0] : null
        ]);

        $highlightLookup = [];
        foreach ($processedHighlights as $highlight) {
            $highlightLookup[$highlight['hyperlight_id']] = $highlight;
        }
        Log::info('🔍 getNodeChunks: highlight lookup created', [
            'lookup_keys' => array_keys($highlightLookup)
        ]);

        $chunks = DB::table('node_chunks')
            ->where('book', $bookId)
            ->orderBy('chunk_id')
            ->get()
            ->map(function ($chunk) use ($visibleHyperlightIds, $highlightLookup, $bookId) {
                $chunkHyperlights = json_decode($chunk->hyperlights ?? '[]', true);
                Log::info('🔍 Processing chunk', [
                    'chunk_id' => $chunk->chunk_id,
                    'raw_hyperlights_count' => count($chunkHyperlights),
                    'raw_hyperlights' => $chunkHyperlights
                ]);

                $visibleChunkHyperlights = array_filter($chunkHyperlights, function($hl) use ($visibleHyperlightIds) {
                    $isVisible = isset($hl['highlightID']) && in_array($hl['highlightID'], $visibleHyperlightIds);
                    Log::info('🔍 Checking highlight visibility', [
                        'highlight_id' => $hl['highlightID'] ?? 'missing',
                        'is_visible' => $isVisible
                    ]);
                    return $isVisible;
                });

                Log::info('🔍 Visible chunk highlights after filtering', [
                    'chunk_id' => $chunk->chunk_id,
                    'visible_count' => count($visibleChunkHyperlights),
                    'visible_highlights' => $visibleChunkHyperlights
                ]);

                // Enrich highlights with is_user_highlight flag from processed highlights
                $enrichedHyperlights = array_map(function($hl) use ($highlightLookup) {
                    $highlightId = $hl['highlightID'] ?? null;
                    $foundInLookup = $highlightId && isset($highlightLookup[$highlightId]);
                    $isUserHighlight = $foundInLookup ? $highlightLookup[$highlightId]['is_user_highlight'] : false;
                    
                    Log::info('🔍 Enriching highlight', [
                        'highlight_id' => $highlightId,
                        'found_in_lookup' => $foundInLookup,
                        'is_user_highlight' => $isUserHighlight
                    ]);

                    if ($foundInLookup) {
                        $hl['is_user_highlight'] = $highlightLookup[$highlightId]['is_user_highlight'];
                    } else {
                        $hl['is_user_highlight'] = false; // Default to false if not found
                    }
                    return $hl;
                }, $visibleChunkHyperlights);

                Log::info('🔍 Final enriched highlights for chunk', [
                    'chunk_id' => $chunk->chunk_id,
                    'enriched_count' => count($enrichedHyperlights),
                    'enriched_highlights' => $enrichedHyperlights
                ]);

                return [
                    'book' => $chunk->book,
                    'chunk_id' => (int) $chunk->chunk_id,
                    'startLine' => (float) $chunk->startLine,
                    'content' => $chunk->content,
                    'plainText' => $chunk->plainText,
                    'type' => $chunk->type,
                    'footnotes' => json_decode($chunk->footnotes ?? '[]', true),
                    'hypercites' => json_decode($chunk->hypercites ?? '[]', true),
                    'hyperlights' => array_values($enrichedHyperlights),
                    'raw_json' => json_decode($chunk->raw_json ?? '{}', true),
                ];
            })
            ->toArray();

        Log::info('🔍 getNodeChunks completed', [
            'book_id' => $bookId,
            'total_chunks' => count($chunks),
            'chunks_with_highlights' => count(array_filter($chunks, function($c) { return count($c['hyperlights']) > 0; }))
        ]);

        return $chunks;
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

        // Convert to the format expected by the frontend
        $footnotesData = [];
        foreach ($footnotes as $footnote) {
            $footnotesData[$footnote->footnoteId] = $footnote->content;
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
            ->where('book', $bookId)
            ->get();

        if ($references->isEmpty()) {
            return null;
        }

        // Convert to the format expected by the frontend
        $bibliographyData = [];
        foreach ($references as $reference) {
            $bibliographyData[$reference->referenceId] = $reference->content;
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
                $isUserHighlight = false;
                if ($user && $hyperlight->creator === $user->name) {
                    $isUserHighlight = true;
                } elseif ($anonymousToken && $hyperlight->creator_token === $anonymousToken) {
                    $isUserHighlight = true;
                }
                
                Log::info('🔍 Processing hyperlight in getHyperlights', [
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'creator' => $hyperlight->creator,
                    'creator_token' => $hyperlight->creator_token ? 'present' : 'null',
                    'current_user_name' => $user ? $user->name : 'null',
                    'current_anon_token' => $anonymousToken ? 'present' : 'null',
                    'is_user_highlight' => $isUserHighlight
                ]);
                
                return [
                    'book' => $hyperlight->book,
                    'hyperlight_id' => $hyperlight->hyperlight_id,
                    'annotation' => $hyperlight->annotation,
                    'endChar' => $hyperlight->endChar,
                    'highlightedHTML' => $hyperlight->highlightedHTML,
                    'highlightedText' => $hyperlight->highlightedText,
                    'startChar' => $hyperlight->startChar,
                    'startLine' => $hyperlight->startLine,
                    'raw_json' => json_decode($hyperlight->raw_json ?? '{}', true),
                    'time_since' => $hyperlight->time_since,
                    'is_user_highlight' => $isUserHighlight, // Add this flag
                    'creator' => $hyperlight->creator,
                    'creator_token' => $hyperlight->creator_token
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
                    'citedIN' => json_decode($hypercite->citedIN ?? '[]', true),
                    'endChar' => $hypercite->endChar,
                    'hypercitedHTML' => $hypercite->hypercitedHTML,
                    'hypercitedText' => $hypercite->hypercitedText,
                    'relationshipStatus' => $hypercite->relationshipStatus,
                    'startChar' => $hypercite->startChar,
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

        Log::info('Library record from database', [
            'book_id' => $bookId,
            'timestamp' => $library->timestamp,
            'timestamp_type' => gettype($library->timestamp),
            'creator' => $library->creator,
            'creator_token' => $library->creator_token,
            'full_record' => (array) $library
        ]);

        return [
            'book' => $library->book,
            'author' => $library->author,
            'bibtex' => $library->bibtex,
            'citationID' => $library->citationID,
            'fileName' => $library->fileName,
            'fileType' => $library->fileType,
            'journal' => $library->journal,
            'note' => $library->note,
            'pages' => $library->pages,
            'publisher' => $library->publisher,
            'school' => $library->school,
            'timestamp' => $library->timestamp,
            'title' => $library->title,
            'type' => $library->type,
            'url' => $library->url,
            'year' => $library->year,
            'creator' => $library->creator,
            'creator_token' => $library->creator_token,
            'raw_json' => json_decode($library->raw_json ?? '{}', true),
        ];
    }

    /**
     * Get just library data for a specific book
     */
    public function getBookLibrary(Request $request, string $bookId): JsonResponse
    {
        try {
            Log::info('getBookLibrary called', ['book_id' => $bookId]);
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
            $chunkCount = DB::table('node_chunks')
                ->where('book', $bookId)
                ->count();

            if ($chunkCount === 0) {
                return response()->json([
                    'error' => 'Book not found'
                ], 404);
            }

            $latestUpdate = DB::table('node_chunks')
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
     * Get list of available books
     */
    public function getAvailableBooks(): JsonResponse
    {
        try {
            $books = DB::table('node_chunks')
                ->select('book')
                ->selectRaw('COUNT(*) as chunk_count')
                ->selectRaw('MAX(updated_at) as last_modified')
                ->groupBy('book')
                ->orderBy('book')
                ->get();

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