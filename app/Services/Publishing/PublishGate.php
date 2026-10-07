<?php

namespace App\Services\Publishing;

use App\Models\User;
use Illuminate\Support\Carbon;

/**
 * May this user make a book PUBLIC (visibility=public / listed=true)?
 *
 * ONE rule, two callers: DbLibraryController's upsert/bulkCreate clamp (HTTP,
 * user from Auth) and TranslateBookJob's copy mint (queue worker, user passed
 * explicitly — a worker has no Auth context, which is why this is a service
 * and not a controller method).
 *
 * The rule (config/publishing.php):
 *   - No cutoff configured → gate OFF (dev/e2e default; production sets one).
 *   - Anonymous → never. If a logged-in user must verify an email to publish,
 *     a visitor with no identity at all cannot.
 *   - Created BEFORE the cutoff → allowed (grandfathered).
 *   - Created AT/AFTER the cutoff → allowed only with a verified email.
 *
 * The answer is a CLAMP input, never a 422 — callers downgrade to private and
 * surface the reason (see the CLAMP note at DbLibraryController's call sites).
 *
 * @see \App\Http\Controllers\DbLibraryController::publishPermission()
 */
final class PublishGate
{
    /** @return array{allowed: bool, reason: ?string} */
    public static function check(?User $user): array
    {
        $cutoffRaw = config('publishing.verified_email_required_after');

        if (empty($cutoffRaw)) {
            return ['allowed' => true, 'reason' => null];
        }

        if (! $user) {
            return ['allowed' => false, 'reason' => 'anonymous'];
        }

        if ($user->created_at && $user->created_at->lt(Carbon::parse($cutoffRaw))) {
            return ['allowed' => true, 'reason' => null];
        }

        if ($user->email_verified_at !== null) {
            return ['allowed' => true, 'reason' => null];
        }

        return ['allowed' => false, 'reason' => 'unverified_email'];
    }
}
