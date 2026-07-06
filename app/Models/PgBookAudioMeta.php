<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Per-book TTS metadata: pins the narration voice (regenerations must match)
 * and records who first paid for generation. RLS mirrors book_audio.
 */
class PgBookAudioMeta extends Model
{
    protected $table = 'book_audio_meta';

    protected $primaryKey = 'book';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = [
        'book',
        'voice',
        'total_chars',
        'generated_by',
        'generated_at',
    ];

    protected $casts = [
        'total_chars' => 'integer',
        'generated_at' => 'datetime',
    ];
}
