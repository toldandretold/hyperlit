<?php

namespace App\Services\SourceImport\Policy;

/**
 * The decision AccessPolicy makes about a single URL-based import: whether to
 * create a canonical public version, whether to let the importer publish their
 * own version, whether to charge them, and what access flag to stamp.
 */
final class ImportPlan
{
    public function __construct(
        public readonly bool $createCanonicalVersion,
        public readonly bool $allowPublish,
        public readonly bool $chargeUser,
        /** 'open' | 'closed' — sets the version's access flag and downstream UI affordances. */
        public readonly string $access,
        public readonly string $reason,
    ) {}
}
