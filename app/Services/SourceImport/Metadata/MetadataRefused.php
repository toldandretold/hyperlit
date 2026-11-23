<?php

namespace App\Services\SourceImport\Metadata;

/**
 * A resolver recognised the identifier and can say WHY it cannot be imported —
 * "that page is an index of works, not a work" — which is more use to the
 * person than the orchestrator's generic `metadata_unavailable`. The code is
 * what the UI switches on.
 */
class MetadataRefused extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $detail = '')
    {
        parent::__construct($detail !== '' ? "{$errorCode}: {$detail}" : $errorCode);
    }
}
