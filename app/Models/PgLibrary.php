<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Http\Controllers\HomePageServerController;

/**
 * A library row is one uploaded *version* of a work. When `canonical_source_id` is set,
 * the row is recognised as a version of that canonical; the `canonical_match_score` and
 * `canonical_metadata_score` columns describe how confident we are in the link and how
 * clean the row's own metadata is. See docs/canonical-sources.md.
 */
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
        'slug',
        'author',
        'bibtex',
        'fileName',
        'fileType',
        'journal',
        'note',
        'pages',
        'publisher',
        'school',
        'volume',
        'issue',
        'booktitle',
        'chapter',
        'editor',
        'license',
        'custom_license_text',
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
        'gate_defaults',
        'listed',
        'has_nodes',
        'openalex_id',
        'doi',
        'is_oa',
        'oa_status',
        'oa_url',
        'pdf_url',
        'pdf_url_status',
        'work_license',
        'cited_by_count',
        'language',
        'foundation_source',
        'abstract',
        'canonical_source_id',
        'conversion_method',
        'human_reviewed_at',
        'is_publisher_uploaded',
        'credibility_score',
        'canonical_match_score',
        'canonical_metadata_score',
        'canonical_match_method',
        'canonical_matched_at',
        'canonical_matched_by',
    ];

    protected $casts = [
        'timestamp' => 'integer',
        'annotations_updated_at' => 'integer',
        'recent' => 'integer',
        'total_views' => 'integer',
        'total_citations' => 'integer',
        'total_highlights' => 'integer',
        'gate_defaults' => 'array',
        'listed' => 'boolean',
        'has_nodes' => 'boolean',
        'is_oa' => 'boolean',
        'cited_by_count' => 'integer',
        'human_reviewed_at' => 'datetime',
        'is_publisher_uploaded' => 'boolean',
        'credibility_score' => 'float',
        'canonical_match_score' => 'float',
        'canonical_metadata_score' => 'float',
        'canonical_matched_at' => 'datetime',
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

    public function canonicalSource()
    {
        return $this->belongsTo(CanonicalSource::class, 'canonical_source_id', 'id');
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
