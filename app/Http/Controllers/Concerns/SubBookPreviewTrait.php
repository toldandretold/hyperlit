<?php

namespace App\Http\Controllers\Concerns;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

trait SubBookPreviewTrait
{
    /**
     * Refresh the preview_nodes cache on the parent footnote or hyperlight record.
     *
     * Reads the first 5 nodes of the sub-book, enriches them with hyperlights and
     * hypercites, then writes the JSON array to the parent record's preview_nodes column.
     *
     * @param  string  $subBookId  e.g. "book_123/Fn456" or "book_123/HL_abc"
     */
    protected function updateSubBookPreviewNodes(string $subBookId): void
    {
        [$parentBook, $itemId] = explode('/', $subBookId, 2);

        // 1. Fetch the first 5 nodes for this sub-book
        $nodeRows = DB::table('nodes')
            ->where('book', $subBookId)
            ->orderBy('startLine')
            ->limit(5)
            ->get();

        if ($nodeRows->isEmpty()) {
            return;
        }

        $nodeIds = $nodeRows->pluck('node_id')->filter()->toArray();

        // 2. Fetch hyperlights that touch any of these nodes
        //    hyperlights.node_id is a JSON array of node UUIDs
        $hyperlightsByNode = [];
        if (!empty($nodeIds)) {
            $hyperlights = DB::table('hyperlights')
                ->where('book', $subBookId)
                ->where('hidden', false)
                ->get();

            foreach ($hyperlights as $hl) {
                $hlNodeIds = json_decode($hl->node_id ?? '[]', true);
                $charData  = json_decode($hl->charData  ?? '{}', true);

                foreach ($hlNodeIds as $nid) {
                    if (!in_array($nid, $nodeIds)) continue;
                    $nodeCharData = $charData[$nid] ?? null;
                    if (!$nodeCharData) continue;

                    $hyperlightsByNode[$nid][] = [
                        'highlightID' => $hl->hyperlight_id,
                        'charStart'   => $nodeCharData['charStart'],
                        'charEnd'     => $nodeCharData['charEnd'],
                        'annotation'  => $hl->annotation,
                        'preview_nodes' => $hl->preview_nodes
                            ? json_decode($hl->preview_nodes, true)
                            : null,
                        'time_since'  => $hl->time_since,
                        'hidden'      => false,
                        'is_user_highlight' => true,
                    ];
                }
            }
        }

        // 3. Fetch hypercites that touch any of these nodes
        $hypercitesByNode = [];
        if (!empty($nodeIds)) {
            $hypercites = DB::table('hypercites')
                ->where('book', $subBookId)
                ->get();

            foreach ($hypercites as $hc) {
                $hcNodeIds = json_decode($hc->node_id ?? '[]', true);
                $charData  = json_decode($hc->charData  ?? '{}', true);

                foreach ($hcNodeIds as $nid) {
                    if (!in_array($nid, $nodeIds)) continue;
                    $nodeCharData = $charData[$nid] ?? null;
                    if (!$nodeCharData) continue;

                    $hypercitesByNode[$nid][] = [
                        'hyperciteId'        => $hc->hyperciteId,
                        'charStart'          => $nodeCharData['charStart'],
                        'charEnd'            => $nodeCharData['charEnd'],
                        'relationshipStatus' => $hc->relationshipStatus,
                        'citedIN'            => json_decode($hc->citedIN ?? '[]', true),
                        'time_since'         => $hc->time_since,
                    ];
                }
            }
        }

        // 4. Build enriched preview node array
        $previewNodes = $nodeRows->map(fn($node) => [
            'book'        => $node->book,
            'chunk_id'    => (int) $node->chunk_id,
            'startLine'   => (float) $node->startLine,
            'node_id'     => $node->node_id,
            'content'     => $node->content,
            'footnotes'   => json_decode($node->footnotes ?? '[]', true),
            'hyperlights' => array_values($hyperlightsByNode[$node->node_id] ?? []),
            'hypercites'  => array_values($hypercitesByNode[$node->node_id]  ?? []),
        ])->toArray();

        // 5. Write to parent record — HL_ → hyperlights table, Fn → footnotes table
        if (str_starts_with($itemId, 'HL_')) {
            DB::table('hyperlights')
                ->where('book', $parentBook)
                ->where('hyperlight_id', $itemId)
                ->update(['preview_nodes' => json_encode($previewNodes)]);
            Log::info('Updated hyperlight preview_nodes', ['sub_book' => $subBookId]);
        } elseif (str_starts_with($itemId, 'Fn')) {
            DB::table('footnotes')
                ->where('book', $parentBook)
                ->where('footnoteId', $itemId)
                ->update(['preview_nodes' => json_encode($previewNodes)]);
            Log::info('Updated footnote preview_nodes', ['sub_book' => $subBookId]);
        } else {
            Log::warning('updateSubBookPreviewNodes: unrecognised itemId pattern', [
                'sub_book' => $subBookId,
                'itemId'   => $itemId,
            ]);
        }
    }
}
