<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A row in the `book_images` store (docs/e2ee.md): metadata for one image
 * belonging to a book. Bytes live on the private `book_images` Flysystem disk
 * (BookImageStore), never in this table. RLS gates visibility via the owning
 * `library` row. `encrypted` = the on-disk bytes are ciphertext (HLENC1 blob).
 */
class PgBookImage extends Model
{
    protected $table = 'book_images';

    protected $keyType = 'string';

    public $incrementing = false; // uuid PK (gen_random_uuid)

    protected $fillable = [
        'book',
        'filename',
        'mime',
        'bytes',
        'width',
        'height',
        'encrypted',
    ];

    protected $casts = [
        'bytes' => 'integer',
        'width' => 'integer',
        'height' => 'integer',
        'encrypted' => 'boolean',
    ];
}
