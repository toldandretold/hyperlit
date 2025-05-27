<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgFootnote extends Model
{
    protected $table = 'footnotes';
    protected $primaryKey = 'book';
    public $incrementing = false;
    protected $keyType = 'string';

    protected $fillable = [
        'book',
        'data',
        'raw_json'
    ];

    protected $casts = [
        'data' => 'array',
        'raw_json' => 'array'
    ];
}
