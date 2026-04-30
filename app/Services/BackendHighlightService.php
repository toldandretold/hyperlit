<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class BackendHighlightService
{
    public function __construct(
        private FileHelpers $helpers,
    ) {}

    /**
     * Create a highlight with a sub-book annotation from the backend (no auth session).
     *
     * @param array $params {
     *   bookId, nodeId, text, highlightId, creator,
     *   annotation, subBookContent, subBookTitle,
     *   charStart (optional), charEnd (optional)
     * }
     * @return string|null The highlightId on success, null on failure
     */
    public function createHighlight(array $params): ?string
    {
        $bookId         = $params['bookId'];
        $nodeId         = $params['nodeId'];
        $text           = $params['text'];
        $highlightId    = $params['highlightId'];
        $creator        = $params['creator'];
        $annotation     = $params['annotation'];
        $subBookContent = $params['subBookContent'];
        $subBookTitle   = $params['subBookTitle'];
        $preCharStart   = $params['charStart'] ?? null;
        $preCharEnd     = $params['charEnd'] ?? null;

        $db = DB::connection('pgsql_admin');

        // 1. Fetch node's startLine (and plainText if we need to compute positions)
        $node = $db->table('nodes')
            ->where('book', $bookId)
            ->where('node_id', $nodeId)
            ->select(['plainText', 'startLine'])
            ->first();

        if (!$node) {
            Log::warning('BackendHighlightService: node not found', [
                'bookId' => $bookId,
                'nodeId' => $nodeId,
            ]);
            return null;
        }

        // 2. Use pre-computed positions or find text position
        if ($preCharStart !== null && $preCharEnd !== null) {
            $charStart = $preCharStart;
            $charEnd   = $preCharEnd;
        } else {
            if (!$node->plainText) {
                Log::warning('BackendHighlightService: empty plainText and no pre-computed positions', [
                    'nodeId' => $nodeId,
                ]);
                return null;
            }

            $decodedPlain = html_entity_decode($node->plainText, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $charStart = mb_strpos($decodedPlain, $text);
            if ($charStart === false) {
                // Fallback: normalise Unicode quotes/dashes for matching
                $normPlain = $this->normaliseQuotes($decodedPlain);
                $normText  = $this->normaliseQuotes($text);
                $charStart = mb_strpos($normPlain, $normText);
            }
            if ($charStart === false) {
                Log::debug('BackendHighlightService: text not found in node plainText', [
                    'nodeId' => $nodeId,
                    'text' => mb_substr($text, 0, 80),
                ]);
                return null;
            }
            $charEnd = $charStart + mb_strlen($text);
        }

        // 3. Build charData
        $charData = [$nodeId => ['charStart' => $charStart, 'charEnd' => $charEnd]];

        // 4. Build sub_book_id
        $subBookId = SubBookIdHelper::build($bookId, $highlightId);

        // 5. Upsert hyperlight record
        $now = now();
        $parent = $db->table('library')->where('book', $bookId)->first();

        $highlightData = [
            'sub_book_id'     => $subBookId,
            'node_id'         => json_encode([$nodeId]),
            'charData'        => json_encode($charData),
            'highlightedText' => $text,
            'annotation'      => $annotation,
            'startLine'       => $node->startLine,
            'creator'         => $creator,
            'creator_token'   => null,
            'time_since'      => floor(time()),
            'hidden'          => false,
            'raw_json'        => json_encode([
                'book'         => $bookId,
                'hyperlight_id' => $highlightId,
                'creator'      => $creator,
                'type'         => 'backend_highlight',
            ]),
            'updated_at'      => $now,
        ];

        $exists = $db->table('hyperlights')
            ->where('book', $bookId)
            ->where('hyperlight_id', $highlightId)
            ->exists();

        if ($exists) {
            $db->table('hyperlights')
                ->where('book', $bookId)
                ->where('hyperlight_id', $highlightId)
                ->update($highlightData);
        } else {
            $highlightData['book'] = $bookId;
            $highlightData['hyperlight_id'] = $highlightId;
            $highlightData['created_at'] = $now;
            $db->table('hyperlights')->insert($highlightData);
        }

        // 6. Update annotations_updated_at + timestamp so clients do a full re-sync
        $now_ms = round(microtime(true) * 1000);
        $db->table('library')
            ->where('book', $bookId)
            ->update([
                'annotations_updated_at' => $now_ms,
                'timestamp' => $now_ms,
            ]);

        // 7. Upsert library record for the sub-book (annotation sub-book)
        $libraryExists = $db->table('library')->where('book', $subBookId)->exists();
        $libraryData = [
            'title'         => $subBookTitle,
            'type'          => 'sub_book',
            'creator'       => $parent->creator ?? null,
            'creator_token' => $parent->creator_token ?? null,
            'visibility'    => 'public',
            'listed'        => false,
            'has_nodes'     => true,
            'timestamp'     => round(microtime(true) * 1000),
            'raw_json'      => json_encode(['type' => 'highlight_annotation', 'parent' => $bookId]),
            'updated_at'    => $now,
        ];

        if ($libraryExists) {
            $db->table('library')->where('book', $subBookId)->update($libraryData);
        } else {
            $libraryData['book'] = $subBookId;
            $libraryData['created_at'] = $now;
            $db->table('library')->insert($libraryData);
        }

        // 7. Delete old sub-book nodes, insert new ones
        $db->table('nodes')->where('book', $subBookId)->delete();

        $insertData = [];
        foreach ($subBookContent as $index => $nodeData) {
            $startLine = ($index + 1) * 100;
            $chunkId = 0;
            $newNodeId = $this->helpers->generateNodeId($subBookId);
            $content = $this->helpers->ensureNodeIdInContent(
                $nodeData['content'] ?? '',
                $startLine,
                $newNodeId
            );

            $insertData[] = [
                'book'       => $subBookId,
                'startLine'  => $startLine,
                'chunk_id'   => $chunkId,
                'node_id'    => $newNodeId,
                'content'    => $content,
                'footnotes'  => json_encode([]),
                'plainText'  => $nodeData['plainText'] ?? strip_tags($content),
                'type'       => $nodeData['type'] ?? 'p',
                'raw_json'   => json_encode([
                    'startLine' => $startLine,
                    'chunk_id'  => $chunkId,
                    'node_id'   => $newNodeId,
                    'content'   => $content,
                    'type'      => $nodeData['type'] ?? 'p',
                ]),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        if (!empty($insertData)) {
            foreach (array_chunk($insertData, 500) as $batch) {
                $db->table('nodes')->insert($batch);
            }
        }

        // 8. Build and cache preview_nodes
        $this->buildPreviewNodes($db, $subBookId, $bookId, $highlightId);

        return $highlightId;
    }

    /**
     * Delete all highlights by a creator prefix for a given book.
     * Also removes their sub-book nodes and library records.
     *
     * @return int Number of highlights deleted
     */
    public function deleteHighlightsByCreator(string $bookId, string $creatorPrefix): int
    {
        $db = DB::connection('pgsql_admin');

        $highlights = $db->table('hyperlights')
            ->where('book', $bookId)
            ->where('creator', 'LIKE', $creatorPrefix . '%')
            ->get(['hyperlight_id', 'sub_book_id']);

        if ($highlights->isEmpty()) {
            return 0;
        }

        $subBookIds = $highlights->pluck('sub_book_id')->filter()->toArray();
        $highlightIds = $highlights->pluck('hyperlight_id')->toArray();

        // Delete sub-book nodes
        if (!empty($subBookIds)) {
            $db->table('nodes')->whereIn('book', $subBookIds)->delete();
            $db->table('library')->whereIn('book', $subBookIds)->delete();
        }

        // Delete highlight records
        $deleted = $db->table('hyperlights')
            ->where('book', $bookId)
            ->whereIn('hyperlight_id', $highlightIds)
            ->delete();

        // Update annotations_updated_at + timestamp so clients do a full re-sync
        if ($deleted > 0) {
            $now_ms = round(microtime(true) * 1000);
            $db->table('library')
                ->where('book', $bookId)
                ->update([
                    'annotations_updated_at' => $now_ms,
                    'timestamp' => $now_ms,
                ]);
        }

        Log::info('BackendHighlightService: deleted highlights by creator', [
            'bookId' => $bookId,
            'creatorPrefix' => $creatorPrefix,
            'count' => $deleted,
        ]);

        return $deleted;
    }

    /**
     * Build the preview_nodes JSON cache for a sub-book highlight.
     * Same logic as SubBookPreviewTrait but using admin DB connection.
     */
    private function buildPreviewNodes($db, string $subBookId, string $bookId, string $highlightId): void
    {
        $nodeRows = $db->table('nodes')
            ->where('book', $subBookId)
            ->orderBy('startLine')
            ->limit(5)
            ->get();

        if ($nodeRows->isEmpty()) {
            return;
        }

        $previewNodes = $nodeRows->map(fn($node) => [
            'book'        => $node->book,
            'chunk_id'    => (int) $node->chunk_id,
            'startLine'   => (float) $node->startLine,
            'node_id'     => $node->node_id,
            'content'     => $node->content,
            'footnotes'   => json_decode($node->footnotes ?? '[]', true),
            'hyperlights' => [],
            'hypercites'  => [],
        ])->toArray();

        $previewJson = json_encode($previewNodes);

        $db->table('hyperlights')
            ->where('book', $bookId)
            ->where('hyperlight_id', $highlightId)
            ->update(['preview_nodes' => $previewJson]);
    }

    /**
     * Normalise Unicode quotes and dashes to ASCII equivalents.
     * Uses 1-to-1 character replacements only — no whitespace collapsing,
     * so mb_strlen and character positions are preserved.
     */
    private function normaliseQuotes(string $s): string
    {
        $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        // Smart quotes and apostrophes → ASCII (all 1-to-1 replacements)
        $s = str_replace(
            ["\u{2018}", "\u{2019}", "\u{201A}", "\u{201B}", "\u{2032}", "\u{02BC}", "\u{FF07}"],
            "'", $s
        );
        $s = str_replace(
            ["\u{201C}", "\u{201D}", "\u{201E}", "\u{201F}", "\u{2033}", "\u{00AB}", "\u{00BB}"],
            '"', $s
        );
        // All dash-like characters → ASCII hyphen (all single code point)
        $s = str_replace(
            ["\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{FE58}", "\u{FF0D}"],
            '-', $s
        );
        return $s;
    }
}
