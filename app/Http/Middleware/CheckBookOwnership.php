<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CheckBookOwnership
{
    public function handle(Request $request, Closure $next)
    {
        $book = $request->route('book');
        $user = auth()->user();
        
        // Check if user is authenticated
        if (!$user) {
            // For AJAX requests, return JSON error
            if ($request->expectsJson()) {
                return response()->json(['error' => 'Unauthorized'], 401);
            }
            // For regular requests, redirect to read-only view
            return redirect("/{$book}")->with('error', 'Please log in to edit this book.');
        }
        
        // Get the book record and check ownership
        $bookRecord = DB::table('library')->where('book', $book)->first();
        
        if (!$bookRecord || $bookRecord->creator !== $user->name) {
            if ($request->expectsJson()) {
                return response()->json(['error' => 'Forbidden'], 403);
            }
            return redirect("/{$book}")->with('error', 'You do not have permission to edit this book.');
        }
        
        return $next($request);
    }
}