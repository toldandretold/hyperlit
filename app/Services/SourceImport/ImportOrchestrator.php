<?php

namespace App\Services\SourceImport;

use App\Services\SourceImport\Content\ContentFetcher;
use App\Services\SourceImport\Content\FetchResult;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Identifier\IdentifierNormalizer;
use App\Services\SourceImport\Metadata\MetadataResolver;
use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Services\SourceImport\Policy\AccessPolicy;
use Illuminate\Support\Facades\Log;

/**
 * Coordinates URL-based imports across the four sub-layers
 * (Identifier · CanonicalRegistry · MetadataResolver · ContentFetcher + AccessPolicy).
 *
 * Two phases the controller can call independently:
 *   inspect()       — synchronous, fast, no side effects (drives the preview card).
 *   fetchContent()  — does the actual HTTP/download (the only step with file I/O).
 *
 * Library-record creation and processor dispatch stay in the controller; that work
 * is Laravel-shaped (auth, billing, queues) and benefits from being out of here.
 *
 * @param iterable<MetadataResolver> $resolvers
 * @param iterable<ContentFetcher>   $fetchers
 */
class ImportOrchestrator
{
    /**
     * @param iterable<MetadataResolver> $resolvers
     * @param iterable<ContentFetcher>   $fetchers
     */
    public function __construct(
        private readonly IdentifierNormalizer $normaliser,
        private readonly CanonicalRegistry $registry,
        private readonly AccessPolicy $policy,
        private readonly iterable $resolvers,
        private readonly iterable $fetchers,
    ) {}

    /**
     * Parse the user's input, look up dedup, resolve metadata, compute the plan.
     * No I/O beyond the metadata HTTP call. Safe to call on every keystroke after
     * the user finishes pasting (debounce in the UI).
     */
    public function inspect(string $userInput): InspectionResult
    {
        $identifier = $this->normaliser->parse($userInput);
        if (!$identifier) {
            return InspectionResult::failure('unrecognised_identifier');
        }

        // Dedup before spending an API call: if we already have this canonical,
        // the UI shows "existing source" and the user picks view vs. own-version.
        $existing = $this->registry->findByIdentifier($identifier);

        $metadata = $this->resolveMetadata($identifier);
        if (!$metadata) {
            // If the registry hit, we still know the work exists in our library —
            // surface that instead of a bare error.
            if ($existing) {
                return InspectionResult::failure('metadata_unavailable_but_canonical_exists', $identifier);
            }
            return InspectionResult::failure('metadata_unavailable', $identifier);
        }

        $plan = $this->policy->decide($metadata);

        return InspectionResult::success($identifier, $metadata, $plan, $existing);
    }

    /**
     * Run the fetcher chain for this identifier into the given directory. Returns
     * the first successful fetcher's result, or the last failure if none worked.
     */
    public function fetchContent(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        $lastFailure = FetchResult::failure('no_fetcher_attempted');

        foreach ($this->fetchers as $fetcher) {
            if (!$fetcher->supports($id, $metadata)) {
                continue;
            }
            $result = $fetcher->fetch($id, $metadata, $destDir);
            if ($result->ok) {
                return $result;
            }
            $lastFailure = $result;
            Log::info('Fetcher attempt failed, trying next', [
                'identifier' => $id->kind() . ':' . $id->value(),
                'fetcher'    => $fetcher::class,
                'reason'     => $result->reason,
                'status'     => $result->httpStatus,
            ]);
        }

        return $lastFailure;
    }

    private function resolveMetadata(Identifier $id): ?SourceMetadata
    {
        foreach ($this->resolvers as $resolver) {
            if ($resolver->supports($id)) {
                $metadata = $resolver->resolve($id);
                if ($metadata) {
                    return $metadata;
                }
            }
        }
        return null;
    }
}
