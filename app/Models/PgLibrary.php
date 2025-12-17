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

    /**
     * 🔒 SECURITY: Hide creator_token from JSON responses
     * This prevents token leakage via API responses
     */
    protected $hidden = ['creator_token'];

    protected $fillable = [
        'book',
        'author',
        'bibtex',
        'fileName',
        'fileType',
        'journal',
        'note',
        'pages',
        'publisher',
        'school',
        'timestamp',
        'annotations_updated_at',
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
        'creator_token',
        'visibility',
        'listed'
    ];

    protected $casts = [
        'timestamp' => 'integer',
        'annotations_updated_at' => 'integer',
        'recent' => 'integer',
        'total_views' => 'integer',
        'total_citations' => 'integer',
        'total_highlights' => 'integer',
        'listed' => 'boolean'
    ];

    /**
     * 🔒 SECURITY: Accessor for raw_json that strips creator_token
     * This ensures creator_token is never leaked even when embedded in raw_json
     */
    public function getRawJsonAttribute($value)
    {
        $data = is_string($value) ? json_decode($value, true) : $value;

        if (is_array($data)) {
            unset($data['creator_token']);
        }

        return $data;
    }

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
