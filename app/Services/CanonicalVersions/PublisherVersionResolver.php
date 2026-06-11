<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

/**
 * STATUS: NOT YET IMPLEMENTED — resolve() returns null unconditionally.
 *
 * publisher_version_book — the version uploaded/approved by the VERIFIED
 * PUBLISHER (rights-holder) of the work.
 *
 * Awaits: a publisher account-verification flow (admin UI at minimum). The
 * supporting columns already exist: canonical_source.verified_by_publisher
 * (the publisher has claimed the canonical) and library.is_publisher_uploaded
 * (this specific row came from the verified rights-holder).
 *
 * Intended algorithm:
 *   1. A publisher account is verified (manual admin curation first; a
 *      self-serve domain/ISBN-based flow later).
 *   2. That account uploads or endorses a version of a canonical it has
 *      claimed (verified_by_publisher = true).
 *   3. Set library.is_publisher_uploaded = true and assign this pointer.
 *
 * Until then: admin-set only, by writing the column directly.
 */
class PublisherVersionResolver extends BasePointerResolver
{
    public function pointerColumn(): string
    {
        return 'publisher_version_book';
    }

    public function status(): string
    {
        return self::STATUS_AWAITING_DEPENDENCY;
    }

    public function awaiting(): ?string
    {
        return 'publisher account verification flow (verified_by_publisher / is_publisher_uploaded are admin-set only)';
    }

    public function resolve(CanonicalSource $canonical): ?string
    {
        return null;
    }
}
