<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

/**
 * Citation identity of a work, distinct from any individual uploaded version of it.
 * See docs/canonical-sources.md for the full model, legitimacy signals, and scoring semantics.
 */
class CanonicalSource extends Model
{
    protected $table = 'canonical_source';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';

    protected $hidden = ['creator_token'];

    protected $fillable = [
        'title',
        'author',
        'year',
        'journal',
        'publisher',
        'abstract',
        'type',
        'language',
        'doi',
        'openalex_id',
        'open_library_key',
        'is_oa',
        'oa_status',
        'oa_url',
        'pdf_url',
        'work_license',
        'cited_by_count',
        'semantic_scholar_id',
        'creator',
        'creator_token',
        'foundation_source',
        'verified_by_publisher',
        'commons_endorsements',
        'author_version_book',
        'publisher_version_book',
        'commons_version_book',
        'auto_version_book',
        'authorships',
    ];

    protected $casts = [
        'year' => 'integer',
        'is_oa' => 'boolean',
        'cited_by_count' => 'integer',
        'verified_by_publisher' => 'boolean',
        'commons_endorsements' => 'integer',
        'authorships' => 'array',
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function versions()
    {
        return $this->hasMany(PgLibrary::class, 'canonical_source_id', 'id');
    }

    public function authorVersion()
    {
        return $this->belongsTo(PgLibrary::class, 'author_version_book', 'book');
    }

    public function publisherVersion()
    {
        return $this->belongsTo(PgLibrary::class, 'publisher_version_book', 'book');
    }

    public function commonsVersion()
    {
        return $this->belongsTo(PgLibrary::class, 'commons_version_book', 'book');
    }

    public function autoVersion()
    {
        return $this->belongsTo(PgLibrary::class, 'auto_version_book', 'book');
    }

    protected static function boot()
    {
        parent::boot();

        static::creating(function ($canonical) {
            if (empty($canonical->id)) {
                $canonical->id = Str::uuid()->toString();
            }
        });
    }
}
