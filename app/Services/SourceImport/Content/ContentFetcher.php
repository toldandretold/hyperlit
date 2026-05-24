<?php

namespace App\Services\SourceImport\Content;

use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;

/**
 * Fetches the actual content (HTML / PDF / etc.) for a given identifier into the
 * supplied directory. Fetchers know nothing about library records or processors;
 * they just produce a local file the existing per-format pipeline can consume.
 */
interface ContentFetcher
{
    public function supports(Identifier $id, SourceMetadata $metadata): bool;

    /**
     * @param string $destDir Directory to write the fetched file into. Must exist.
     */
    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult;
}
