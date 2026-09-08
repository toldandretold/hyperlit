<?php

namespace App\Http\Controllers;

use App\Services\UserPageSettingsValidator;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Owner-only writes to the /u/{username} hero-page customization
 * (library.page_settings on the user-home book row). Reads happen
 * server-side in UserHomeServerController::show — there is no GET here.
 *
 * The target row is always derived from the AUTHENTICATED user, never from
 * the payload, so a user can only ever customize their own page. Partial
 * updates: only keys present in the payload are touched; explicit null
 * clears a key.
 */
class UserPageSettingsController extends Controller
{
    public function update(Request $request, UserPageSettingsValidator $validator)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $book = str_replace(' ', '', $user->name);

        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->where('creator', $user->name)
            ->first(['book', 'page_settings']);

        if (!$row) {
            // The home book is minted on first profile visit; without it there
            // is nothing to attach settings to (and no ownership anchor).
            return response()->json(['error' => 'User page not found — visit your page first.'], 404);
        }

        $result = $validator->validate($request->all(), $book, $user->name);
        if (!$result['ok']) {
            return response()->json(['error' => 'Validation failed', 'errors' => $result['errors']], 422);
        }

        $current = $row->page_settings ? (json_decode($row->page_settings, true) ?: []) : [];
        $merged = array_merge($current, $result['settings']);
        // Explicit nulls clear their key entirely so the stored blob stays lean.
        $merged = array_filter($merged, fn ($v) => $v !== null);

        DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->update([
                'page_settings' => $merged ? json_encode($merged) : null,
                'updated_at' => now(),
            ]);

        return response()->json([
            'success' => true,
            'page_settings' => $merged ?: (object) [],
        ]);
    }
}
