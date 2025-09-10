<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgHypercite extends Model
{
    protected $table = 'hypercites';

    protected $fillable = [
        'book',
        'hyperciteId',
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
        'citedIN' => 'array',
        'raw_json' => 'array',
        'endChar' => 'integer',
        'startChar' => 'integer'
    ];
}
