<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

/**
 * One implementation per privileged-version pointer on canonical_source
 * (author_version_book / publisher_version_book / commons_version_book /
 * auto_version_book). Each resolver owns the eligibility rule for ITS pointer:
 * "given this canonical, which library row (if any) deserves the column."
 *
 * Resolvers must be constructor-dependency-free so the registry (and pure
 * unit tests) can instantiate them directly.
 *
 * See README.md in this directory for the system overview, and
 * docs/canonical-sources.md for the data model.
 */
interface VersionPointerResolver
{
    public const STATUS_ACTIVE = 'active';
    public const STATUS_AWAITING_DEPENDENCY = 'awaiting_dependency';

    /** The canonical_source column this resolver owns, e.g. 'auto_version_book'. */
    public function pointerColumn(): string;

    /** STATUS_ACTIVE or STATUS_AWAITING_DEPENDENCY. */
    public function status(): string;

    /** What an awaiting resolver is blocked on (null when active). */
    public function awaiting(): ?string;

    /**
     * Pure lookup: the library.book id that currently deserves this pointer,
     * or null when no eligible version exists. Never writes.
     */
    public function resolve(CanonicalSource $canonical): ?string;

    /**
     * Resolve and persist. An already-set pointer is never overwritten unless
     * $force — manual/admin assignments must survive automated sweeps.
     * Returns the pointer value after the call (existing, newly set, or null).
     */
    public function assign(CanonicalSource $canonical, bool $force = false): ?string;
}
