<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PgLibrary extends Model
{
    protected $table = 'library';
    protected $primaryKey = 'book';
    public $incrementing = false;
    protected $keyType = 'string';

    protected $fillable = [
        'book',
        'author',
        'bibtex',
        'citationID',
        'fileName',
        'fileType',
        'journal',
        'note',
        'pages',
        'publisher',
        'school',
        'timestamp',
        'title',
        'type',
        'url',
        'year',
        'raw_json'
    ];

    protected $casts = [
        'raw_json' => 'array',
        'timestamp' => 'datetime'
    ];
}
