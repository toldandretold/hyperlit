<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class PgReference extends Model
{
    use HasFactory;

     protected $table = 'bibliography'; 

    // Define the composite primary key
    protected $primaryKey = ['book', 'referenceId'];
    public $incrementing = false;
    protected $keyType = 'string';

    // Allow mass assignment for these fields
    protected $fillable = [
        'book',
        'referenceId',
        'source_id',
        'content',
        'foundation_source',
        'llm_metadata',
        // Human decision layer on the canonical match (see the migration). Kept orthogonal to the
        // pipeline-owned match_method so re-scans/re-syncs never clobber a reader's confirm/reject.
        'reference_match_method',
        'reference_verified_at',
        'reference_verified_by',
    ];

    protected $casts = [
        'llm_metadata' => 'array',
        'reference_verified_at' => 'datetime',
    ];
}