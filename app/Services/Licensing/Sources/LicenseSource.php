<?php

namespace App\Services\Licensing\Sources;

/**
 * One place licence evidence can come from (a local artefact or an upstream API). Used by
 * App\Services\Licensing\LicenseDiscovery, which walks the sources cheapest-first.
 *
 * The row is the discovery query's projection of library ⋈ canonical_source: book, doi,
 * openalex_id, open_library_key, url, oa_url, pdf_url, has_nodes, oa_locations (jsonb text).
 */
interface LicenseSource
{
    /** Stable short name — stored in license_evidence.source and library.license_source. */
    public function name(): string;

    /** Whether this source can say anything about the row (it has the identifier we need). */
    public function applies(object $row): bool;

    public function lookup(object $row): LicenseFinding;
}
