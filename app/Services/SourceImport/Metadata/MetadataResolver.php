<?php

namespace App\Services\SourceImport\Metadata;

use App\Services\SourceImport\Identifier\Identifier;

/**
 * Resolves an Identifier into SourceMetadata. Implementations are identifier-type-
 * specific; ImportOrchestrator dispatches on instanceof.
 */
interface MetadataResolver
{
    public function supports(Identifier $id): bool;

    public function resolve(Identifier $id): ?SourceMetadata;
}
