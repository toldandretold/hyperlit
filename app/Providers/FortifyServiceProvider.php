<?php

namespace App\Providers;

use App\Actions\Fortify\CreateNewUser;
use App\Actions\Fortify\ResetUserPassword;
use App\Actions\Fortify\UpdateUserPassword;
use App\Actions\Fortify\UpdateUserProfileInformation;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;
use Laravel\Fortify\Fortify;

class FortifyServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Fortify::createUsersUsing(CreateNewUser::class);
        Fortify::updateUserProfileInformationUsing(UpdateUserProfileInformation::class);
        Fortify::updateUserPasswordsUsing(UpdateUserPassword::class);
        Fortify::resetUserPasswordsUsing(ResetUserPassword::class);

        // The no-JS /login twin of AuthController::login's deletion guard: an
        // account mid-deletion ('deleting') still holds its real password until
        // the job's tombstone phase scrambles it. Refusing here reads as plain
        // bad credentials — deletion status is not a probe-able fact.
        Fortify::authenticateUsing(function (Request $request) {
            // On pgsql_admin: the default connection's RLS select policy hides
            // every row from an unauthenticated session (which is exactly why
            // auth.php swaps in the rls-eloquent provider for the normal path).
            $user = \App\Models\User::on('pgsql_admin')
                ->where('email', $request->input(Fortify::username()))->first();
            if ($user
                && \Illuminate\Support\Facades\Hash::check($request->password, $user->password)
                && ! in_array($user->status, ['deleting', 'deleted'], true)) {
                return $user;
            }

            return null;
        });

        RateLimiter::for('login', function (Request $request) {
            $throttleKey = Str::transliterate(Str::lower($request->input(Fortify::username())).'|'.$request->ip());

            return Limit::perMinute(5)->by($throttleKey);
        });

        RateLimiter::for('two-factor', function (Request $request) {
            return Limit::perMinute(5)->by($request->session()->get('login.id'));
        });
    }
}
