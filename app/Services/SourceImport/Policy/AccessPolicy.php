<?php

namespace App\Services\SourceImport\Policy;

use App\Services\SourceImport\Metadata\SourceMetadata;

/**
 * Decides what kind of import is allowed for a given work, based on metadata
 * (OA status, license) only. Pure: no I/O, no side effects. Output is an
 * ImportPlan the orchestrator acts on.
 *
 * v1 branches: open / closed. Embargo / CC-variants / publisher-verified-only
 * are future expansions of the same decision surface.
 */
class AccessPolicy
{
    public function decide(SourceMetadata $metadata): ImportPlan
    {
        if ($metadata->isOpenAccess()) {
            return new ImportPlan(
                createCanonicalVersion: true,
                allowPublish: true,
                chargeUser: false,
                access: 'open',
                reason: 'open_access',
            );
        }

        // Closed: importer can keep their own private copy if they have the file,
        // but we don't build a canonical public version and we don't allow them
        // to publish theirs. Legal safety, not a UX paywall.
        return new ImportPlan(
            createCanonicalVersion: false,
            allowPublish: false,
            chargeUser: true,
            access: 'closed',
            reason: 'closed_access',
        );
    }
}
