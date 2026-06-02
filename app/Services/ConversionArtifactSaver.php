<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Jobs\QueueBookEmbeddings;
use App\Models\PgFootnote;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
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
 * DB. Replacing the nodes goes through `PgNodeChunk::delete()` + insert, which fires the
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
        $this->saveNodes($path, $bookId);
        $this->saveFootnotes($path, $bookId);
        $this->saveReferences($path, $bookId);
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
            PgNodeChunk::where('book', $bookId)->delete();

            $insertData = [];
            $now = now();
            $nodesPerChunk = 100;

            foreach ($nodesData as $index => $chunk) {
                $newStartLine = ($index + 1) * 100;
                $chunkIndex = floor($index / $nodesPerChunk);
                $newChunkId = $chunkIndex * 100;
                $nodeId = $this->helpers->generateNodeId($bookId);
                $content = $this->helpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

                $rawJson = $chunk;
                $rawJson['startLine'] = $newStartLine;
                $rawJson['chunk_id'] = $newChunkId;
                $rawJson['node_id'] = $nodeId;
                $rawJson['content'] = $content;

                $insertData[] = [
                    'book' => $bookId,
                    'startLine' => $newStartLine,
                    'chunk_id' => $newChunkId,
                    'node_id' => $nodeId,
                    'content' => $content,
                    'footnotes' => json_encode($chunk['footnotes'] ?? []),
                    'plainText' => $chunk['plainText'] ?? '',
                    'type' => $chunk['type'] ?? 'p',
                    'raw_json' => json_encode($rawJson),
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }

            foreach (array_chunk($insertData, 500) as $batch) {
                PgNodeChunk::insert($batch);
            }

            QueueBookEmbeddings::dispatch($bookId);

            // Rewrite nodes.json with the renumbered values (matches import behaviour).
            $renumberedJson = array_map(fn ($r) => json_decode($r['raw_json'], true), $insertData);
            File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

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

                PgNodeChunk::updateOrCreate(
                    ['book' => $subBookId, 'node_id' => $uuid],
                    ['chunk_id' => 0, 'startLine' => 1, 'content' => $nodeHtml,
                     'plainText' => $plainText, 'raw_json' => json_encode([])]
                );

                $enrichedForJson[] = [
                    'footnoteId' => $footnoteId, 'content' => $content, 'preview_nodes' => $previewNodes,
                ];
            }

            File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            Log::info('ConversionArtifactSaver: saved footnotes', ['book' => $bookId, 'count' => count($enrichedForJson)]);
        } catch (\Exception $e) {
            Log::error('ConversionArtifactSaver: failed to save footnotes', [
                'book' => $bookId, 'error' => substr($e->getMessage(), 0, 500),
            ]);
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
            foreach ($referencesData as $ref) {
                $referenceId = $ref['referenceId'] ?? null;
                if (!$referenceId) {
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
            Log::info('ConversionArtifactSaver: saved references', ['book' => $bookId, 'count' => count($insertData)]);
        } catch (\Exception $e) {
            Log::error('ConversionArtifactSaver: failed to save references', [
                'book' => $bookId, 'error' => substr($e->getMessage(), 0, 500),
            ]);
        }
    }
}
