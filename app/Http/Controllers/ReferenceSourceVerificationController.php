<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\ResolvesBookOwner;
use App\Services\BibliographySourceLookupService;
use App\Services\BookCache;
use App\Services\OpenAlexService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Reference-level (bibliography) "Check source" — an OWNER/creator-only action (readers still SEE the
 * verified/suggested citation the creator produced, they just can't run the check). Owner-gating the
 * lookup also means only the book owner can ever trigger the paid LLM metadata fallback, and that
 * result is cached so it's paid at most once. Capabilities:
 *   • lookup — live candidate search for one reference (seeded from its metadata).
 *   • verify/reject — the owner confirms a picked candidate (links the canonical + stamps
 *     user_verified) or an existing auto match, or rejects.
 *
 * Keyed on [book, referenceId]. Writes go through pgsql_admin because an authenticated user has no
 * library.creator_token, so an RLS-connection UPDATE on bibliography is blocked — the PHP owner
 * check here is the authorisation boundary (same pattern as the book-level flow).
 */
class ReferenceSourceVerificationController extends Controller
{
    use ResolvesBookOwner;

    public function __construct(
        private readonly BookCache $cache,
        private readonly BibliographySourceLookupService $lookupService,
        private readonly OpenAlexService $openAlex,
    ) {}

    /**
     * POST /api/library/{book}/reference/{refId}/source/lookup — candidate preview. OWNER-gated: the
     * check is a creator action, and this keeps the paid LLM fallback owner-only.
     */
    public function lookup(Request $request, string $book, string $refId)
    {
        [, $deny] = $this->authorizeBookEdit($request, $book);
        if ($deny) return $deny;

        try {
            $preview = $this->lookupService->previewReference($book, $refId);
        } catch (\Throwable $e) {
            Log::warning('reference source lookup failed', ['book' => $book, 'ref' => $refId, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Lookup failed'], 500);
        }

        return response()->json(['success' => true] + $preview);
    }

    /**
     * POST /api/library/{book}/reference/{refId}/source/verify — author confirms a match. With
     * `{identifier}` in the body the author picked a candidate (works even on a previously-unmatched
     * reference): re-resolve it, link the canonical, stamp verified. Without an identifier it confirms
     * the existing auto match.
     */
    public function verify(Request $request, string $book, string $refId)
    {
        $identifier = array_filter((array) $request->input('identifier', []));
        if (empty($identifier)) {
            return $this->decide($request, $book, $refId, 'user_verified');
        }

        [, $deny, $info] = $this->authorizeBookEdit($request, $book);
        if ($deny) return $deny;

        $reference = DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $book)->where('referenceId', $refId)->first();
        if (!$reference) {
            return response()->json(['success' => false, 'message' => 'Reference not found'], 404);
        }

        try {
            $preview = $this->lookupService->previewReference($book, $refId, forVerify: true);
        } catch (\Throwable $e) {
            Log::warning('reference source verify preview failed', ['book' => $book, 'ref' => $refId, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Verification failed'], 500);
        }

        $candidate = $this->lookupService->pickByIdentifier($preview, $identifier);
        // Fallback: a DOI can be resolved directly even if the fresh preview shifted under us.
        if (!$candidate && !empty($identifier['doi'])) {
            try {
                $candidate = $this->openAlex->fetchByDoi($identifier['doi']) ?: null;
            } catch (\Throwable $e) {
                Log::warning('reference verify doi re-resolve failed', ['book' => $book, 'ref' => $refId, 'err' => $e->getMessage()]);
            }
        }
        if (!$candidate) {
            return response()->json(['success' => false, 'message' => 'Could not re-resolve the selected source'], 422);
        }

        $canonicalId = $this->lookupService->linkCanonical($book, $refId, $candidate, $this->matchedBy($info));
        $this->cache->invalidate($book);

        return response()->json([
            'success' => true,
            'referenceId' => $refId,
            'canonical_source_id' => $canonicalId,
            'reference_match_method' => 'user_verified',
        ]);
    }

    /** POST /api/library/{book}/reference/{refId}/source/reject — author rejects the match. */
    public function reject(Request $request, string $book, string $refId)
    {
        return $this->decide($request, $book, $refId, 'user_rejected');
    }

    private function decide(Request $request, string $book, string $refId, string $method)
    {
        [, $deny, $info] = $this->authorizeBookEdit($request, $book);
        if ($deny) return $deny;

        // Read via pgsql_admin — a private book's bibliography rows aren't SELECTable over the RLS
        // connection by an authenticated (token-less) owner.
        $reference = DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $book)->where('referenceId', $refId)->first();

        if (!$reference) {
            return response()->json(['success' => false, 'message' => 'Reference not found'], 404);
        }
        if (empty($reference->canonical_source_id)) {
            return response()->json(['success' => false, 'message' => 'No canonical match to verify'], 422);
        }

        // Stale-card guard: if the client carried the canonical it saw, refuse to stamp when the
        // stored match has since changed under it.
        $clientCanonical = $request->input('canonical_source_id');
        if ($clientCanonical && (string) $clientCanonical !== (string) $reference->canonical_source_id) {
            return response()->json(['success' => false, 'message' => 'Match changed; reopen the citation'], 409);
        }

        DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $book)->where('referenceId', $refId)
            ->update([
                'reference_match_method' => $method,
                'reference_verified_at'  => now(),
                'reference_verified_by'  => $this->matchedBy($info),
                'updated_at'             => now(),
            ]);

        // The bibliography cache snapshot now carries a stale decision — drop it so a reload
        // re-warms with the persisted reference_match_method (the client also updates IDB locally).
        $this->cache->invalidate($book);

        return response()->json([
            'success' => true,
            'referenceId' => $refId,
            'canonical_source_id' => $reference->canonical_source_id,
            'reference_match_method' => $method,
        ]);
    }
}
