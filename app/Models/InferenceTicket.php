<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

/**
 * A single parked LLM request awaiting client-side execution (BYO key / local
 * LLM). See the create_inference_tickets_table migration for the schema + RLS.
 *
 * Uses the default `pgsql` connection, so all reads/writes are RLS-scoped to the
 * owning user (creator = app.current_user). Queue-worker writers must set that
 * session var first (see the GenerateBookAudioJob pattern).
 */
class InferenceTicket extends Model
{
    use HasUuids;

    protected $table = 'inference_tickets';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'creator',
        'feature',
        'context_id',
        'request_hash',
        'status',
        'request',
        'completion',
        'error',
        'expires_at',
        'claimed_at',
        'completed_at',
    ];

    protected $casts = [
        'request' => 'array',
        'completion' => 'array',
        'expires_at' => 'datetime',
        'claimed_at' => 'datetime',
        'completed_at' => 'datetime',
    ];
}
