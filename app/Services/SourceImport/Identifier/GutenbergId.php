<?php

namespace App\Services\SourceImport\Identifier;

final class GutenbergId implements Identifier
{
    public function __construct(private readonly string $value) {}

    public function kind(): string { return 'gutenberg'; }
    public function value(): string { return $this->value; }
    public function url(): string { return 'https://www.gutenberg.org/ebooks/' . $this->value; }
}
