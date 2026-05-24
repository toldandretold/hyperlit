<?php

namespace App\Services\SourceImport\Content;

/**
 * Outcome of a content-fetch attempt. Failures are values, not exceptions —
 * the orchestrator can try the next fetcher in its fallback chain without
 * unwinding through a catch block.
 */
final class FetchResult
{
    private function __construct(
        public readonly bool $ok,
        public readonly ?string $localPath,
        public readonly ?string $extension,
        public readonly ?string $reason,
        public readonly ?int $httpStatus,
    ) {}

    public static function success(string $localPath, string $extension): self
    {
        return new self(true, $localPath, $extension, null, null);
    }

    public static function failure(string $reason, ?int $httpStatus = null): self
    {
        return new self(false, null, null, $reason, $httpStatus);
    }
}
