<?php

namespace App\Services\SourceImport\Metadata;

use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\Identifier;

/**
 * Resolves arXiv IDs by translating to the arXiv-minted DOI (10.48550/arXiv.<id>)
 * and delegating to OpenAlex. Coverage in OpenAlex is high for arXiv preprints; a
 * direct arXiv-API fallback for the misses is a follow-up.
 */
class ArxivMetadataResolver implements MetadataResolver
{
    public function __construct(private readonly OpenAlexMetadataResolver $openAlex) {}

    public function supports(Identifier $id): bool
    {
        return $id instanceof ArxivId;
    }

    public function resolve(Identifier $id): ?SourceMetadata
    {
        if (!$id instanceof ArxivId) {
            return null;
        }

        $metadata = $this->openAlex->resolve($id->asDoi());
        if (!$metadata) {
            return null;
        }

        // Re-stamp source so callers can distinguish "found via arXiv flow" from
        // "found via direct DOI flow" — useful for telemetry and for the fetcher
        // dispatch (arxiv source → ar5iv first, OA pdf_url second).
        return new SourceMetadata($metadata->data, 'arxiv');
    }
}
