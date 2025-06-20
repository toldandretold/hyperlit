<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CheckBookOwnership
{
    public function handle(Request $request, Closure $next)
    {
        $book    = $request->route('book');
        $user    = $request->user();                     // null if not logged in
        $anonTok = $request->cookie('anon_author');      // your anonymous‐ID cookie

        // Fetch the book record (if any)
        $record = DB::table('library')
                    ->where('book', $book)
                    ->first();

        // If it doesn’t exist yet, allow creation
        if (! $record) {
            return $next($request);
        }

        // Case 1: Logged‐in owner
        if ($user && $record->creator === $user->name) {
            return $next($request);
        }

        // Case 2: Anonymous owner by token
        if (! $user
            && $anonTok
            && $record->creator_token
            && hash_equals($record->creator_token, $anonTok)
        ) {
            return $next($request);
        }

        // Otherwise, block
        if ($request->expectsJson()) {
            return response()->json(['error' => 'Forbidden'], 403);
        }

        return redirect("/{$book}")
                    ->with('error', 'You do not have permission to edit this book.');
    }
}