<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgHypercite extends Model
{
    protected $table = 'hypercites';

    protected $fillable = [
        'book',
        'hyperciteId',
        'node_id',
        'charData',
        'citedIN',
        'endChar',
        'hypercitedHTML',
        'hypercitedText',
        'relationshipStatus',
        'startChar',
        'time_since',
        'raw_json'
    ];

    protected $casts = [
        'node_id' => 'array',
        'charData' => 'array',
        'citedIN' => 'array',
        'raw_json' => 'array',
        'endChar' => 'integer',
        'startChar' => 'integer'
    ];

    /**
     * Set hypercite data for nodes (ensures consistency between node_id and charData)
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
     * Check if hypercite affects a specific node
     */
    public function affectsNode(string $nodeId): bool
    {
        return in_array($nodeId, $this->node_id ?? []);
    }

    /**
     * Remove a node from this hypercite (for orphan handling)
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
