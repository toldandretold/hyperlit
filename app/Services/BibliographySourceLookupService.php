<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Reference-level "Check source": preview canonical candidates for ONE bibliography reference (seeded
 * from its extracted citation metadata), and — when the book's author confirms a pick — link the
 * canonical onto the reference. Reuses CanonicalSourceMatcher's whole search/scoring engine via its
 * metadata-seeded preview; writes go through pgsql_admin (the CONTROLLER owner-gates first).
 *
 * The preview is read-only and safe to expose to any reader (finding a source doesn't mutate the
 * book); only linkCanonical() writes, and only the owner-gated controller path calls it.
 */
class BibliographySourceLookupService
{
    public function __construct(
        private readonly CanonicalSourceMatcher $matcher,
        private readonly LlmService $llm,
    ) {}

    /** Read-only candidate preview for a reference. Same envelope as CanonicalSourceMatcher::preview. */
    public function previewReference(string $book, string $refId, bool $forVerify = false): array
    {
        $ref = DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $book)->where('referenceId', $refId)->first();

        if (!$ref) {
            return ['status' => 'no_match', 'method' => null, 'score' => null,
                    'candidate' => null, 'alternates' => [], 'alreadyLinked' => false, 'current' => null];
        }

        $meta = $this->metadataFor($ref);
        if (empty($meta['title'])) {
            return ['status' => 'no_match', 'method' => null, 'score' => null,
                    'candidate' => null, 'alternates' => [], 'alreadyLinked' => false, 'current' => null];
        }

        return $this->matcher->previewFromMetadata($meta, $forVerify);
    }

    /**
     * Link a user-picked candidate onto the reference: resolve/upsert the shared canonical, then stamp
     * the reference verified. Owner-gated by the caller. Returns the canonical id.
     */
    public function linkCanonical(string $book, string $refId, array $candidate, string $by): string
    {
        $canonical = $this->matcher->ingestExternal($candidate, 'user_verified');

        DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $book)->where('referenceId', $refId)
            ->update([
                'canonical_source_id'    => $canonical->id,
                'reference_match_method' => 'user_verified',
                'reference_verified_at'  => now(),
                'reference_verified_by'  => $by,
                'updated_at'             => now(),
            ]);

        return $canonical->id;
    }

    /** Find the previewed candidate (best / alternates / current) whose identifier matches the choice. */
    public function pickByIdentifier(array $preview, array $identifier): ?array
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

    /**
     * The reference's extracted citation metadata — cached llm_metadata, else a best-effort LLM
     * extract. The extraction is the only PAID step and is reached only from owner-gated endpoints;
     * we persist the result so the cost is incurred at most once per reference.
     */
    private function metadataFor(object $ref): array
    {
        $meta = is_string($ref->llm_metadata ?? null) ? json_decode($ref->llm_metadata, true) : ($ref->llm_metadata ?? null);
        if (is_array($meta) && !empty($meta['title'])) {
            return $meta;
        }
        if (!empty($ref->content)) {
            try {
                $extracted = $this->llm->extractCitationMetadata((string) $ref->content);
                if (is_array($extracted)) {
                    // Cache it — a one-time cost. Subsequent checks read the cached copy for free.
                    DB::connection('pgsql_admin')->table('bibliography')
                        ->where('book', $ref->book)->where('referenceId', $ref->referenceId)
                        ->update(['llm_metadata' => json_encode($extracted), 'updated_at' => now()]);
                    return $extracted;
                }
            } catch (\Throwable $e) {
                Log::warning('reference metadata extract failed', ['book' => $ref->book, 'ref' => $ref->referenceId, 'err' => $e->getMessage()]);
            }
        }
        return [];
    }
}
