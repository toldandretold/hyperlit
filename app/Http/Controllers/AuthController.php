<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Http\JsonResponse;
use App\Models\PgLibrary;

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

    // Add this method to your AuthController class
    public function transferBookOwnership(Request $request, string $bookId): JsonResponse
    {
        try {
            Log::info('Transfer ownership request started', [
                'book_id' => $bookId,
                'request_data' => $request->all()
            ]);

            $request->validate([
                'anonymous_token' => 'required|string'
            ]);

            $anonymousToken = $request->input('anonymous_token');
            $user = Auth::user();
            
            if (!$user) {
                Log::warning('User not authenticated for transfer');
                return response()->json([
                    'success' => false,
                    'message' => 'User not authenticated'
                ], 401);
            }

            Log::info('Attempting to transfer book', [
                'book_id' => $bookId,
                'anonymous_token' => $anonymousToken,
                'user_id' => $user->id,
                'user_name' => $user->name
            ]);

            // Find the book using the PgLibrary model
            $book = PgLibrary::where('book', $bookId)
                ->where('creator_token', $anonymousToken)
                ->whereNull('creator')  // Only transfer if no creator assigned
                ->first();

            Log::info('Book lookup result', [
                'book_found' => $book ? 'yes' : 'no',
                'book_data' => $book ? $book->toArray() : null
            ]);

            if (!$book) {
                // Check if book exists at all
                $existingBook = PgLibrary::where('book', $bookId)->first();
                if (!$existingBook) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Book not found with ID: ' . $bookId
                    ], 404);
                } else {
                    Log::warning('Book not eligible for transfer', [
                        'book_creator_token' => $existingBook->creator_token,
                        'requested_token' => $anonymousToken,
                        'book_creator' => $existingBook->creator
                    ]);

                    return response()->json([
                        'success' => false,
                        'message' => 'Book not eligible for transfer'
                    ], 400);
                }
            }

            // Update the book ownership
            $book->creator = $user->name;
            $book->updated_at = now();
            $saved = $book->save();

            Log::info('Update result', [
                'saved' => $saved,
                'book_creator' => $book->creator
            ]);

            if ($saved) {
                return response()->json([
                    'success' => true,
                    'message' => 'Book ownership transferred successfully',
                    'book_id' => $bookId,
                    'new_owner' => $user->name
                ]);
            } else {
                return response()->json([
                    'success' => false,
                    'message' => 'Failed to save book ownership'
                ], 500);
            }

        } catch (\Exception $e) {
            Log::error('Error transferring book ownership', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'An error occurred: ' . $e->getMessage()
            ], 500);
        }
    }
}