<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;

/**
 * A refresh token in the MCP OAuth flow (thin OAuth over Sanctum — see
 * routes/oauth.php and the migration docblock for the rotation/tombstone
 * model). The row stores only the sha256 of the token; the matching access
 * token is an ordinary personal_access_tokens row referenced by
 * personal_access_token_id.
 *
 * Connection pinned to the default for the same reason as
 * HyperlitPersonalAccessToken: the table is deliberately not RLS-restricted,
 * and admin-bound callers (test fixtures) must not escape RefreshDatabase's
 * transaction.
 *
 * Pruning: expired, rotated, and revoked rows are kept 7 days (rotated rows
 * are the refresh-reuse tombstones — after the window a replayed old token
 * still fails with invalid_grant, it just no longer triggers family
 * revocation) then swept by the daily model:prune in routes/console.php.
 */
class OauthRefreshToken extends Model
{
    use Prunable;

    protected $table = 'oauth_refresh_tokens';

    public $timestamps = false; // created_at is a DB default; no updated_at column

    protected $guarded = [];

    protected $casts = [
        'scopes' => 'array',
        'expires_at' => 'datetime',
        'family_expires_at' => 'datetime',
        'rotated_at' => 'datetime',
        'revoked_at' => 'datetime',
        'created_at' => 'datetime',
    ];

    public function getConnectionName()
    {
        return config('database.default');
    }

    public function prunable()
    {
        $cutoff = now()->subDays(7);

        return static::query()
            ->where('expires_at', '<', $cutoff)
            ->orWhere('rotated_at', '<', $cutoff)
            ->orWhere('revoked_at', '<', $cutoff);
    }
}
