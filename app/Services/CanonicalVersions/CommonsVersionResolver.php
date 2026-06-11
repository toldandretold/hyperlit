<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

/**
 * STATUS: NOT YET IMPLEMENTED — resolve() returns null unconditionally.
 *
 * commons_version_book — the version with the most positive use/support from
 * the digital commons: the copy the community has effectively ratified.
 *
 * Awaits (the deepest of the three dormant authorities):
 *   1. A commoner/acreage score on users (no users.commoner_score column yet)
 *      so endorsements can be weighted by the standing of who gives them.
 *   2. Per-version engagement data rolled up into comparable signals:
 *      highlights, hypercites, citations into the version, reading activity.
 *   3. An explicit endorsement mechanic (canonical_source.commons_endorsements
 *      exists as a counter; needs a write path + per-user dedup).
 *
 * Intended algorithm sketch:
 *   score(version) = f(weighted endorsements, engagement signals,
 *                      human_reviewed_at, canonical_metadata_score)
 *   — assign the pointer to the top-scoring version above a confidence floor,
 *   and (unlike the identity-based authorities) periodically RE-assign as
 *   community support shifts (assign(force: true) from a scheduled sweep).
 *
 * This is the Phase-"commoner score" work — see README.md §Roadmap.
 */
class CommonsVersionResolver extends BasePointerResolver
{
    public function pointerColumn(): string
    {
        return 'commons_version_book';
    }

    public function status(): string
    {
        return self::STATUS_AWAITING_DEPENDENCY;
    }

    public function awaiting(): ?string
    {
        return 'commoner score on users + per-version engagement signals + endorsement write path';
    }

    public function resolve(CanonicalSource $canonical): ?string
    {
        return null;
    }
}
