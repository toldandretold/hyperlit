<?php

namespace App\Http\Controllers;

use App\Jobs\DeleteUserAccountJob;
use App\Models\User;
use App\Services\UserAccountDeletionService;
use App\Support\UserHomeBookNames;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

/**
 * Account deletion endpoints (Data sovereignty menu).
 *
 * preview() feeds the client's choice/confirmation dialogs; destroy() verifies
 * the password, kills every session NOW (the account is dead the moment the
 * response leaves, completion is confirmed by email), and queues the heavy
 * cleanup (UserAccountDeletionService) on the DEFAULT queue — this is not a
 * user import, so the `imports` priority lane rules don't apply.
 */
class AccountDeletionController extends Controller
{
    /** Counts for the deletion dialog, read on pgsql_admin (bulk, cross-table). */
    public function preview(Request $request)
    {
        $user = Auth::user();
        $admin = DB::connection('pgsql_admin');

        $generated = UserHomeBookNames::allGeneratedNames(UserHomeBookNames::sanitize($user->name));

        $roots = $admin->table('library')
            ->where('creator', $user->name)
            ->where('book', 'not like', '%/%')
            ->whereNotIn('book', $generated)
            ->where('visibility', '!=', 'deleted')
            ->get(['visibility', 'encrypted']);

        $publicBooks = $roots->filter(fn ($r) => $r->visibility === 'public' && empty($r->encrypted))->count();
        $encryptedBooks = $roots->filter(fn ($r) => ! empty($r->encrypted))->count();
        $privateBooks = $roots->count() - $publicBooks - $encryptedBooks;

        $annotations = $admin->table('hyperlights')->where('creator', $user->name)->count()
            + $admin->table('hypercites')->where('creator', $user->name)->count();

        return response()->json([
            'success' => true,
            'public_books' => $publicBooks,
            'private_books' => $privateBooks,
            'encrypted_books' => $encryptedBooks,
            'annotations' => $annotations,
            'has_vault' => $admin->table('user_e2ee_vaults')->where('user_id', $user->id)->exists(),
        ]);
    }

    public function destroy(Request $request)
    {
        $user = Auth::user();

        $validated = $request->validate([
            'password' => 'required|string',
            'books' => 'required|in:'.implode(',', UserAccountDeletionService::CHOICES),
            'annotations' => 'required|in:'.implode(',', UserAccountDeletionService::CHOICES),
        ]);

        if (! Hash::check($validated['password'], $user->password)) {
            return response()->json([
                'success' => false,
                'message' => 'Incorrect password',
            ], 422);
        }

        $admin = DB::connection('pgsql_admin');

        // The point of no return: block logins (the login guard refuses
        // 'deleting'), kill every session and API token on every device, and
        // drop the cached RLS token so no in-flight request outlives this.
        $admin->table('users')->where('id', $user->id)->update(['status' => 'deleting']);
        $admin->table('sessions')->where('user_id', $user->id)->delete();
        $admin->table('personal_access_tokens')
            ->where('tokenable_type', User::class)->where('tokenable_id', $user->id)->delete();
        Cache::forget("user_token:{$user->id}");

        DeleteUserAccountJob::dispatch($user->id, $validated['books'], $validated['annotations']);

        // Sanctum's stateful path rides a session; a pure token request has no
        // session store at all — guard, or this 500s after the job is queued.
        if ($request->hasSession()) {
            Auth::guard('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }

        Log::info('Account deletion accepted', ['user_id' => $user->id]);

        return response()->json([
            'success' => true,
            'message' => 'Your account is being deleted. A confirmation email will follow.',
        ], 202);
    }
}
