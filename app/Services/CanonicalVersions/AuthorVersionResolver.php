<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

/**
 * STATUS: NOT YET IMPLEMENTED — resolve() returns null unconditionally.
 *
 * author_version_book — the version uploaded/approved by the VERIFIED AUTHOR
 * of the work.
 *
 * Awaits: ORCID OAuth on user profiles (and possibly other identity methods).
 *
 * Intended algorithm (see docs/canonical-sources.md §"Authorships & identity
 * verification" — the data side is already in place):
 *   1. User connects their ORCID to their Hyperlit profile via ORCID OAuth.
 *   2. When that user uploads a library row matched to a canonical, cross-check
 *      canonical_source.authorships[].orcid (GIN-indexed JSONB, populated for
 *      OpenAlex-created canonicals) against the uploader's verified ORCID.
 *   3. On a hit: set library.is_publisher_uploaded = true and assign this
 *      pointer. UI badge: "Verified author upload."
 *
 * Until then this resolver exists so the precedence order, registry, and tests
 * already account for the authority — implementing it must not require touching
 * any consumer.
 */
class AuthorVersionResolver extends BasePointerResolver
{
    public function pointerColumn(): string
    {
        return 'author_version_book';
    }

    public function status(): string
    {
        return self::STATUS_AWAITING_DEPENDENCY;
    }

    public function awaiting(): ?string
    {
        return 'ORCID OAuth on user profiles; cross-check against canonical_source.authorships[].orcid';
    }

    public function resolve(CanonicalSource $canonical): ?string
    {
        return null;
    }
}
