<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Http\Controllers\HomePageServerController;

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
        'raw_json',
        'recent',
        'total_views',
        'total_citations',
        'total_highlights',
        'creator',
        'creator_token'
    ];

    protected $casts = [
        'raw_json' => 'array',
        'timestamp' => 'integer',
        'recent' => 'integer',
        'total_views' => 'integer',
        'total_citations' => 'integer',
        'total_highlights' => 'integer'
    ];

    protected static function booted()
    {
        // Only invalidate cache when citation/highlight counts change
        static::updating(function ($library) {
            $isDirty = $library->isDirty(['total_citations', 'total_highlights']);
            
            if ($isDirty) {
                HomePageServerController::invalidateCache();
            }
        });

        // Invalidate cache when new books are created (affects "most recent")
        static::created(function ($library) {
            HomePageServerController::invalidateCache();
        });
    }
}
