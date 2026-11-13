<?php

namespace App\Services\SourceImport\Identifier;

/**
 * An OpenAlex work id ("W2126853606") — what `search_sources` hands back for a work
 * that has no DOI, and the key OpenAlex itself resolves fastest.
 */
final class OpenAlexId implements Identifier
{
    private readonly string $value;

    public function __construct(string $value)
    {
        // Stored upper-case everywhere (WorkNormaliser keeps OpenAlex's own casing).
        $this->value = strtoupper($value);
    }

    public function kind(): string { return 'openalex'; }
    public function value(): string { return $this->value; }
    public function url(): string { return 'https://openalex.org/' . $this->value; }
}
