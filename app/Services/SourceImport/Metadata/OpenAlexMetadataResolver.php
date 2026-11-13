<?php

namespace App\Services\SourceImport\Metadata;

use App\Services\OpenAlexService;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Identifier\OpenAlexId;
use Illuminate\Support\Facades\Log;

/**
 * Thin adapter over OpenAlexService::fetchByDoi() / fetchByOpenAlexId(). Exists so the
 * orchestrator depends on the MetadataResolver interface rather than directly on OpenAlexService.
 */
class OpenAlexMetadataResolver implements MetadataResolver
{
    public function __construct(private readonly OpenAlexService $openAlex) {}

    public function supports(Identifier $id): bool
    {
        return $id instanceof Doi || $id instanceof OpenAlexId;
    }

    public function resolve(Identifier $id): ?SourceMetadata
    {
        if (!$this->supports($id)) {
            return null;
        }

        try {
            $normalised = $id instanceof OpenAlexId
                ? $this->openAlex->fetchByOpenAlexId($id->value())
                : $this->openAlex->fetchByDoi($id->value());
        } catch (\Throwable $e) {
            // Network/connection failures shouldn't 500 the inspect endpoint.
            // The orchestrator turns null into a clean "metadata_unavailable" response.
            Log::warning('OpenAlex resolve threw', [
                'identifier' => $id->kind() . ':' . $id->value(),
                'error'      => $e->getMessage(),
            ]);
            return null;
        }

        if (!$normalised) {
            return null;
        }

        return new SourceMetadata($normalised, 'openalex');
    }
}
