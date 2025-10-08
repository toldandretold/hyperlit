<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgNodeChunk extends Model
{
    protected $table = 'node_chunks';
    
    protected $fillable = [
        'book',
        'chunk_id',
        'startLine',
        'node_id',
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
