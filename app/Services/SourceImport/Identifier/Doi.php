<?php

namespace App\Services\SourceImport\Identifier;

final class Doi implements Identifier
{
    public function __construct(private readonly string $value) {}

    public function kind(): string { return 'doi'; }
    public function value(): string { return $this->value; }
    public function url(): string { return 'https://doi.org/' . $this->value; }
}
