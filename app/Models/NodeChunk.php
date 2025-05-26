<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class NodeChunk extends Model
{
    protected $fillable = [
        'book',
        'chunk_id',
        'startLine',
        'content',
        'footnotes',
        'hypercites',
        'hyperlights',
        'plainText',
        'type',
        'raw_json'
    ];

    protected $casts = [
        'chunk_id' => 'float',
        'startLine' => 'float',
        'footnotes' => 'array',
        'hypercites' => 'array',
        'hyperlights' => 'array',
        'raw_json' => 'array'
    ];
}
