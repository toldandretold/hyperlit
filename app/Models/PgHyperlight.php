<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgHyperlight extends Model
{
    protected $table = 'hyperlights';

    /**
     * 🔒 SECURITY: Hide creator_token from JSON responses
     * This prevents token leakage via API responses
     */
    protected $hidden = ['creator_token'];

    protected $fillable = [
        'book',
        'sub_book_id',
        'hyperlight_id',
        'node_id',
        'charData',
        'annotation',
        'preview_nodes',
        'highlightedHTML',
        'highlightedText',
        'startLine',
        'creator',
        'creator_token',
        'time_since',
        'raw_json',
        'hidden'
    ];

    protected $casts = [
        'node_id' => 'array',
        'charData' => 'array',
        'preview_nodes' => 'array',
        'hidden' => 'boolean'
    ];

    /**
     * 🔒 SECURITY: Accessor for raw_json that strips creator_token
     * This ensures creator_token is never leaked even when embedded in raw_json
     */
    public function getRawJsonAttribute($value)
    {
        $data = is_string($value) ? json_decode($value, true) : $value;

        if (is_array($data)) {
            unset($data['creator_token']);
        }

        return $data;
    }

    /**
     * Set highlight data for nodes (ensures consistency between node_id and charData)
     */
    public function setNodeCharData(array $dataByNode): void
    {
        // Extract node IDs for fast indexing
        $this->node_id = array_keys($dataByNode);

        // Store full position data
        $this->charData = $dataByNode;
    }

    /**
     * Get char positions for specific node
     */
    public function getCharsForNode(string $nodeId): ?array
    {
        return $this->charData[$nodeId] ?? null;
    }

    /**
     * Check if highlight affects a specific node
     */
    public function affectsNode(string $nodeId): bool
    {
        return in_array($nodeId, $this->node_id ?? []);
    }

    /**
     * Remove a node from this highlight (for orphan handling)
     */
    public function removeNode(string $nodeId): void
    {
        $this->node_id = array_values(
            array_filter($this->node_id ?? [], fn($id) => $id !== $nodeId)
        );

        $charData = $this->charData ?? [];
        unset($charData[$nodeId]);
        $this->charData = $charData;
    }
}
 