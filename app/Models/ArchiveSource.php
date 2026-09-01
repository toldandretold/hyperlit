<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A hypertext archive: a curated public shelf with a global /a/{slug} page,
 * hand-written about copy, and the certified-at human signal that lists it on
 * the homepage. The shelf carries the books; this row carries the identity.
 * See docs/web-scrape-import.md.
 */
class ArchiveSource extends Model
{
    protected $table = 'archive_sources';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';

    protected $fillable = [
        'shelf_id',
        'slug',
        'display_name',
        'about',
        'certified_at',
    ];

    protected function casts(): array
    {
        return [
            'certified_at' => 'datetime',
        ];
    }
}
