<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class PgFootnote extends Model
{
    use HasFactory;

    protected $table = 'footnotes'; // 👈 explicitly set table name

    // Define the composite primary key
    protected $primaryKey = ['book', 'footnoteId'];
    public $incrementing = false;
    protected $keyType = 'string';

    // Allow mass assignment for these fields
    protected $fillable = [
        'book',
        'sub_book_id',
        'footnoteId',
        'content',
        'preview_nodes',
    ];

    // WARNING: Columns cast to 'array' are auto-encoded by Eloquent.
    // NEVER json_encode() values before passing them to Eloquent for these columns,
    // or you'll get double-encoded JSONB strings in the database.
    protected $casts = [
        'preview_nodes' => 'array',
    ];
}