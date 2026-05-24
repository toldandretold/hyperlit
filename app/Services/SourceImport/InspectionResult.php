<?php

namespace App\Services\SourceImport;

use App\Models\CanonicalSource;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Services\SourceImport\Policy\ImportPlan;

/**
 * What the orchestrator returns when asked "what would happen if I imported this?"
 * Drives the preview card UI and (on commit) is fed back to the orchestrator's
 * import() method so we don't re-resolve.
 */
final class InspectionResult
{
    public function __construct(
        public readonly bool $ok,
        public readonly ?Identifier $identifier,
        public readonly ?SourceMetadata $metadata,
        public readonly ?ImportPlan $plan,
        public readonly ?CanonicalSource $existingCanonical,
        public readonly ?string $error,
    ) {}

    public static function success(
        Identifier $identifier,
        SourceMetadata $metadata,
        ImportPlan $plan,
        ?CanonicalSource $existingCanonical,
    ): self {
        return new self(true, $identifier, $metadata, $plan, $existingCanonical, null);
    }

    public static function failure(string $error, ?Identifier $identifier = null): self
    {
        return new self(false, $identifier, null, null, null, $error);
    }
}
