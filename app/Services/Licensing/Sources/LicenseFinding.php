<?php

namespace App\Services\Licensing\Sources;

/**
 * What one source said. `raw` is the licence exactly as the source states it (URL, slug,
 * text) — NULL when the source answered and had none. `infra` marks a failure to ASK (timeout,
 * 5xx, 429): that is not evidence of anything, is not recorded as "silent", and counts
 * towards the per-source breaker.
 */
final class LicenseFinding
{
    public function __construct(
        public readonly ?string $raw,
        public readonly bool $infra = false,
        public readonly ?string $note = null,
    ) {}

    public static function none(?string $note = null): self
    {
        return new self(null, false, $note);
    }

    public static function failed(string $note): self
    {
        return new self(null, true, $note);
    }

    public static function said(?string $raw, ?string $note = null): self
    {
        $raw = $raw !== null ? trim($raw) : null;

        return new self($raw === '' ? null : $raw, false, $note);
    }
}
