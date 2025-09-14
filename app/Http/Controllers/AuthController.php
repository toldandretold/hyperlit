<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class AuthController extends Controller
{
    public function login(Request $request)
    {
        $request->validate([
            'email' => 'required|email',
            'password' => 'required',
        ]);

        if (!Auth::attempt($request->only('email', 'password'))) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are incorrect.'],
            ]);
        }

        return response()->json([
            'success' => true,
            'user' => Auth::user(),
            'message' => 'Login successful'
        ]);
    }

    public function register(Request $request)
    {
        $request->validate([
            'name' => 'required|string|max:255',
            'email' => 'required|string|email|max:255|unique:users',
            'password' => 'required|string|min:8',
        ]);

        $user = User::create([
            'name' => $request->name,
            'email' => $request->email,
            'password' => Hash::make($request->password),
        ]);

        Auth::login($user);

        return response()->json([
            'success' => true,
            'user' => $user,
            'message' => 'Registration successful'
        ]);
    }

    public function logout(Request $request)
    {
        try {
            // For session-based auth, just invalidate the session
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

    // NEW: Anonymous session methods
    public function createAnonymousSession(Request $request)
    {
        // Check if user already has a valid anonymous session
        $existingToken = $request->cookie('anon_token');
        
        if ($existingToken && $this->isValidAnonymousToken($existingToken)) {
            // Update last used time
            DB::table('anonymous_sessions')
                ->where('token', $existingToken)
                ->update(['last_used_at' => now()]);
                
            return response()->json([
                'token' => $existingToken,
                'type' => 'existing'
            ]);
        }
        
        // Generate new anonymous session
        $token = Str::uuid()->toString();
        
        // Store in database for validation
        DB::table('anonymous_sessions')->insert([
            'token' => $token,
            'created_at' => now(),
            'last_used_at' => now(),
            'ip_address' => $request->ip(),
            'user_agent' => $request->userAgent(),
        ]);
        
        return response()->json([
            'token' => $token,
            'type' => 'new'
        ])->cookie('anon_token', $token, 60 * 24 * 365); // 1 year
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
        if ($anonToken && $this->isValidAnonymousToken($anonToken)) {
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

    private function isValidAnonymousToken($token)
    {
        return DB::table('anonymous_sessions')
            ->where('token', $token)
            ->where('created_at', '>', now()->subDays(365)) // Token expires after 1 year
            ->exists();
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
        if ($anonymousToken && $this->isValidAnonymousToken($anonymousToken)) {
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
        return response()->json([
            'authenticated' => false,
            'user' => null,
            'anonymous_token' => $newAnonymousToken,
            'csrf_token' => csrf_token(),
        ])->cookie(
            'anon_token',      // cookie name
            $newAnonymousToken,  // value
            60 * 24 * 365,       // expires in 1 year
            '/',                 // path
            config('session.domain'), // domain
            config('session.secure'), // secure
            true,                // httpOnly
            false,               // raw
            'lax'                // sameSite
        );
    }

    public function associateContent(Request $request)
    {
        $request->validate([
            'anonymous_token' => 'required|string|uuid',
        ]);

        $user = $request->user();
        $anonymousToken = $request->input('anonymous_token');

        if (!$user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        // CORRECTED: Update only the models that have creator_token, based on the schema.
        $modelsToUpdate = [
            \App\Models\PgLibrary::class,
            \App\Models\PgHyperlight::class,
            \App\Models\PgHypercite::class,
        ];

        try {
            DB::transaction(function () use ($modelsToUpdate, $anonymousToken, $user) {
                foreach ($modelsToUpdate as $modelClass) {
                    // CORRECTED: Only update the creator column, leaving creator_token intact.
                    $modelClass::where('creator_token', $anonymousToken)
                        ->update([
                            'creator' => $user->name,
                        ]);
                }
            });

            return response()->json(['success' => true, 'message' => 'Content successfully associated.']);

        } catch (\Exception $e) {
            // Log the specific error for debugging
            \Log::error('Content association failed: ' . $e->getMessage() . '\n' . $e->getTraceAsString());
            
            return response()->json(['success' => false, 'message' => 'An error occurred during content association.'], 500);
        }
    }
}