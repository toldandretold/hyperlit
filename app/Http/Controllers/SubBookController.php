<?php

namespace App\Http\Controllers;

use App\Models\PgHyperlight;
use App\Models\PgFootnote;
use App\Models\PgLibrary;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

class SubBookController extends Controller
{
    /**
     * Create a new sub-book for a hyperlight annotation or footnote.
     *
     * The sub-book ID is always derivable: {parentBook}/{itemId}
     * No sub_book_id column is needed on hyperlights or footnotes tables.
     *
     * POST /db/sub-books/create
     * Body: { type: 'hyperlight'|'footnote', parentBook: string, itemId: string, title?: string, previewContent?: string }
     */
    public function create(Request $request): JsonResponse
    {
        try {
            $validated = $request->validate([
                'type'           => 'required|in:hyperlight,footnote',
                'parentBook'     => 'required|string',
                'itemId'         => 'required|string',
                'title'          => 'nullable|string|max:500',
                'previewContent' => 'nullable|string',
            ]);

            $type       = $validated['type'];
            $parentBook = $validated['parentBook'];
            $itemId     = $validated['itemId'];
            $subBookId  = $parentBook . '/' . $itemId;

            // Verify the item belongs to the current user
            $authError = $this->checkItemOwnership($request, $type, $parentBook, $itemId);
            if ($authError) {
                return $authError;
            }

            [$creator, $creatorToken] = $this->getCreatorInfo($request);

            // Upsert library record for the sub-book
            PgLibrary::updateOrCreate(
                ['book' => $subBookId],
                [
                    'creator'       => $creator,
                    'creator_token' => $creatorToken,
                    'visibility'    => 'private',
                    'title'         => $validated['title'] ?? "Annotation: {$itemId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                ]
            );

            // Create initial node only if one doesn't exist yet
            $nodeExists = DB::table('nodes')->where('book', $subBookId)->exists();
            if (!$nodeExists) {
                $initialContent = $validated['previewContent'] ?? '';

                DB::table('nodes')->insert([
                    'book'       => $subBookId,
                    'chunk_id'   => 0,
                    'startLine'  => 1,
                    'node_id'    => (string) Str::uuid(),
                    'content'    => $initialContent,
                    'plainText'  => strip_tags($initialContent),
                    'raw_json'   => json_encode([]),
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }

            Log::info('SubBookController::create - success', [
                'sub_book_id' => $subBookId,
                'type'        => $type,
                'creator'     => $creator,
            ]);

            return response()->json([
                'success'   => true,
                'subBookId' => $subBookId,
            ]);

        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\Exception $e) {
            Log::error('SubBookController::create - exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to create sub-book',
            ], 500);
        }
    }

    /**
     * Lazy migration: convert an existing annotation/footnote HTML string
     * into proper nodes under a new sub-book.
     *
     * POST /db/sub-books/migrate-existing
     * Body: { type: 'hyperlight'|'footnote', parentBook: string, itemId: string, existingContent: string }
     */
    public function migrateExisting(Request $request): JsonResponse
    {
        try {
            $validated = $request->validate([
                'type'            => 'required|in:hyperlight,footnote',
                'parentBook'      => 'required|string',
                'itemId'          => 'required|string',
                'existingContent' => 'nullable|string',
            ]);

            $type       = $validated['type'];
            $parentBook = $validated['parentBook'];
            $itemId     = $validated['itemId'];
            $subBookId  = $parentBook . '/' . $itemId;

            // Verify the item belongs to the current user
            $authError = $this->checkItemOwnership($request, $type, $parentBook, $itemId);
            if ($authError) {
                return $authError;
            }

            // Already migrated — return success without touching anything
            if (DB::table('nodes')->where('book', $subBookId)->exists()) {
                return response()->json([
                    'success'   => true,
                    'subBookId' => $subBookId,
                    'message'   => 'Sub-book already exists',
                ]);
            }

            [$creator, $creatorToken] = $this->getCreatorInfo($request);

            PgLibrary::updateOrCreate(
                ['book' => $subBookId],
                [
                    'creator'       => $creator,
                    'creator_token' => $creatorToken,
                    'visibility'    => 'private',
                    'title'         => "Annotation: {$itemId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                ]
            );

            $existingContent = $validated['existingContent'] ?? '';

            DB::table('nodes')->insert([
                'book'       => $subBookId,
                'chunk_id'   => 0,
                'startLine'  => 1,
                'node_id'    => (string) Str::uuid(),
                'content'    => $existingContent,
                'plainText'  => strip_tags($existingContent),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            Log::info('SubBookController::migrateExisting - success', [
                'sub_book_id' => $subBookId,
                'type'        => $type,
                'creator'     => $creator,
            ]);

            return response()->json([
                'success'   => true,
                'subBookId' => $subBookId,
            ]);

        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\Exception $e) {
            Log::error('SubBookController::migrateExisting - exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to migrate existing annotation',
            ], 500);
        }
    }

    /**
     * Verify the hyperlight or footnote belongs to the current user.
     * Returns a JsonResponse error if not authorized, null if authorized.
     */
    private function checkItemOwnership(Request $request, string $type, string $parentBook, string $itemId): ?JsonResponse
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        if ($type === 'hyperlight') {
            $item = PgHyperlight::where('book', $parentBook)
                ->where('hyperlight_id', $itemId)
                ->first();

            if (!$item) {
                return response()->json(['success' => false, 'message' => 'Hyperlight not found'], 404);
            }

            $isOwner = false;
            if ($item->creator && $user) {
                $isOwner = $item->creator === $user->name;
            } elseif ($item->creator_token && $anonymousToken) {
                $isOwner = $item->creator_token === $anonymousToken;
            }

            if (!$isOwner) {
                return response()->json(['success' => false, 'message' => 'Not authorized'], 403);
            }
        } else {
            // footnote — check parent book ownership (footnotes don't have their own creator field)
            $library = PgLibrary::where('book', $parentBook)->first();

            if (!$library) {
                return response()->json(['success' => false, 'message' => 'Parent book not found'], 404);
            }

            $footnote = PgFootnote::where('book', $parentBook)
                ->where('footnoteId', $itemId)
                ->first();

            if (!$footnote) {
                return response()->json(['success' => false, 'message' => 'Footnote not found'], 404);
            }

            $isOwner = false;
            if ($library->creator && $user) {
                $isOwner = $library->creator === $user->name;
            } elseif ($library->creator_token && $anonymousToken) {
                $isOwner = $library->creator_token === $anonymousToken;
            }

            if (!$isOwner) {
                return response()->json(['success' => false, 'message' => 'Not authorized'], 403);
            }
        }

        return null;
    }

    /**
     * Get creator info from server-side auth state.
     * Returns [$creator, $creatorToken].
     */
    private function getCreatorInfo(Request $request): array
    {
        $user = Auth::user();

        if ($user) {
            return [$user->name, null];
        }

        return [null, $request->cookie('anon_token')];
    }
}
