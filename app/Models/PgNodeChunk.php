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
}
