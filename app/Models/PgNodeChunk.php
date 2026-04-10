<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgNodeChunk extends Model
{
    protected $table = 'nodes';
    
    protected $fillable = [
        'book',
        'chunk_id',
        'startLine',
        'node_id',
        'content',
        'footnotes',
        'plainText',
        'type',
        'raw_json'
    ];

    protected $casts = [
        'chunk_id' => 'float',
        'startLine' => 'float',
        'footnotes' => 'array',
        'raw_json' => 'array'
    ];

    /**
     * Boot the model and register event listeners.
     */
    protected static function booted(): void
    {
        static::saving(function (PgNodeChunk $node) {
            // Auto-generate plainText from content when content changes or plainText is empty
            if ($node->isDirty('content') || empty($node->plainText)) {
                if (!empty($node->content)) {
                    $node->plainText = strip_tags($node->content);
                }
            }
        });

        static::saved(function (PgNodeChunk $node) {
            // Queue embedding generation when plainText changes
            if ($node->wasChanged('plainText') && !empty($node->plainText) && strlen(trim($node->plainText)) >= 20) {
                \App\Jobs\GenerateNodeEmbedding::dispatch($node->id);
            }
        });
    }
}
