<?php

namespace App\Services\CitationReview\Phases;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

/**
 * Phase 2 of the citation review: batch-resolve every unique referenceId to its
 * source metadata + provenance tier (canonical-verified > web-verified > local >
 * unverified), choosing the most genuine version with content to check against.
 *
 * Extracted verbatim from CitationReviewService::enrichCitationMetadata.
 */
final class MetadataEnricher
{
    public function __construct(private BestVersionService $bestVersions) {}

    public function enrichCitationMetadata(array $citationNodes, string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        // Collect all unique reference IDs
        $allRefIds = [];
        foreach ($citationNodes as $node) {
            foreach ($node['reference_ids'] as $refId) {
                $allRefIds[$refId] = true;
            }
        }
        $allRefIds = array_keys($allRefIds);

        if (empty($allRefIds)) {
            return [];
        }

        // Batch query 1: bibliography → foundation_source + citation content
        $bibEntries = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereIn('referenceId', $allRefIds)
            ->select(['referenceId', 'foundation_source', 'content', 'llm_metadata', 'match_method', 'match_score', 'canonical_source_id'])
            ->get()
            ->keyBy('referenceId');

        // Check footnotes for any IDs not found in bibliography. (footnotes has
        // no canonical column — the canonical is reached via the foundation row.)
        $missingIds = array_diff($allRefIds, $bibEntries->keys()->toArray());
        if (!empty($missingIds)) {
            $fnEntries = $db->table('footnotes')
                ->where('book', $bookId)
                ->whereIn('footnoteId', $missingIds)
                ->select(['footnoteId as referenceId', 'foundation_source', 'content', 'llm_metadata', 'match_method', 'match_score', $db->raw('NULL as canonical_source_id')])
                ->get()
                ->keyBy('referenceId');
            $bibEntries = $bibEntries->merge($fnEntries);
        }

        // Collect foundation_source book IDs for library lookup
        $sourceBookIds = [];
        foreach ($bibEntries as $entry) {
            $source = $entry->foundation_source ?? null;
            if ($source && $source !== 'unknown') {
                $sourceBookIds[$source] = true;
            }
        }

        // Batch query 2: library records
        $libraryRecords = [];
        if (!empty($sourceBookIds)) {
            $libraryRecords = $db->table('library')
                ->whereIn('book', array_keys($sourceBookIds))
                ->select(['book', 'title', 'author', 'year', 'openalex_id', 'open_library_key', 'abstract', 'has_nodes', 'type', 'url', 'doi', 'oa_url', 'canonical_source_id', 'conversion_method'])
                ->get()
                ->keyBy('book');
        }

        // Batch query 3: canonical works — reachable via the bibliography entry
        // OR via the foundation library row's link.
        $canonicalIds = [];
        foreach ($bibEntries as $entry) {
            if (!empty($entry->canonical_source_id)) {
                $canonicalIds[$entry->canonical_source_id] = true;
            }
        }
        foreach ($libraryRecords as $lib) {
            if (!empty($lib->canonical_source_id)) {
                $canonicalIds[$lib->canonical_source_id] = true;
            }
        }
        $canonicals = empty($canonicalIds)
            ? collect()
            : CanonicalSource::whereIn('id', array_keys($canonicalIds))->get()->keyBy('id');

        // Build lookup map
        $citationMeta = [];
        foreach ($allRefIds as $refId) {
            $bib = $bibEntries[$refId] ?? null;
            $source = $bib->foundation_source ?? null;
            $lib = ($source && $source !== 'unknown') ? ($libraryRecords[$source] ?? null) : null;

            $resolvedSource = ($source && $source !== 'unknown') ? $source : null;

            $canonicalId = $bib->canonical_source_id ?? $lib->canonical_source_id ?? null;
            $canonical = $canonicalId ? ($canonicals[$canonicalId] ?? null) : null;

            // Which identity authorities recognise the work (empty for a WEB
            // canonical — it groups versions by URL but has no academic identity).
            $canonicalSignals = $canonical ? array_keys(array_filter([
                'openalex'           => !empty($canonical->openalex_id),
                'doi'                => !empty($canonical->doi),
                'open_library'       => !empty($canonical->open_library_key),
                'semantic_scholar'   => !empty($canonical->semantic_scholar_id),
                'publisher_verified' => (bool) $canonical->verified_by_publisher,
            ])) : [];

            // Provenance tier: canonical-verified > web-verified > local > unverified.
            // CRITICAL: a WEB canonical (type='web', no academic signals) must NOT
            // show as canonical-verified — it groups versions but makes no academic
            // claim. Only an academically-signalled canonical earns the canonical tier.
            $hasFoundation = ($resolvedSource !== null && $lib !== null);
            $academicCanonical = $canonical && !empty($canonicalSignals);
            // Web-source verification status — drives honest, web-specific messaging
            // (distinct from the academic 'local' line). 'rejected' = the URL hosts
            // a DIFFERENT article; 'unverified' = couldn't confirm; 'verified' = match.
            $webStatus = match ($lib->conversion_method ?? null) {
                'web_article_verified'   => 'verified',
                'web_article_unverified' => 'unverified',
                'web_article_rejected'   => 'rejected',
                default => (($lib->type ?? null) === 'web_source') ? 'unverified' : null,
            };
            $webVerified = $webStatus === 'verified'
                || ($canonical && ($canonical->type ?? null) === 'web');
            if ($academicCanonical) {
                $tier = 'canonical';
            } elseif ($webVerified) {
                $tier = 'web';
            } elseif ($hasFoundation) {
                $tier = 'local';
            } else {
                $tier = 'unverified';
            }

            // Content resolution: prefer the canonical's best genuine version
            // (auto version is untampered by construction); fall back to the
            // foundation row — today's behavior — when no canonical version
            // has content.
            $contentBook = $resolvedSource;
            $hasContent  = (bool) ($lib->has_nodes ?? false);
            $provenance  = $hasContent ? 'foundation' : null;

            if ($canonical && ($best = $this->bestVersions->bestPublicContentVersion($canonical))) {
                $contentBook = $best['book'];
                $hasContent  = true;
                $provenance  = $best['pointer']
                    ? str_replace('_book', '', $best['pointer'])   // e.g. auto_version
                    : 'linked_version';
            }

            $citationMeta[$refId] = [
                'title'               => $lib->title ?? $canonical?->title,
                'author'              => $lib->author ?? $canonical?->author,
                'year'                => $lib->year ?? $canonical?->year,
                'abstract'            => $lib->abstract ?? $canonical?->abstract,
                'verified'            => $tier !== 'unverified',
                'source_book_id'      => $contentBook,
                'has_source_content'  => $hasContent,
                'bib_citation'        => $bib->content ?? null,
                'source_type'         => $lib->type ?? $canonical?->type,
                'url'                 => $lib->url ?? null,
                'doi'                 => $lib->doi ?? $canonical?->doi,
                'oa_url'              => $lib->oa_url ?? $canonical?->oa_url,
                'llm_metadata'        => is_string($bib->llm_metadata ?? null) ? json_decode($bib->llm_metadata, true) : null,
                'match_method'        => $bib->match_method ?? null,
                'match_score'         => $bib->match_score ?? null,
                'canonical_source_id' => $canonicalId,
                'canonical_signals'   => $canonicalSignals,
                'verification_tier'   => $tier,
                'web_status'          => $webStatus,
                'content_provenance'  => $provenance,
            ];
        }

        return $citationMeta;
    }
}
