<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Per-user E2EE vault recovery blob: the vault key wrapped by the
 * recovery-code-derived KEK. The server cannot decrypt it.
 */
class UserE2eeVault extends Model
{
    protected $table = 'user_e2ee_vaults';

    protected $primaryKey = 'user_id';

    public $incrementing = false;

    protected $fillable = [
        'user_id',
        'recovery_wrapped_vault_key',
        'recovery_kdf_params',
    ];

    protected $casts = [
        'recovery_kdf_params' => 'array',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
