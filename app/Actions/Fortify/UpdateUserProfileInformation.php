<?php

namespace App\Actions\Fortify;

use App\Models\User;
use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Laravel\Fortify\Contracts\UpdatesUserProfileInformation;

/**
 * Fortify's profile-update action. Currently UNREACHABLE — the feature is
 * commented out in config/fortify.php — but it is wired as the contract
 * implementation, so it must not be a hole if anyone switches it on.
 *
 * THIS DELIBERATELY CANNOT RENAME A USER. `users.name` is a de-facto string
 * foreign key with no FK constraints (library.creator, shelves.creator,
 * vibes.creator, notifications.recipient, book_reads.user_name, …) and ~99 RLS
 * policies compare it case-sensitively against `app.current_user`. Changing it
 * would orphan everything the account owns AND revoke the account's own access
 * to it, silently. A rename feature needs that whole problem solved first (a
 * transactional backfill across every one of those tables); it is not a
 * validation tweak.
 *
 * Before `users_name_url_unique` existed this action also validated `name`
 * with only `required|string|max:255` — no uniqueness, no charset, neither
 * blocklist — so enabling the feature would have been a straight bypass of
 * every registration rule. With the unique index in place it would instead be
 * a raw 23505 out of save(). Hence: the name is pinned, not validated loosely.
 */
class UpdateUserProfileInformation implements UpdatesUserProfileInformation
{
    /**
     * Validate and update the given user's profile information.
     *
     * @param  array<string, string>  $input
     */
    public function update(User $user, array $input): void
    {
        Validator::make($input, [
            'name' => [
                'required',
                'string',
                function ($attribute, $value, $fail) use ($user) {
                    if ((string) $value !== $user->name) {
                        $fail('Usernames cannot be changed.');
                    }
                },
            ],

            'email' => [
                'required',
                'string',
                'email',
                'max:255',
                Rule::unique('users')->ignore($user->id),
            ],
        ])->validateWithBag('updateProfileInformation');

        if ($input['email'] !== $user->email &&
            $user instanceof MustVerifyEmail) {
            $this->updateVerifiedUser($user, $input);
        } else {
            // `name` is never written — see the class docblock.
            $user->forceFill([
                'email' => $input['email'],
            ])->save();
        }
    }

    /**
     * Update the given verified user's profile information.
     *
     * @param  array<string, string>  $input
     */
    protected function updateVerifiedUser(User $user, array $input): void
    {
        $user->forceFill([
            'email' => $input['email'],
            'email_verified_at' => null,
        ])->save();

        $user->sendEmailVerificationNotification();
    }
}
