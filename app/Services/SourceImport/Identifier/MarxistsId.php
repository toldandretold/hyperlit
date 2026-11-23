<?php

namespace App\Services\SourceImport\Identifier;

/**
 * A text on the Marxists Internet Archive, named by its page path
 * ("archive/marx/works/1867-c1/index.htm"). For a multi-page work that is the
 * work's CONTENTS page — the one address that stands for the whole work, and
 * the link every imported copy credits (docs/marxists-import.md).
 */
final class MarxistsId implements Identifier
{
    public const HOST = 'www.marxists.org';

    public function __construct(private readonly string $path) {}

    public function kind(): string { return 'marxists'; }
    public function value(): string { return $this->path; }
    public function url(): string { return 'https://' . self::HOST . '/' . $this->path; }
}
