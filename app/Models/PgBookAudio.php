<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A row in the `book_audio` store: metadata for one node's synthesized TTS
 * audio. Bytes live on the private `book_audio` Flysystem disk
 * (BookAudioStore), never in this table. RLS gates visibility via the owning
 * `library` row. Staleness is computed: sha256(nodes.plainText) != source_hash.
 */
class PgBookAudio extends Model
{
    protected $table = 'book_audio';

    protected $keyType = 'string';

    public $incrementing = false; // uuid PK (gen_random_uuid)

    protected $fillable = [
        'book',
        'node_id',
        'filename',
        'source_hash',
        'voice',
        'chars',
        'duration_ms',
        'bytes',
    ];

    protected $casts = [
        'chars' => 'integer',
        'duration_ms' => 'integer',
        'bytes' => 'integer',
    ];
}
