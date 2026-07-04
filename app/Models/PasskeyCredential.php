<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A registered WebAuthn passkey + the E2EE key material it can unwrap.
 *
 * `wrapped_vault_key` is null until the post-registration unlock ceremony
 * wraps the vault key for this credential (the PRF output only exists
 * client-side during an assertion, so registration is two-phase).
 */
class PasskeyCredential extends Model
{
    protected $fillable = [
        'user_id',
        'credential_id',
        'public_key',
        'transports',
        'sign_count',
        'aaguid',
        'name',
        'prf_salt',
        'wrapped_vault_key',
        'kek_params',
    ];

    protected $casts = [
        'transports' => 'array',
        'kek_params' => 'array',
        'sign_count' => 'integer',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
