<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgHyperlight extends Model
{
    protected $table = 'hyperlights';

    protected $fillable = [
        'book',
        'hyperlight_id',
        'annotation',
        'endChar',
        'highlightedHTML',
        'highlightedText',
        'startChar',
        'startLine',
        'creator',
        'creator_token',
        'raw_json'
    ];

    protected $casts = [
        'raw_json' => 'array',
        'endChar' => 'integer',
        'startChar' => 'integer'
    ];
}
