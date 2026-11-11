<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The one write of users.preferences. Goes through pgsql_admin because the
 * users row is outside the app role's UPDATE policy for this column; an empty
 * set is stored as NULL. Shared by UserPreferencesController (the allow-listed
 * keys) and NotificationController (notify_muted, which the generic endpoint
 * deliberately cannot write).
 */
final class UserPreferencesStore
{
    /** @param array<string, mixed> $preferences */
    public static function write(int $userId, array $preferences): void
    {
        $affected = DB::connection('pgsql_admin')->table('users')
            ->where('id', $userId)
            ->update(['preferences' => $preferences ? json_encode($preferences) : null]);

        if ($affected === 0) {
            Log::warning('Preferences update affected 0 rows', ['user_id' => $userId]);
        }
    }
}
