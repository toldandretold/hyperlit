<?php

namespace App\Http\Controllers;

use App\Models\AnonymousSession;
use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use App\Services\OpenAlexService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;

/**
 * The [check source] flow: look a book's citation identity up against our canonicals + the external
 * APIs (preview, read-only), then on user confirmation link it to a canonical and overwrite the
 * library row's identity fields (verify). The heavy lifting lives in CanonicalSourceMatcher; this
 * controller is the owner-gated HTTP seam. Writes happen via pgsql_admin inside the matcher, so the
 * owner check here is the authorisation boundary.
 */
class SourceVerificationController extends Controller
{
    public function __construct(
        private readonly CanonicalSourceMatcher $matcher,
        private readonly OpenAlexService $openAlex,
    ) {}

    /** POST /api/library/{book}/source/lookup — read-only candidate preview. */
    public function lookup(Request $request, string $book)
    {
        [$library, $deny] = $this->authorizeEdit($request, $book);
        if ($deny) return $deny;

        try {
            $preview = $this->matcher->preview($library);
        } catch (\Throwable $e) {
            Log::warning('source lookup failed', ['book' => $book, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Lookup failed'], 500);
        }

        return response()->json(['success' => true] + $preview);
    }

    /**
     * POST /api/library/{book}/source/verify  body: { identifier: {openalex_id|doi|open_library_key|
     * semantic_scholar_id} }. canonical_source is SHARED, so we never trust client-supplied citation
     * text — we re-run preview() server-side and link only a candidate WE resolved whose identifier
     * matches the user's choice.
     */
    public function verify(Request $request, string $book)
    {
        [$library, $deny, $info] = $this->authorizeEdit($request, $book);
        if ($deny) return $deny;

        $identifier = array_filter((array) $request->input('identifier', []));
        if (empty($identifier)) {
            return response()->json(['success' => false, 'message' => 'identifier required'], 422);
        }

        try {
            $preview = $this->matcher->preview($library);
        } catch (\Throwable $e) {
            Log::warning('source verify preview failed', ['book' => $book, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Verification failed'], 500);
        }

        $candidate = $this->pickByIdentifier($preview, $identifier);

        // Fallback: a DOI can be resolved directly even if the fresh preview shifted under us.
        if (!$candidate && !empty($identifier['doi'])) {
            try {
                $candidate = $this->openAlex->fetchByDoi($identifier['doi']) ?: null;
            } catch (\Throwable $e) {
                Log::warning('source verify doi re-resolve failed', ['book' => $book, 'err' => $e->getMessage()]);
            }
        }

        if (!$candidate) {
            return response()->json(['success' => false, 'message' => 'Could not re-resolve the selected source'], 422);
        }

        $canonical = $this->matcher->verifyAndLink($library, $candidate, $this->matchedBy($info));

        return response()->json([
            'success' => true,
            'canonical_source_id' => $canonical->id,
            'library' => $this->citationFields(PgLibrary::where('book', $book)->first()),
        ]);
    }

    /** POST /api/library/{book}/source/reject — user looked and there's no match; don't re-prompt. */
    public function reject(Request $request, string $book)
    {
        [$library, $deny, $info] = $this->authorizeEdit($request, $book);
        if ($deny) return $deny;

        $this->matcher->stampUserRejected($library, $this->matchedBy($info));
        return response()->json(['success' => true]);
    }

    // ──────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────

    /**
     * @return array{0: ?PgLibrary, 1: ?\Illuminate\Http\JsonResponse, 2: ?array} [library, denyResponse, creatorInfo]
     */
    private function authorizeEdit(Request $request, string $book): array
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

    /** Find a previewed candidate (best / alternates / current) whose identifier matches the request. */
    private function pickByIdentifier(array $preview, array $identifier): ?array
    {
        $pool = [];
        if (!empty($preview['candidate'])) $pool[] = $preview['candidate'];
        foreach (($preview['alternates'] ?? []) as $alt) $pool[] = $alt;
        if (!empty($preview['current'])) $pool[] = $preview['current'];

        foreach ($pool as $cand) {
            foreach (['openalex_id', 'doi', 'open_library_key', 'semantic_scholar_id'] as $k) {
                if (!empty($identifier[$k]) && !empty($cand[$k]) && $identifier[$k] === $cand[$k]) {
                    return $cand;
                }
            }
        }
        return null;
    }

    /** The fields the frontend needs to refresh its local library record after a verify. */
    private function citationFields(?PgLibrary $l): array
    {
        if (!$l) return [];
        return [
            'book'                     => $l->book,
            'title'                    => $l->title,
            'author'                   => $l->author,
            'year'                     => $l->year,
            'journal'                  => $l->journal,
            'publisher'                => $l->publisher,
            'doi'                      => $l->doi,
            'type'                     => $l->type,
            'bibtex'                   => $l->bibtex,
            'url'                      => $l->url,
            'canonical_source_id'      => $l->canonical_source_id,
            'canonical_match_method'   => $l->canonical_match_method,
            'canonical_match_score'    => $l->canonical_match_score !== null ? (float) $l->canonical_match_score : null,
            'canonical_metadata_score' => $l->canonical_metadata_score !== null ? (float) $l->canonical_metadata_score : null,
            'human_reviewed_at'        => $l->human_reviewed_at,
        ];
    }

    private function matchedBy(?array $info): string
    {
        if (!empty($info['creator'])) return (string) $info['creator'];
        return 'anon:' . substr((string) ($info['creator_token'] ?? ''), 0, 8);
    }

    // The next two mirror DbLibraryController's owner-resolution (kept local to avoid editing that
    // large, critical controller; a shared trait is a fine future refactor).

    private function getCreatorInfo(Request $request): array
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

    private function isValidAnonymousToken(?string $token): bool
    {
        if (!$token) return false;
        // Anonymous sessions valid for 90 days (matches DbLibraryController).
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->first() !== null;
    }
}
