<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\ValidationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;

class AuthController extends Controller
{
    public function login(Request $request)
    {
        $request->validate([
            'email' => 'required|email',
            'password' => 'required',
        ]);

        if (!Auth::attempt($request->only('email', 'password'), true)) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are incorrect.'],
            ]);
        }


        // Check for anonymous content to transfer
        $anonymousContent = $this->checkAnonymousContent($request);

        return response()->json([
            'success' => true,
            'user' => Auth::user(),
            'message' => 'Login successful',
            'anonymous_content' => $anonymousContent,
            'email_verified' => Auth::user()->email_verified_at !== null,
        ]);
    }

    public function register(Request $request)
    {
        $request->validate([
            'name' => [
                'required',
                'string',
                'min:3',
                'max:30',
                'unique:users,name',
                'alpha_dash', // Allows alphanumeric, hyphens, and underscores only
                'regex:/^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$/', // Cannot start/end with - or _
            ],
            'email' => 'required|string|email|max:255|unique:users',
            'password' => 'required|string|min:8',
        ], [
            'name.alpha_dash' => 'Username can only contain letters, numbers, hyphens, and underscores.',
            'name.regex' => 'Username cannot start or end with - or _.',
            'name.min' => 'Username must be at least 3 characters.',
            'name.max' => 'Username must be 30 characters or less.',
            'name.unique' => 'This username is already taken.',
        ]);

        // Use admin connection for registration - trusted operation that bypasses RLS
        // This is safe: validation already checked unique constraints, we control all inputs
        $userToken = \Illuminate\Support\Str::uuid()->toString();
        $userId = DB::connection('pgsql_admin')->table('users')->insertGetId([
            'name' => $request->name,
            'email' => $request->email,
            'password' => Hash::make($request->password),
            'user_token' => $userToken,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Check for anonymous content BEFORE setting RLS context
        // (RLS would block seeing records with the anonymous token after context is set to new user)
        $anonymousContent = $this->checkAnonymousContent($request);

        // Set RLS context so we can read the new user
        DB::statement("SELECT set_config('app.current_user', ?, false)", [$request->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [$userToken]);

        $user = User::find($userId);
        Auth::login($user);

        $this->sendVerificationEmail($user);

        return response()->json([
            'success' => true,
            'user' => $user,
            'message' => 'Registration successful',
            'anonymous_content' => $anonymousContent,
            'email_verified' => false,
        ]);
    }

    public function logout(Request $request)
    {
        try {
            // Clear the remember-me token (DB + cookie) before destroying session
            \Auth::guard('web')->logout();

            $request->session()->invalidate();
            $request->session()->regenerateToken();

            return response()->json([
                'success' => true,
                'message' => 'Logout successful'
            ]);
        } catch (\Exception $e) {
            \Log::error('Logout error: ' . $e->getMessage());
            
            return response()->json([
                'success' => false,
                'message' => 'Logout failed: ' . $e->getMessage()
            ], 500);
        }
    }

    public function user(Request $request)
    {
        return response()->json([
            'authenticated' => Auth::check(),
            'user' => Auth::user()
        ]);
    }

    // Anonymous session methods - security enhanced
    public function createAnonymousSession(Request $request)
    {
        $maxTokensPerHour = 10;
        $ip = $request->ip();

        // Check if user already has a valid anonymous session (outside transaction)
        $existingToken = $request->cookie('anon_token');

        if ($existingToken && $this->isValidAnonymousToken($existingToken, $request)) {
            $session = DB::table('anonymous_sessions')
                ->where('token', $existingToken)
                ->first();

            // SECURITY: Log if IP changed significantly (potential token theft)
            if ($session && $session->ip_address && $session->ip_address !== $request->ip()) {
                Log::info('Anonymous session IP changed', [
                    'token_prefix' => substr($existingToken, 0, 8) . '...',
                    'original_ip' => $session->ip_address,
                    'current_ip' => $request->ip()
                ]);
            }

            // Update last used time
            DB::table('anonymous_sessions')
                ->where('token', $existingToken)
                ->update(['last_used_at' => now()]);

            return response()->json([
                'token' => $existingToken,
                'type' => 'existing'
            ]);
        }

        // 🔒 SECURITY: Cache-based rate limiting (works with RLS)
        // Using cache instead of DB count because RLS restricts visibility to own sessions only
        try {
            $rateLimitKey = 'anon_session_rate:' . $ip;
            $currentCount = Cache::get($rateLimitKey, 0);

            if ($currentCount >= $maxTokensPerHour) {
                Log::warning('Anonymous token rate limit exceeded', [
                    'ip' => $ip,
                    'count' => $currentCount
                ]);
                return response()->json([
                    'error' => 'Too many session requests. Please try again later.'
                ], 429);
            }

            // Increment rate limit counter (expires after 1 hour)
            Cache::put($rateLimitKey, $currentCount + 1, 3600);

            // Generate and insert new token
            $token = Str::uuid()->toString();

            DB::table('anonymous_sessions')->insert([
                'token' => $token,
                'created_at' => now(),
                'last_used_at' => now(),
                'ip_address' => $ip,
                'user_agent' => substr($request->userAgent() ?? '', 0, 500),
            ]);

            Log::info('New anonymous session created', [
                'token_prefix' => substr($token, 0, 8) . '...',
                'ip' => $ip
            ]);

            // 🔒 SECURITY: Set HttpOnly and other security flags on cookie
            return response()->json([
                'token' => $token,
                'type' => 'new'
            ])->cookie(
                'anon_token',
                $token,
                60 * 24 * 90,  // 90 days (standardized expiration)
                '/',
                config('session.domain'),
                config('session.secure'),
                true,  // 🔒 HttpOnly - prevents XSS token theft
                false,
                'lax'  // SameSite
            );

        } catch (\Exception $e) {
            Log::error('Failed to create anonymous session', [
                'ip' => $ip,
                'error' => $e->getMessage()
            ]);
            return response()->json([
                'error' => 'Failed to create session. Please try again.'
            ], 500);
        }
    }

    public function checkAuth(Request $request)
    {
        if (Auth::check()) {
            return response()->json([
                'authenticated' => true,
                'user' => Auth::user(),
                'anonymous_token' => null
            ]);
        }
        
        // Check for valid anonymous session
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $this->isValidAnonymousToken($anonToken, $request)) {
            // Update last used
            DB::table('anonymous_sessions')
                ->where('token', $anonToken)
                ->update(['last_used_at' => now()]);
                
            return response()->json([
                'authenticated' => false,
                'user' => null,
                'anonymous_token' => $anonToken
            ]);
        }
        
        // Instead of returning 401, return that no session exists
        // The frontend will then call /anonymous-session to create one
        return response()->json([
            'authenticated' => false,
            'user' => null,
            'anonymous_token' => null
        ], 200); // Changed from 401 to 200
    }

    // 🔒 SECURITY: Standardized token expiration (90 days)
    private const TOKEN_EXPIRY_DAYS = 90;
    private const TOKEN_VALIDATION_RATE_LIMIT = 30; // max attempts per minute per IP

    private function isValidAnonymousToken($token, ?Request $request = null)
    {
        // 🔒 SECURITY: Rate limit token validation to prevent brute force attacks
        if ($request) {
            $rateLimitKey = 'token_validation:' . $request->ip();
            $attempts = Cache::get($rateLimitKey, 0);

            if ($attempts >= self::TOKEN_VALIDATION_RATE_LIMIT) {
                Log::warning('Token validation rate limit exceeded', [
                    'ip' => $request->ip(),
                    'attempts' => $attempts
                ]);
                return false; // Silently fail - don't reveal that rate limiting occurred
            }

            Cache::put($rateLimitKey, $attempts + 1, 60); // 1 minute window
        }

        // Use SECURITY DEFINER function to bypass RLS
        // This is needed because when logged in, app.current_token is empty
        // but we need to validate the user's former anonymous token
        $result = DB::selectOne(
            'SELECT validate_anonymous_token(?, ?) as valid',
            [$token, self::TOKEN_EXPIRY_DAYS]
        );

        return $result->valid ?? false;
    }

    public function getSessionInfo(Request $request)
    {
        // Case 1: User is fully authenticated via Sanctum
        if (Auth::check()) {
            return response()->json([
                'authenticated' => true,
                'user' => Auth::user(),
                'anonymous_token' => null,
                'csrf_token' => csrf_token(), // Always provide the CSRF token
            ]);
        }

        // Case 2: User has an existing anonymous session token
        $anonymousToken = $request->cookie('anon_token');
        if ($anonymousToken && $this->isValidAnonymousToken($anonymousToken, $request)) {
            // The user is a known anonymous user. Return their token.
            return response()->json([
                'authenticated' => false,
                'user' => null,
                'anonymous_token' => $anonymousToken,
                'csrf_token' => csrf_token(),
            ]);
        }

        // Case 3: No session exists. This is a new visitor.
        // Create a new anonymous session for them.
        $newAnonymousToken = Str::uuid()->toString();

        // Store in your database (using your existing logic)
        DB::table('anonymous_sessions')->insert([
            'token' => $newAnonymousToken,
            'created_at' => now(),
            'last_used_at' => now(),
            'ip_address' => $request->ip(),
            'user_agent' => $request->userAgent(),
        ]);

        // Return the new token and set the cookie for future requests.
        // 🔒 SECURITY: Use standardized 90-day expiration
        return response()->json([
            'authenticated' => false,
            'user' => null,
            'anonymous_token' => $newAnonymousToken,
            'csrf_token' => csrf_token(),
        ])->cookie(
            'anon_token',
            $newAnonymousToken,
            60 * 24 * self::TOKEN_EXPIRY_DAYS,  // 90 days (standardized)
            '/',
            config('session.domain'),
            config('session.secure'),
            true,   // 🔒 HttpOnly
            false,
            'lax'
        );
    }


    public function associateContent(Request $request)
    {
        Log::info('🔄 associateContent called', [
            'has_user' => (bool)$request->user(),
            'user_name' => $request->user()?->name,
            'requested_token' => $request->input('anonymous_token') ? substr($request->input('anonymous_token'), 0, 8) . '...' : null,
            'cookie_token' => $request->cookie('anon_token') ? substr($request->cookie('anon_token'), 0, 8) . '...' : null,
        ]);

        $request->validate([
            'anonymous_token' => 'required|string|uuid',
        ]);

        $user = $request->user();
        $requestedToken = $request->input('anonymous_token');

        if (!$user) {
            Log::warning('associateContent: No authenticated user');
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        // 🔒 SECURITY FIX: Verify the requested token matches the user's cookie
        // This prevents attackers from claiming content from other users' anonymous tokens
        $cookieToken = $request->cookie('anon_token');

        if (!$cookieToken || !hash_equals($cookieToken, $requestedToken)) {
            Log::warning('Content association rejected: token mismatch', [
                'user' => $user->name,
                'requested_token_prefix' => substr($requestedToken, 0, 8) . '...',
                'has_cookie' => !empty($cookieToken),
            ]);
            return response()->json([
                'success' => false,
                'message' => 'Cannot associate content: token does not match your session.'
            ], 403);
        }

        // 🔒 SECURITY: Verify the token exists and is valid (not expired)
        if (!$this->isValidAnonymousToken($requestedToken, $request)) {
            return response()->json([
                'success' => false,
                'message' => 'Cannot associate content: invalid or expired token.'
            ], 400);
        }

        try {
            $updatedCounts = [];

            // Use SECURITY DEFINER functions to bypass RLS for ownership transfer
            // The secure transfer functions require app.current_token to match the
            // anonymous token being transferred. We must temporarily set it here
            // since after login, middleware sets it to the user's token instead.
            DB::transaction(function () use ($requestedToken, $user, &$updatedCounts) {
                // Temporarily set app.current_token to the anonymous token for transfer validation
                DB::statement("SELECT set_config('app.current_token', ?, true)", [$requestedToken]);

                $libraryCount = DB::selectOne(
                    'SELECT transfer_anonymous_library(?, ?) as count',
                    [$requestedToken, $user->name]
                );
                $updatedCounts['PgLibrary'] = $libraryCount->count ?? 0;

                $hyperlightsCount = DB::selectOne(
                    'SELECT transfer_anonymous_hyperlights(?, ?) as count',
                    [$requestedToken, $user->name]
                );
                $updatedCounts['PgHyperlight'] = $hyperlightsCount->count ?? 0;

                $hypercitesCount = DB::selectOne(
                    'SELECT transfer_anonymous_hypercites(?, ?) as count',
                    [$requestedToken, $user->name]
                );
                $updatedCounts['PgHypercite'] = $hypercitesCount->count ?? 0;
            });

            // Regenerate user home books so claimed books appear on profile immediately
            if (($updatedCounts['PgLibrary'] ?? 0) > 0) {
                $homeController = app(UserHomeServerController::class);
                $homeController->generateUserHomeBook($user->name, true, 'public');
                $homeController->generateUserHomeBook($user->name, true, 'private');
            }

            Log::info('Content associated successfully', [
                'user' => $user->name,
                'token_prefix' => substr($requestedToken, 0, 8) . '...',
                'counts' => $updatedCounts,
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Content successfully associated.',
                'counts' => $updatedCounts,
            ]);

        } catch (\Exception $e) {
            Log::error('Content association failed: ' . $e->getMessage() . '\n' . $e->getTraceAsString());

            return response()->json(['success' => false, 'message' => 'An error occurred during content association.'], 500);
        }
    }

    public function forgotPassword(Request $request)
    {
        $request->validate([
            'email' => 'required|email',
        ]);

        $email = $request->input('email');

        // Use SECURITY DEFINER function to look up user by email (bypasses RLS)
        $user = DB::selectOne('SELECT * FROM auth_lookup_user_by_email(?)', [$email]);

        if ($user) {
            // Generate a plain token for the URL and a SHA-256 hash for storage
            $token = hash_hmac('sha256', Str::random(40), config('app.key'));
            $hash = hash('sha256', $token);

            // Insert via SECURITY DEFINER function (password_reset_tokens has RLS, deny-all)
            DB::selectOne('SELECT auth_create_password_reset_token(?, ?)', [$email, $hash]);

            $resetUrl = url("/reset-password/{$token}?email=" . urlencode($email));

            // Send the reset email
            \Illuminate\Support\Facades\Mail::send('emails.password-reset', [
                'resetUrl' => $resetUrl,
                'logoUrl'  => url('/images/logoc.png'),
            ], function ($message) use ($email) {
                $message->to($email)->subject('Reset Your Password');
            });
        }

        // Always return success to prevent email enumeration
        return response()->json([
            'success' => true,
            'message' => 'If that email is registered, a reset link has been sent.',
        ]);
    }

    public function resetPassword(Request $request)
    {
        $request->validate([
            'token' => 'required|string',
            'email' => 'required|email',
            'password' => 'required|string|min:8|confirmed',
        ]);

        $email = $request->input('email');
        $token = $request->input('token');

        // Atomic reset: verify token + update password + delete token in one SECURITY DEFINER call.
        // The function checks expiry (60 min) and verifies SHA-256(plain_token) against the stored hash.
        $result = DB::selectOne('SELECT auth_execute_password_reset(?, ?, ?, ?) as success', [
            $email,
            $token,
            Hash::make($request->input('password')),
            Str::random(60),
        ]);

        if (!$result || !$result->success) {
            return response()->json([
                'success' => false,
                'message' => 'This reset link is invalid or has expired.',
            ], 400);
        }

        return response()->json([
            'success' => true,
            'message' => 'Password has been reset successfully.',
        ]);
    }

    private function sendVerificationEmail($user)
    {
        $verificationUrl = URL::temporarySignedRoute(
            'verification.verify',
            now()->addMinutes(60),
            ['id' => $user->id, 'hash' => sha1($user->email)]
        );

        Mail::send('emails.verify-email', [
            'verificationUrl' => $verificationUrl,
            'logoUrl' => url('/images/logoc.png'),
        ], function ($message) use ($user) {
            $message->to($user->email)->subject('Verify Your Email');
        });
    }

    public function verifyEmail(Request $request, $id, $hash)
    {
        $user = DB::connection('pgsql_admin')
            ->table('users')
            ->where('id', $id)
            ->first();

        if (!$user || !hash_equals($hash, sha1($user->email))) {
            return redirect('/?verified=0');
        }

        DB::selectOne('SELECT auth_verify_user_email(?, ?)', [$id, $user->email]);

        return redirect('/?verified=1');
    }

    public function resendVerificationEmail(Request $request)
    {
        $user = $request->user();

        if ($user->email_verified_at !== null) {
            return response()->json([
                'success' => false,
                'message' => 'Email is already verified.',
            ], 400);
        }

        $this->sendVerificationEmail($user);

        return response()->json([
            'success' => true,
            'message' => 'Verification email sent.',
        ]);
    }

    public function changeEmail(Request $request)
    {
        $user = $request->user();

        $request->validate([
            'email' => 'required|string|email|max:255|unique:users,email,' . $user->id,
        ]);

        $newEmail = $request->input('email');

        DB::selectOne('SELECT auth_change_user_email(?, ?)', [$user->id, $newEmail]);

        // Refresh user model with new email
        $user->email = $newEmail;
        $user->email_verified_at = null;

        $this->sendVerificationEmail($user);

        return response()->json([
            'success' => true,
            'message' => 'Email updated. Verification link sent to new address.',
            'user' => $user->fresh(),
        ]);
    }

    private function checkAnonymousContent(Request $request)
    {
        // Get the anonymous token from cookie
        $anonymousToken = $request->cookie('anon_token');

        if (!$anonymousToken || !$this->isValidAnonymousToken($anonymousToken, $request)) {
            return null;
        }

        $content = [
            'token' => $anonymousToken,
            'books' => [],
            'highlights' => [],
            'cites' => []
        ];

        try {
            // Check for books (library entries) with this anonymous token
            $booksCount = DB::table('library')
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator') // Only get books not already assigned to a user
                ->count();
            
            if ($booksCount > 0) {
                $content['books'] = DB::table('library')
                    ->where('creator_token', $anonymousToken)
                    ->whereNull('creator')
                    ->get(['book', 'title'])
                    ->toArray();
            }

            // Check for highlights with this anonymous token (only those not already assigned to a user)
            $highlightsCount = DB::table('hyperlights')
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator') // Only get highlights not already assigned to a user
                ->count();
            
            if ($highlightsCount > 0) {
                $content['highlights'] = DB::table('hyperlights')
                    ->where('creator_token', $anonymousToken)
                    ->whereNull('creator')
                    ->get(['id', 'book', 'highlightedText'])
                    ->toArray();
            }

            // Check for citations with this anonymous token (only those not already assigned to a user)
            $citesCount = DB::table('hypercites')
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator') // Only get citations not already assigned to a user
                ->count();
            
            if ($citesCount > 0) {
                $content['cites'] = DB::table('hypercites')
                    ->where('creator_token', $anonymousToken)
                    ->whereNull('creator')
                    ->get(['id', 'book', 'hypercitedText'])
                    ->toArray();
            }

            // Only return content info if there's actually content to transfer
            if ($booksCount === 0 && $highlightsCount === 0 && $citesCount === 0) {
                return null;
            }

            return $content;

        } catch (\Exception $e) {
            \Log::error('Error checking anonymous content: ' . $e->getMessage());
            return null;
        }
    }
}

