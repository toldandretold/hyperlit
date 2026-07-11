<?php

namespace App\Http\Controllers\Concerns;

use App\Models\AnonymousSession;
use App\Models\PgLibrary;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Owner-resolution for book-scoped write endpoints (source verification, reference verification).
 *
 * These endpoints write via pgsql_admin (RLS bypass — an authenticated user has no
 * library.creator_token so an RLS-connection UPDATE is blocked), which makes the PHP owner check
 * below THE authorization boundary. Mirrors DbLibraryController's owner-resolution; kept in a trait
 * so SourceVerificationController and ReferenceSourceVerificationController share one copy.
 */
trait ResolvesBookOwner
{
    /**
     * Resolve the caller's identity and whether they own $book.
     *
     * @return array{0: ?PgLibrary, 1: ?\Illuminate\Http\JsonResponse, 2: ?array} [library, denyResponse, creatorInfo]
     */
    protected function authorizeBookEdit(Request $request, string $book): array
    {
        $library = PgLibrary::where('book', $book)->first();
        if (!$library) {
            return [null, response()->json(['success' => false, 'message' => 'Book not found'], 404), null];
        }

        $info = $this->getCreatorInfo($request);
        if (!$info['valid']) {
            return [$library, response()->json(['success' => false, 'message' => 'Invalid session'], 401), $info];
        }

        $isOwner = ($library->creator && $library->creator === $info['creator']) ||
                   ($library->creator_token && $library->creator_token === $info['creator_token']);
        if (!$isOwner) {
            return [$library, response()->json(['success' => false, 'message' => 'Forbidden'], 403), $info];
        }

        return [$library, null, $info];
    }

    protected function getCreatorInfo(Request $request): array
    {
        $user = Auth::user();
        if ($user) {
            return ['creator' => $user->name, 'creator_token' => null, 'valid' => true];
        }

        $anonToken = $request->cookie('anon_token');
        if (!$anonToken || !$this->isValidAnonymousToken($anonToken)) {
            return ['creator' => null, 'creator_token' => null, 'valid' => false];
        }

        AnonymousSession::where('token', $anonToken)->update(['last_used_at' => now()]);
        return ['creator' => null, 'creator_token' => $anonToken, 'valid' => true];
    }

    protected function isValidAnonymousToken(?string $token): bool
    {
        if (!$token) return false;
        // Anonymous sessions valid for 90 days (matches DbLibraryController).
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->first() !== null;
    }

    /** Attribution string stamped on a write: username, or anon:<token-prefix>. */
    protected function matchedBy(?array $info): string
    {
        if (!empty($info['creator'])) return (string) $info['creator'];
        return 'anon:' . substr((string) ($info['creator_token'] ?? ''), 0, 8);
    }
}
