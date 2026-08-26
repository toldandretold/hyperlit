<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Http\Controllers\Concerns\SubBookPreviewTrait;
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
    use SubBookPreviewTrait;
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
                'nodeId'         => 'nullable|string',
            ]);

            $type       = $validated['type'];
            $parentBook = $validated['parentBook'];
            $itemId     = $validated['itemId'];
            $subBookId  = SubBookIdHelper::build($parentBook, $itemId);

            // Verify the item belongs to the current user
            $authError = $this->checkItemOwnership($request, $type, $parentBook, $itemId);
            if ($authError) {
                return $authError;
            }

            [$creator, $creatorToken] = $this->getCreatorInfo($request);

            // E2EE (docs/e2ee.md): sub-books inherit the root book's encryption —
            // preview content arriving for an encrypted parent must be ciphertext.
            $parentEncrypted = \App\Services\E2ee\EncryptedBookGuard::isEncrypted($parentBook);
            if ($parentEncrypted) {
                \App\Services\E2ee\EncryptedBookGuard::rejectPlaintextWrites(
                    $parentBook,
                    [['previewContent' => $validated['previewContent'] ?? null]],
                    ['previewContent'],
                );
            }

            // Upsert library record for the sub-book. An EXISTING row's visibility is
            // always preserved (admin-connection read — RLS would hide another creator's
            // private row): a debounced annotation save must never re-publish a highlight
            // the user flipped to private via setVisibility().
            $existingVisibility = PgLibrary::on('pgsql_admin')
                ->where('book', $subBookId)
                ->value('visibility');
            PgLibrary::updateOrCreate(
                ['book' => $subBookId],
                [
                    'creator'       => $creator,
                    'creator_token' => $creatorToken,
                    'encrypted'     => $parentEncrypted,
                    'visibility'    => $existingVisibility ?? ($type === 'footnote'
                        ? ($this->getParentLibraryVisibility($parentBook) ?? 'private')
                        : 'public'),
                    'listed'        => false,
                    'title'         => $validated['title'] ?? "Annotation: {$itemId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                    'timestamp'     => 0,
                ]
            );

            // Create initial node only if one doesn't exist yet; always return nodeId
            $node = DB::table('nodes')->where('book', $subBookId)->first();
            if (!$node) {
                // Use client-provided nodeId if present, otherwise generate a UUID fallback
                $nodeId = $validated['nodeId'] ?? (string) Str::uuid();
                $previewText = strip_tags($validated['previewContent'] ?? '');
                $initialContent = '<p data-node-id="' . e($nodeId) . '" style="min-height:1.5em;">'
                                . e($previewText)
                                . '</p>';
                DB::table('nodes')->insert([
                    'book'       => $subBookId,
                    'chunk_id'   => 0,
                    'startLine'  => 1,
                    'node_id'    => $nodeId,
                    'content'    => $initialContent,
                    'plainText'  => $previewText,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            } else {
                $nodeId = $node->node_id;
            }

            // Populate preview_nodes on the parent footnote/hyperlight so the sub-book
            // renders immediately without needing a separate node-fetch round-trip.
            $this->updateSubBookPreviewNodes($subBookId);

            Log::info('SubBookController::create - success', [
                'sub_book_id' => $subBookId,
                'type'        => $type,
                'creator'     => $creator,
            ]);

            return response()->json([
                'success'   => true,
                'subBookId' => $subBookId,
                'nodeId'    => $nodeId,
            ]);

        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\Symfony\Component\HttpKernel\Exception\HttpException $e) {
            throw $e; // E2EE guard 422 — render via the framework handler
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
            $subBookId  = SubBookIdHelper::build($parentBook, $itemId);

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

            // Preserve an existing row's visibility (see create() — same clobber guard).
            $existingVisibility = PgLibrary::on('pgsql_admin')
                ->where('book', $subBookId)
                ->value('visibility');
            PgLibrary::updateOrCreate(
                ['book' => $subBookId],
                [
                    'creator'       => $creator,
                    'creator_token' => $creatorToken,
                    'visibility'    => $existingVisibility ?? ($type === 'footnote'
                        ? ($this->getParentLibraryVisibility($parentBook) ?? 'private')
                        : 'public'),
                    'title'         => "Annotation: {$itemId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                    'timestamp'     => 0,
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
     * Flip the visibility of a hyperlight's annotation sub-book — the write seam for
     * per-highlight privacy (a private annotation sub-book hides the WHOLE highlight,
     * mark included, from everyone but its creator: see the private-sub-book pass in
     * DatabaseToIndexedDBController::getHyperlights and the hyperlights RLS policy).
     *
     * Hyperlight sub-books only — footnote sub-books stay parent-inherited (the
     * trg_sync_footnote_sub_book_visibility trigger owns those). Authorized for the
     * HIGHLIGHT's creator, not the book owner. Writes ride the admin connection: the
     * library row may have been minted by SubBookRegistrar with the foundation owner
     * as creator, which default-connection RLS would make unwritable for the highlight
     * creator — and since the read paths key privacy off this row's creator, any
     * mismatched creator is corrected to the caller here.
     *
     * POST /db/sub-books/visibility
     * Body: { parentBook: string, itemId: 'HL_...', visibility: 'public'|'private' }
     */
    public function setVisibility(Request $request): JsonResponse
    {
        try {
            $validated = $request->validate([
                'parentBook' => 'required|string',
                'itemId'     => ['required', 'string', 'regex:/^HL_[A-Za-z0-9]+$/'],
                'visibility' => 'required|in:public,private',
            ]);

            $parentBook = $validated['parentBook'];
            $itemId     = $validated['itemId'];
            $visibility = $validated['visibility'];

            $item = PgHyperlight::where('book', $parentBook)
                ->where('hyperlight_id', $itemId)
                ->first();

            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');

            if ($item) {
                // Strict creator check (prioritized: a named creator ignores tokens).
                // Legacy rows with neither creator nor token are unownable.
                $isOwner = false;
                if ($item->creator) {
                    $isOwner = $user && $item->creator === $user->name;
                } elseif ($item->creator_token) {
                    $isOwner = $anonymousToken && $item->creator_token === $anonymousToken;
                }
                if (!$isOwner) {
                    return response()->json(['success' => false, 'message' => 'Not authorized'], 403);
                }
            }
            // Missing row = the debounced sync hasn't landed the just-created highlight
            // yet (the "flip private right after highlighting" flow). Same grace as
            // checkItemOwnership(): RequireAuthor verified authentication and a
            // brand-new highlight's creator IS the caller — allow the flip, but only
            // onto a sub-book row that doesn't exist yet or already belongs to the
            // caller (the existing-row guard below), so this path can't hijack rows.

            $subBookId = $item?->sub_book_id ?: SubBookIdHelper::build($parentBook, $itemId);
            [$creator, $creatorToken] = $this->getCreatorInfo($request);

            $library = PgLibrary::on('pgsql_admin')->where('book', $subBookId)->first();
            if (!$item && $library) {
                $rowIsCallers = ($library->creator && $creator && $library->creator === $creator)
                    || (!$library->creator && $library->creator_token && $library->creator_token === $creatorToken);
                if (!$rowIsCallers) {
                    return response()->json(['success' => false, 'message' => 'Not authorized'], 403);
                }
            }
            if ($library) {
                $library->visibility = $visibility;
                $library->creator = $creator;
                $library->creator_token = $creatorToken;
                $library->save();
            } else {
                // Metadata-only row: no node insertion here — create() adds the initial
                // node (and keeps this visibility) when an annotation is first written.
                PgLibrary::on('pgsql_admin')->create([
                    'book'          => $subBookId,
                    'creator'       => $creator,
                    'creator_token' => $creatorToken,
                    'encrypted'     => \App\Services\E2ee\EncryptedBookGuard::isEncrypted($parentBook),
                    'visibility'    => $visibility,
                    'listed'        => false,
                    'title'         => "Annotation: {$itemId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => DB::table('nodes')->where('book', $subBookId)->exists(),
                    'raw_json'      => json_encode([]),
                    'timestamp'     => 0,
                ]);
            }

            // Bump the PARENT book's annotations_updated_at (same SECURITY DEFINER
            // seam as highlight delete/hide) — clients compare it on book open to
            // decide whether to re-sync annotations. Without this, readers with the
            // book already in IDB never learn the highlight appeared (flip to
            // public) or keep rendering a stale copy (flip to private).
            DB::select('SELECT update_annotations_timestamp(?, ?)', [$parentBook, round(microtime(true) * 1000)]);

            Log::info('SubBookController::setVisibility - success', [
                'sub_book_id' => $subBookId,
                'visibility'  => $visibility,
                'creator'     => $creator,
            ]);

            return response()->json([
                'success'    => true,
                'subBookId'  => $subBookId,
                'visibility' => $visibility,
            ]);

        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\Exception $e) {
            Log::error('SubBookController::setVisibility - exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to set sub-book visibility',
            ], 500);
        }
    }

    /**
     * Look up the visibility of the parent library record.
     */
    private function getParentLibraryVisibility(string $parentBook): ?string
    {
        return PgLibrary::where('book', $parentBook)->value('visibility');
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
                // Hyperlight may not be synced to the server yet (newly created client-side).
                // Allow creation — the RequireAuthor middleware already verified authentication,
                // and the sub-book will be owned by the current user.
                return null;
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
            // footnote — ownership is determined by the parent book
            // The footnote row may not be synced to PostgreSQL yet (newly created client-side),
            // so we only check parent book ownership, not footnote record existence.
            $library = PgLibrary::where('book', $parentBook)->first();

            if (!$library) {
                return response()->json(['success' => false, 'message' => 'Parent book not found'], 404);
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
