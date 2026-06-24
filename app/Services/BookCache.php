<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;

/**
 * File-based, per-book cache of the USER-INDEPENDENT slice of the reader payload.
 *
 * The reader's read endpoints (DatabaseToIndexedDBController) serve node content, the
 * chunk manifest, footnotes, bibliography and the library record. Of those, everything
 * EXCEPT the per-requester annotation arrays (hyperlights/hypercites) and the per-requester
 * `is_owner` flag is identical for every reader and changes only when the book's content
 * changes. This service stores that slice as JSON files on disk and serves it when fresh,
 * removing the node-content query from Postgres on the hot read path.
 *
 *   storage/app/cache/books/{bookId}/
 *     meta.json          { "timestamp": <library.timestamp this cache was built from> }
 *     library.json       getLibrary() output MINUS is_owner (recomputed at serve time)
 *     manifest.json      the chunk_manifest array
 *     footnotes.json     getFootnotes() output (or null sentinel)
 *     bibliography.json  getBibliography() output (or null sentinel)
 *     index.json         { <target id> : <chunk_id> } for deep-link resolution
 *     chunks/{chunkId}.json   base nodes (NO hyperlights/hypercites arrays)
 *
 * Freshness: a read does one cheap `SELECT timestamp FROM library WHERE book = ?` and
 * compares it to meta.json. `>=` → HIT (serve files, merge live annotations). Otherwise
 * MISS → caller runs the live Postgres path and (re)warms. Correctness rests on every
 * content write advancing `library.timestamp` (see plan §1a); annotations are NEVER cached,
 * so `annotations_updated_at` is irrelevant here.
 *
 * NOTE: the "base node" shape and the annotation-merge live here as the single source of
 * truth, so the live path, the warm path and the cache-HIT path cannot drift apart.
 */
class BookCache
{
    /** Root under storage/app. */
    private const ROOT = 'cache/books';

    /** Nodes per chunk file are grouped by this column. */
    private const NULL_SENTINEL = '__null__';

    /**
     * Absolute path to a book's cache directory. `bookId` may contain a single '/'
     * (sub-books like `book_x/Fn1`); mirror the existing markdown convention and allow it
     * as a nested directory, but reject traversal.
     */
    private function dir(string $bookId): string
    {
        if (str_contains($bookId, '..') || str_contains($bookId, "\0")) {
            throw new \InvalidArgumentException("Unsafe book id for cache path: {$bookId}");
        }
        return storage_path('app/' . self::ROOT . '/' . $bookId);
    }

    private function chunkPath(string $bookId, float $chunkId): string
    {
        // chunk_id is decimal-capable (fractional indexing). Use a stable string form;
        // rtrim avoids "3.0" vs "3" mismatches.
        $key = rtrim(rtrim(sprintf('%.6f', $chunkId), '0'), '.');
        return $this->dir($bookId) . '/chunks/' . $key . '.json';
    }

    // ───────────────────────────── freshness ─────────────────────────────

    /** The cheap live probe: the current content timestamp for a book, or null if no row. */
    public function freshTimestamp(string $bookId): ?int
    {
        $row = DB::table('library')->where('book', $bookId)->value('timestamp');
        return $row === null ? null : (int) $row;
    }

    /**
     * Is the on-disk cache present and at least as new as `$liveTs`?
     * A null `$liveTs` (no library row) is never fresh.
     */
    public function isFresh(string $bookId, ?int $liveTs): bool
    {
        if ($liveTs === null) {
            return false;
        }
        $meta = $this->readJson($this->dir($bookId) . '/meta.json');
        if (!is_array($meta) || !isset($meta['timestamp'])) {
            return false;
        }
        return (int) $meta['timestamp'] >= $liveTs;
    }

    // ───────────────────────────── readers ─────────────────────────────

    /** Base nodes for one chunk (NO annotation arrays), or null if not cached. */
    public function getChunk(string $bookId, float $chunkId): ?array
    {
        $data = $this->readJson($this->chunkPath($bookId, $chunkId));
        return is_array($data) ? $data : null;
    }

    public function getManifest(string $bookId): ?array
    {
        $data = $this->readJson($this->dir($bookId) . '/manifest.json');
        return is_array($data) ? $data : null;
    }

    /** Cached library MINUS is_owner; caller recomputes is_owner per requester. */
    public function getLibraryBase(string $bookId): ?array
    {
        $data = $this->readJson($this->dir($bookId) . '/library.json');
        return is_array($data) ? $data : null;
    }

    /** Footnotes payload; null when the book has none (a null file is written as a sentinel). */
    public function getFootnotes(string $bookId): ?array
    {
        return $this->readNullableJson($this->dir($bookId) . '/footnotes.json');
    }

    public function getBibliography(string $bookId): ?array
    {
        return $this->readNullableJson($this->dir($bookId) . '/bibliography.json');
    }

    /** Deep-link index { target id : chunk_id }, or null if not cached. */
    public function getIndex(string $bookId): ?array
    {
        $data = $this->readJson($this->dir($bookId) . '/index.json');
        return is_array($data) ? $data : null;
    }

    // ───────────────────────── base-node shape (single source of truth) ─────────────────────────

    /**
     * Map a raw `nodes` row to the USER-INDEPENDENT wire node (no hyperlights/hypercites).
     * This is the exact node shape the controller emits, minus the per-user annotation arrays.
     *
     * @param object $row a `DB::table('nodes')` row
     * @return array<string, mixed>
     */
    public static function baseNode(object $row): array
    {
        return [
            'book'      => $row->book,
            'chunk_id'  => (float) $row->chunk_id,
            'startLine' => (float) $row->startLine,
            'node_id'   => $row->node_id,
            'content'   => $row->content,
            'plainText' => $row->plainText,
            'type'      => $row->type,
            'footnotes' => json_decode($row->footnotes ?? '[]', true),
            'raw_json'  => json_decode($row->raw_json ?? '{}', true),
        ];
    }

    /**
     * Splice per-requester annotation arrays onto base nodes. Used by the live path AND the
     * cache-HIT path so the merged shape is identical regardless of source.
     *
     * @param array<int, array<string,mixed>> $baseNodes  output of baseNode()
     * @param array<string, array<int, array<string,mixed>>> $hyperlightsByNode  keyed by node_id
     * @param array<string, array<int, array<string,mixed>>> $hypercitesByNode   keyed by node_id
     * @return array<int, array<string,mixed>>
     */
    public static function mergeAnnotations(array $baseNodes, array $hyperlightsByNode, array $hypercitesByNode): array
    {
        foreach ($baseNodes as &$node) {
            $uuid = $node['node_id'];
            $node['hypercites']  = $hypercitesByNode[$uuid] ?? [];
            $node['hyperlights'] = array_values($hyperlightsByNode[$uuid] ?? []);
        }
        unset($node);
        return $baseNodes;
    }

    // ───────────────────────────── warm / invalidate ─────────────────────────────

    /**
     * Rebuild every cache file for a book from current Postgres state. Idempotent and
     * self-correcting: always reflects the DB at call time. Guarded by a short lock so two
     * concurrent misses don't both rebuild. Failures are swallowed (cache is best-effort —
     * the caller already served from the live path).
     */
    public function warm(string $bookId): void
    {
        $lock = Cache::lock("bookcache:warm:{$bookId}", 30);
        if (!$lock->get()) {
            return; // another worker is already warming this book
        }
        try {
            $liveTs = $this->freshTimestamp($bookId);
            if ($liveTs === null) {
                return; // no library row → nothing to cache
            }

            $rows = DB::table('nodes')
                ->where('book', $bookId)
                ->orderBy('chunk_id')
                ->orderBy('startLine')
                ->get();

            if ($rows->isEmpty()) {
                return; // no content yet (e.g. import still running)
            }

            $dir = $this->dir($bookId);
            $this->ensureDir($dir . '/chunks');

            // Group base nodes by chunk_id and build the deep-link index in one pass.
            $byChunk = [];           // chunkKey => ['chunk_id'=>float, 'nodes'=>[], 'first'=>, 'last'=>, 'count'=>]
            $index = [];             // target id => chunk_id
            $nodeIdToChunk = [];     // node_id => chunk_id (for hypercite/hyperlight resolution)

            foreach ($rows as $row) {
                $chunkId = (float) $row->chunk_id;
                $startLine = (float) $row->startLine;
                $key = (string) $chunkId;

                if (!isset($byChunk[$key])) {
                    $byChunk[$key] = ['chunk_id' => $chunkId, 'nodes' => [], 'first' => $startLine, 'last' => $startLine, 'count' => 0];
                }
                $byChunk[$key]['nodes'][] = self::baseNode($row);
                $byChunk[$key]['first'] = min($byChunk[$key]['first'], $startLine);
                $byChunk[$key]['last']  = max($byChunk[$key]['last'], $startLine);
                $byChunk[$key]['count']++;

                $nodeIdToChunk[$row->node_id] = $chunkId;
                // Heading anchor id (TOC "#chapter-3" deep-link target) → chunk. Selective: ONLY a
                // node that IS a heading (<h1-6 id="…">), not every inline id (those bloat the index
                // and aren't navigated). Same regex as getBookHeadings. Added BEFORE the startLine
                // entry so a canonical numeric startLine→chunk wins any rare numeric-id collision.
                if (preg_match('/^<h[1-6][^>]*\sid="([^"]+)"/i', $row->content ?? '', $hm) && $hm[1] !== '') {
                    $index[$hm[1]] = $chunkId;
                }
                // startLine → chunk (numeric deep-link target)
                $index[$this->numKey($startLine)] = $chunkId;
                // footnote ids living in this node → chunk
                foreach (json_decode($row->footnotes ?? '[]', true) ?: [] as $fnId) {
                    if (is_string($fnId) && $fnId !== '') {
                        $index[$fnId] = $chunkId;
                    }
                }
            }

            // Write one file per chunk + the manifest.
            $manifest = [];
            foreach ($byChunk as $entry) {
                $this->writeJson(
                    $this->chunkPath($bookId, $entry['chunk_id']),
                    $entry['nodes']
                );
                $manifest[] = [
                    'chunk_id'   => $entry['chunk_id'],
                    'first_line' => $entry['first'],
                    'last_line'  => $entry['last'],
                    'node_count' => $entry['count'],
                ];
            }
            usort($manifest, fn($a, $b) => $a['chunk_id'] <=> $b['chunk_id']);
            $this->writeJson($dir . '/manifest.json', $manifest);

            // hypercite_/HL_ → chunk via their first node_id.
            $this->indexAnnotations($bookId, 'hypercites', 'hyperciteId', $nodeIdToChunk, $index);
            $this->indexAnnotations($bookId, 'hyperlights', 'hyperlight_id', $nodeIdToChunk, $index);
            $this->writeJson($dir . '/index.json', $index);

            // Footnotes / bibliography / library — reuse the controller's exact LOAD shapes.
            $this->writeNullableJson($dir . '/footnotes.json', $this->buildFootnotes($bookId));
            $this->writeNullableJson($dir . '/bibliography.json', $this->buildBibliography($bookId));
            $this->writeJson($dir . '/library.json', $this->buildLibraryBase($bookId));

            // Stamp last so a reader never sees a "fresh" meta over half-written files.
            $this->writeJson($dir . '/meta.json', ['timestamp' => $liveTs]);

            Log::info('📦 BookCache warmed', ['book' => $bookId, 'chunks' => count($manifest), 'timestamp' => $liveTs]);
        } catch (\Throwable $e) {
            Log::warning('BookCache warm failed (serving stays on live path)', [
                'book' => $bookId,
                'error' => $e->getMessage(),
            ]);
        } finally {
            optional($lock)->release();
        }
    }

    /** Delete a book's cache directory. Staleness handles correctness, so this is optional. */
    public function invalidate(string $bookId): void
    {
        $dir = $this->dir($bookId);
        if (is_dir($dir)) {
            $this->rrmdir($dir);
        }
    }

    /**
     * Best-effort incremental update of the deep-link index for annotations created AFTER the last
     * warm (warm only rebuilds on a content change, so a new hypercite/hyperlight isn't in the index).
     * Merges id→chunk into index.json IFF it exists (cache warm); no-op if absent — the next warm
     * rebuilds it and the live resolver fallback covers the gap meanwhile. Lock-guarded against the
     * read-modify-write race; a dropped update is harmless (live fallback). Never throws to the caller.
     *
     * @param array<string, float|int> $idToChunk  e.g. ['hypercite_x' => 200.0]
     */
    public function addToIndex(string $bookId, array $idToChunk): void
    {
        if (empty($idToChunk)) {
            return;
        }
        $path = $this->dir($bookId) . '/index.json';
        if (!is_file($path)) {
            return; // cache cold → nothing to keep fresh; warm() will build the index
        }
        $lock = Cache::lock("bookcache:index:{$bookId}", 5);
        if (!$lock->get()) {
            return; // contended → skip; the live fallback covers this id until the next read/warm
        }
        try {
            $index = $this->readJson($path);
            if (!is_array($index)) {
                return;
            }
            $changed = false;
            foreach ($idToChunk as $id => $chunkId) {
                if ($id === '') {
                    continue;
                }
                if (!isset($index[$id]) || (float) $index[$id] !== (float) $chunkId) {
                    $index[$id] = (float) $chunkId;
                    $changed = true;
                }
            }
            if ($changed) {
                $this->writeJson($path, $index);
            }
        } catch (\Throwable $e) {
            Log::warning('BookCache addToIndex failed (live fallback covers it)', [
                'book' => $bookId, 'error' => $e->getMessage(),
            ]);
        } finally {
            optional($lock)->release();
        }
    }

    /**
     * Resolve `[id => firstNodeId]` to `[id => chunkId]` in ONE query — for `addToIndex` on annotation
     * create (the annotation's chunk = the chunk of its first node).
     *
     * @param array<string, ?string> $idToFirstNodeId
     * @return array<string, float>
     */
    public function chunkIdsForNodes(string $bookId, array $idToFirstNodeId): array
    {
        $nodeIds = array_values(array_filter(array_unique($idToFirstNodeId)));
        if (empty($nodeIds)) {
            return [];
        }
        $nodeChunk = DB::table('nodes')->where('book', $bookId)->whereIn('node_id', $nodeIds)
            ->pluck('chunk_id', 'node_id'); // node_id => chunk_id
        $out = [];
        foreach ($idToFirstNodeId as $id => $nodeId) {
            if ($nodeId !== null && isset($nodeChunk[$nodeId])) {
                $out[$id] = (float) $nodeChunk[$nodeId];
            }
        }
        return $out;
    }

    // ───────────────────────────── warm helpers ─────────────────────────────

    /**
     * Map every annotation id of a table to the chunk of its first node_id.
     * @param array<string,float> $nodeIdToChunk
     * @param array<string,float> $index  (mutated)
     */
    private function indexAnnotations(string $bookId, string $table, string $idCol, array $nodeIdToChunk, array &$index): void
    {
        $rows = DB::table($table)->where('book', $bookId)->select($idCol, 'node_id')->get();
        foreach ($rows as $row) {
            $nodeIds = json_decode($row->node_id ?? '[]', true);
            if (!empty($nodeIds) && isset($nodeIdToChunk[$nodeIds[0]])) {
                $index[$row->$idCol] = $nodeIdToChunk[$nodeIds[0]];
            }
        }
    }

    /** @return array{book:string,data:array}|null — mirrors getFootnotes(). */
    private function buildFootnotes(string $bookId): ?array
    {
        $footnotes = DB::table('footnotes')->where('book', $bookId)->get();
        if ($footnotes->isEmpty()) {
            return null;
        }
        $data = [];
        foreach ($footnotes as $fn) {
            $data[$fn->footnoteId] = [
                'content'       => $fn->content,
                'preview_nodes' => $fn->preview_nodes ? json_decode($fn->preview_nodes, true) : null,
            ];
        }
        return ['book' => $bookId, 'data' => $data];
    }

    /** @return array{book:string,data:array}|null — mirrors getBibliography(). */
    private function buildBibliography(string $bookId): ?array
    {
        $references = DB::table('bibliography')
            ->leftJoin('library', 'bibliography.source_id', '=', 'library.book')
            ->select('bibliography.*', 'library.has_nodes as source_has_nodes')
            ->where('bibliography.book', $bookId)
            ->get();
        if ($references->isEmpty()) {
            return null;
        }
        $data = [];
        foreach ($references as $ref) {
            $data[$ref->referenceId] = [
                'content'             => $ref->content,
                'source_id'           => $ref->source_id ?? null,
                'canonical_source_id' => $ref->canonical_source_id ?? null,
                'source_has_nodes'    => isset($ref->source_has_nodes) ? (bool) $ref->source_has_nodes : null,
            ];
        }
        return ['book' => $bookId, 'data' => $data];
    }

    /**
     * The user-independent library record: getLibrary() output WITHOUT is_owner (recomputed
     * per requester at serve time) and WITHOUT creator_token (already stripped). `creator`
     * IS retained so the serve path can compute is_owner cheaply with no extra query.
     *
     * @return array<string,mixed>|null
     */
    private function buildLibraryBase(string $bookId): ?array
    {
        $library = DB::table('library')->where('book', $bookId)->first();
        if (!$library) {
            return null;
        }
        $rawJson = json_decode($library->raw_json ?? '{}', true);
        if (is_string($rawJson)) {
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
            'volume' => $library->volume,
            'issue' => $library->issue,
            'booktitle' => $library->booktitle,
            'chapter' => $library->chapter,
            'editor' => $library->editor,
            'timestamp' => $library->timestamp,
            'annotations_updated_at' => $library->annotations_updated_at ?? 0,
            'title' => $library->title,
            'type' => $library->type,
            'url' => $library->url,
            'year' => $library->year,
            'creator' => $library->creator,
            'visibility' => $library->visibility ?? 'public',
            'listed' => $library->listed ?? true,
            'license' => $library->license ?? null,
            'custom_license_text' => $library->custom_license_text ?? null,
            'gate_defaults' => $library->gate_defaults ? json_decode($library->gate_defaults, true) : null,
            'raw_json' => $rawJson,
            // is_owner intentionally omitted — recomputed at serve time.
        ];
    }

    private function numKey(float $startLine): string
    {
        return rtrim(rtrim(sprintf('%.6f', $startLine), '0'), '.');
    }

    // ───────────────────────────── filesystem primitives ─────────────────────────────

    private function ensureDir(string $dir): void
    {
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
    }

    /** Atomic write: tmp file in the same dir + rename (rename is atomic on the same fs). */
    private function writeJson(string $path, $data): void
    {
        $this->ensureDir(dirname($path));
        $tmp = $path . '.' . getmypid() . '.tmp';
        file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        rename($tmp, $path);
    }

    /** Write a payload that may legitimately be null (footnotes/bibliography) using a sentinel. */
    private function writeNullableJson(string $path, ?array $data): void
    {
        $this->writeJson($path, $data === null ? [self::NULL_SENTINEL => true] : $data);
    }

    private function readJson(string $path)
    {
        if (!is_file($path)) {
            return null;
        }
        $raw = file_get_contents($path);
        return $raw === false ? null : json_decode($raw, true);
    }

    /** Read a nullable payload: returns null for both "missing" and the null sentinel. */
    private function readNullableJson(string $path): ?array
    {
        $data = $this->readJson($path);
        if (!is_array($data) || isset($data[self::NULL_SENTINEL])) {
            return null;
        }
        return $data;
    }

    private function rrmdir(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $full = $dir . '/' . $entry;
            is_dir($full) ? $this->rrmdir($full) : @unlink($full);
        }
        @rmdir($dir);
    }
}
