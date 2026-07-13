<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Jobs\QueueBookEmbeddings;
use App\Models\PgFootnote;
use App\Models\PgLibrary;
use App\Models\PgNode;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Persists already-generated conversion artifacts (nodes.json / footnotes.json /
 * references.json in a book's markdown dir) into the database — WITHOUT re-running the
 * Python conversion.
 *
 * Used by the vibe-conversion "Use this conversion" accept path: vibe_convert.py has already
 * regenerated the artifacts with the patched pipeline, and we just need to swap them into the
 * DB. Replacing the nodes goes through `PgNode::delete()` + insert, which fires the
 * `nodes_versioning_trigger` → the prior conversion is archived to `nodes_history`, so the user
 * can revert via the existing version-history UX (NodeHistoryController / sourceButton.js).
 *
 * The save logic mirrors ImportController's private save*ToDatabase methods. (TODO once there's
 * DB-backed test coverage: have ImportController delegate here to remove the duplication — kept
 * separate for now to avoid touching the untested critical import path.)
 */
class ConversionArtifactSaver
{
    public function __construct(private FileHelpers $helpers) {}

    /** Swap nodes + footnotes + references for a book from its regenerated artifacts. */
    public function saveAll(string $path, string $bookId): void
    {
        $this->establishOwnerContext($bookId);
        $this->saveNodes($path, $bookId);
        $this->saveFootnotes($path, $bookId);
        $this->saveReferences($path, $bookId);

        // Unified image store ingest (docs/e2ee.md) — the vibe-apply path
        // regenerates artifacts (incl. {path}/media/) next to nodes.json.
        try {
            app(\App\Services\BookImageStore::class)->ingestFromDirectory($bookId, "{$path}/media", prune: true);
        } catch (\Throwable $e) {
            Log::warning('ConversionArtifactSaver: book image ingest failed', ['book' => $bookId, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Satisfy the row-level-security policies on nodes / bibliography / sub_books before writing.
     * Web requests get this from the SetDatabaseSessionContext middleware, but SERVER-SIDE callers
     * (the vibe auto-apply queue job) have no HTTP session — so the INSERT failed with "new row
     * violates row-level security policy for table nodes" and the new conversion was silently not saved.
     *
     * The policies authorise a write by **app.current_token** (NOT the username): for a LOGGED-IN owner
     * it must equal that user's `users.user_token` (the policy joins `library.creator = users.name`);
     * for an ANONYMOUS owner it's `library.creator_token`. We read the owner from library on the admin
     * connection (bypasses RLS) and set the session token on the default connection so the writes below
     * are authorised AS the owner. is_local=false → persists for this connection's saveAll.
     */
    private function establishOwnerContext(string $bookId): void
    {
        try {
            $lib = DB::connection('pgsql_admin')->table('library')->where('book', $bookId)
                ->first(['creator', 'creator_token']);
            if (!$lib) {
                return;
            }
            $token = null;
            if (!empty($lib->creator)) {
                // Logged-in owner: the RLS check is users.user_token, looked up via the creator name.
                $token = DB::connection('pgsql_admin')->table('users')
                    ->where('name', $lib->creator)->value('user_token');
                DB::statement("SELECT set_config('app.current_user', ?, false)", [$lib->creator]);
            }
            if (empty($token) && !empty($lib->creator_token)) {
                $token = (string) $lib->creator_token;   // anonymous owner
            }
            if (!empty($token)) {
                DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $token]);
            } else {
                Log::warning('ConversionArtifactSaver: no owner token for RLS context; save will likely fail',
                    ['book' => $bookId, 'creator' => $lib->creator]);
            }
        } catch (\Throwable $e) {
            Log::warning('ConversionArtifactSaver: could not establish owner RLS context', [
                'book' => $bookId, 'error' => $e->getMessage(),
            ]);
        }
    }

    public function saveNodes(string $path, string $bookId): void
    {
        try {
            $nodesPath = "{$path}/nodes.json";
            if (!File::exists($nodesPath)) {
                Log::warning('ConversionArtifactSaver: nodes.json not found', ['book' => $bookId]);
                return;
            }

            $nodesData = json_decode(File::get($nodesPath), true);

            // Delete existing chunks — fires nodes_versioning_trigger (archives to nodes_history).
            PgNode::where('book', $bookId)->delete();

            $insertData = [];
            $artifactRows = []; // full node shape for the nodes.json artifact (was nodes.raw_json)
            $now = now();
            $nodesPerChunk = 100;

            foreach ($nodesData as $index => $chunk) {
                $newStartLine = ($index + 1) * 100;
                $chunkIndex = floor($index / $nodesPerChunk);
                $newChunkId = $chunkIndex * 100;
                $nodeId = $this->helpers->generateNodeId($bookId);
                $content = $this->helpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

                $artifactRow = $chunk;
                $artifactRow['startLine'] = $newStartLine;
                $artifactRow['chunk_id'] = $newChunkId;
                $artifactRow['node_id'] = $nodeId;
                $artifactRow['content'] = $content;
                $artifactRows[] = $artifactRow;

                $insertData[] = [
                    'book' => $bookId,
                    'startLine' => $newStartLine,
                    'chunk_id' => $newChunkId,
                    'node_id' => $nodeId,
                    'content' => $content,
                    'footnotes' => json_encode($chunk['footnotes'] ?? []),
                    'plainText' => $chunk['plainText'] ?? '',
                    'type' => $chunk['type'] ?? 'p',
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }

            foreach (array_chunk($insertData, 500) as $batch) {
                PgNode::insert($batch);
            }

            QueueBookEmbeddings::dispatch($bookId);

            // Rewrite nodes.json with the renumbered values (matches import behaviour).
            File::put($nodesPath, json_encode($artifactRows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

            Log::info('ConversionArtifactSaver: saved nodes', ['book' => $bookId, 'count' => count($insertData)]);
        } catch (\Exception $e) {
            Log::error('ConversionArtifactSaver: failed to save nodes', [
                'book' => $bookId, 'error' => substr($e->getMessage(), 0, 500),
            ]);
            throw $e;
        }
    }

    public function saveFootnotes(string $path, string $bookId): void
    {
        try {
            $footnotesPath = "{$path}/footnotes.json";
            if (!File::exists($footnotesPath)) {
                return;
            }
            $footnotesData = json_decode(File::get($footnotesPath), true);
            if (empty($footnotesData)) {
                return;
            }
            $library = PgLibrary::where('book', $bookId)->first();
            if (!$library) {
                Log::warning('ConversionArtifactSaver: parent library not found', ['book' => $bookId]);
                return;
            }

            // Re-saving a conversion: clear this book's footnote sub-books from the PRIOR run FIRST (mirrors
            // saveNodes' delete-then-insert). Footnote ids are regenerated each conversion, so without this the
            // old sub-book node (same startLine=1) blocks the new insert on nodes_book_startline_unique and the
            // WHOLE save silently dies — the in-text markers then point at definitions that never reached the DB.
            $likeBook = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $bookId) . '/%';
            PgFootnote::where('book', $bookId)->delete();
            PgNode::where('book', 'like', $likeBook)->delete();
            PgLibrary::where('book', 'like', $likeBook)->where('type', 'sub_book')->delete();

            $enrichedForJson = [];
            foreach ($footnotesData as $footnote) {
                $footnoteId = $footnote['footnoteId'] ?? null;
                $content = $footnote['content'] ?? '';
                if (!$footnoteId) {
                    continue;
                }
                $subBookId = SubBookIdHelper::build($bookId, $footnoteId);
                $uuid = (string) Str::uuid();
                $plainText = strip_tags($content);
                $safeHtml = strip_tags($content, '<a><em><strong><i><b>');
                $nodeHtml = '<p data-node-id="' . e($uuid) . '" no-delete-id="please" '
                          . 'style="min-height:1.5em;">' . $safeHtml . '</p>';

                $previewNodes = [[
                    'book' => $subBookId, 'chunk_id' => 0, 'startLine' => 1.0, 'node_id' => $uuid,
                    'content' => $nodeHtml, 'footnotes' => [], 'hyperlights' => [], 'hypercites' => [],
                ]];

                $existing = PgFootnote::where('book', $bookId)->where('footnoteId', $footnoteId)->first();
                if ($existing) {
                    PgFootnote::where('book', $bookId)->where('footnoteId', $footnoteId)->update([
                        'content' => $content, 'sub_book_id' => $subBookId, 'preview_nodes' => $previewNodes,
                    ]);
                } else {
                    PgFootnote::create([
                        'book' => $bookId, 'footnoteId' => $footnoteId, 'content' => $content,
                        'sub_book_id' => $subBookId, 'preview_nodes' => $previewNodes,
                    ]);
                }

                PgLibrary::updateOrInsert(
                    ['book' => $subBookId],
                    [
                        'creator' => $library->creator, 'creator_token' => $library->creator_token,
                        'visibility' => $library->visibility, 'listed' => false,
                        'title' => "Annotation: {$footnoteId}", 'type' => 'sub_book', 'has_nodes' => true,
                        'raw_json' => json_encode([]), 'timestamp' => round(microtime(true) * 1000),
                        'updated_at' => now(), 'created_at' => now(),
                    ]
                );

                PgNode::updateOrCreate(
                    ['book' => $subBookId, 'startLine' => 1],   // one node per sub-book — match the UNIQUE key,
                    ['chunk_id' => 0, 'node_id' => $uuid,        // not a fresh uuid (which never matched → dup insert)
                     'content' => $nodeHtml, 'plainText' => $plainText]
                );

                $enrichedForJson[] = [
                    'footnoteId' => $footnoteId, 'content' => $content, 'preview_nodes' => $previewNodes,
                ];
            }

            File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            Log::info('ConversionArtifactSaver: saved footnotes', ['book' => $bookId, 'count' => count($enrichedForJson)]);
        } catch (\Exception $e) {
            // Do NOT swallow: a silent failure here let the in-text markers save while the DEFINITIONS did
            // not (footnotes did nothing in the reader) and the apply still reported success. Surface it.
            Log::error('ConversionArtifactSaver: failed to save footnotes', [
                'book' => $bookId, 'error' => substr($e->getMessage(), 0, 500),
            ]);
            throw $e;
        }
    }

    public function saveReferences(string $path, string $bookId): void
    {
        try {
            $referencesPath = "{$path}/references.json";
            if (!File::exists($referencesPath)) {
                return;
            }
            $referencesData = json_decode(File::get($referencesPath), true);
            if (empty($referencesData)) {
                return;
            }

            DB::table('bibliography')->where('book', $bookId)->delete();

            $now = now();
            $insertData = [];
            $skippedLong = 0;
            foreach ($referencesData as $ref) {
                $referenceId = $ref['referenceId'] ?? null;
                if (!$referenceId) {
                    continue;
                }
                // `referenceId` is varchar(255). A malformed key (e.g. bibliography over-extraction
                // concatenating a paragraph of words into one id) overflows it, and a single bad row
                // fails the WHOLE batch insert → 0 bibliography entries. Skip it so the valid refs still
                // save — a >255-char key can't match any real in-text citation anyway.
                if (strlen($referenceId) > 255 || strlen($ref['source_id'] ?? '') > 255) {
                    $skippedLong++;
                    continue;
                }
                $insertData[] = [
                    'book' => $bookId, 'referenceId' => $referenceId,
                    'source_id' => $ref['source_id'] ?? null, 'content' => $ref['content'] ?? '',
                    'created_at' => $now, 'updated_at' => $now,
                ];
            }

            $deduped = [];
            foreach ($insertData as $row) {
                $deduped[$row['referenceId']] = $row;
            }
            $insertData = array_values($deduped);

            foreach (array_chunk($insertData, 500) as $batch) {
                DB::table('bibliography')->insert($batch);
            }
            Log::info('ConversionArtifactSaver: saved references',
                ['book' => $bookId, 'count' => count($insertData), 'skipped_overlong' => $skippedLong]);
        } catch (\Exception $e) {
            // Do NOT swallow: a silent failure here let saveAll report "success" while the bibliography
            // stayed empty (the user was told the fix was applied when it wasn't). Surface it so the apply
            // reports honestly (apply_failed) instead of a false "improved".
            Log::error('ConversionArtifactSaver: failed to save references', [
                'book' => $bookId, 'error' => substr($e->getMessage(), 0, 500),
            ]);
            throw $e;
        }
    }
}
