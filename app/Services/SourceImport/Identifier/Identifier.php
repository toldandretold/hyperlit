<?php

namespace App\Services\SourceImport\Identifier;

/**
 * A normalised pointer to a citable work. Subtypes know how to compare and how to
 * render themselves; consumers should branch on instanceof.
 */
interface Identifier
{
    /** Short symbolic name: 'doi', 'arxiv'. Stable, used in logs and persisted state. */
    public function kind(): string;

    /** The bare identifier value (no scheme, no URL prefix). */
    public function value(): string;

    /** Canonical URL representation, for display and external linking. */
    public function url(): string;
}
