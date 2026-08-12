<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

/**
 * A journal (OpenAlex "source") in the diamond-OA registry: venue identity, diamond
 * determination + provenance, ranking stats, and per-journal harvest bookkeeping.
 * See docs/journal-harvest.md.
 */
class JournalSource extends Model
{
    protected $table = 'journal_sources';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';

    protected $fillable = [
        'openalex_source_id',
        'issn_l',
        'issns',
        'display_name',
        'publisher',
        'slug',
        'is_diamond',
        'diamond_provenance',
        'is_oa',
        'is_in_doaj',
        'apc_usd',
        'works_count',
        'cited_by_count',
        'two_year_mean_citedness',
        'country_code',
        'languages',
        'homepage_url',
        'topics',
        'last_synced_at',
        'last_harvested_at',
        'harvest_stats',
        'shelf_id',
    ];

    protected $casts = [
        'issns' => 'array',
        'is_diamond' => 'boolean',
        'is_oa' => 'boolean',
        'is_in_doaj' => 'boolean',
        'apc_usd' => 'integer',
        'works_count' => 'integer',
        'cited_by_count' => 'integer',
        'two_year_mean_citedness' => 'float',
        'languages' => 'array',
        'topics' => 'array',
        'harvest_stats' => 'array',
        'last_synced_at' => 'datetime',
        'last_harvested_at' => 'datetime',
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function canonicals()
    {
        return $this->hasMany(CanonicalSource::class, 'journal_source_id', 'id');
    }

    protected static function boot()
    {
        parent::boot();

        static::creating(function ($journal) {
            if (empty($journal->id)) {
                $journal->id = Str::uuid()->toString();
            }
        });
    }
}
