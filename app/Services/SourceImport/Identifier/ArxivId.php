<?php

namespace App\Services\SourceImport\Identifier;

final class ArxivId implements Identifier
{
    public function __construct(private readonly string $value) {}

    public function kind(): string { return 'arxiv'; }
    public function value(): string { return $this->value; }
    public function url(): string { return 'https://arxiv.org/abs/' . $this->value; }

    /**
     * arXiv mints a DOI for every paper under the 10.48550/arXiv.<id> prefix —
     * useful for OpenAlex lookups, which key on DOI not arXiv ID.
     */
    public function asDoi(): Doi
    {
        return new Doi('10.48550/arXiv.' . $this->value);
    }
}
