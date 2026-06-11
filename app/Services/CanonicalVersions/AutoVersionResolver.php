<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;
use Illuminate\Support\Facades\DB;

/**
 * STATUS: ACTIVE.
 *
 * auto_version_book — the system-generated version: the canonical's pdf_url
 * vacuumed and Mistral-OCR'd into nodes by `library:create-auto-versions`
 * (and, in future, by the citation pipeline's vacuum/OCR step). "Auto-raw":
 * we KNOW it's the genuine work (created FROM the canonical, match_score 1.0
 * by construction) but make no promise about formatting quality.
 *
 * Eligibility: a library row linked to this canonical with
 * conversion_method='pdf_ocr_auto_raw' that actually has content
 * (has_nodes=true — a vacuumed-but-not-OCR'd stub is not a version yet).
 */
class AutoVersionResolver extends BasePointerResolver
{
    /** Provenance constants for system-generated version stubs. */
    public const CREATOR = 'canonicalizer_v1';
    public const FOUNDATION_SOURCE = 'canonical_pdf_vacuum';
    public const CONVERSION_METHOD = 'pdf_ocr_auto_raw';

    /**
     * conversion_methods that count as a system-generated genuine version —
     * the system fetched the canonical's OWN content untampered:
     *   pdf_ocr_auto_raw  — vacuumed + OCR'd PDF
     *   jats_fulltext     — publisher's structured XML (body+refs schema-guaranteed)
     *   paste_engine_html — journal HTML the gate VERIFIED is the article
     *                       (identity + completeness), converted by the paste engine
     * NOTE: 'html_scrape_unverified' is deliberately absent — HTML that did not
     * pass the authenticity gate must never become a canonical version.
     */
    public const SYSTEM_CONVERSION_METHODS = ['pdf_ocr_auto_raw', 'jats_fulltext', 'paste_engine_html'];

    public function pointerColumn(): string
    {
        return 'auto_version_book';
    }

    public function status(): string
    {
        return self::STATUS_ACTIVE;
    }

    public function resolve(CanonicalSource $canonical): ?string
    {
        if (!$canonical->id) {
            return null;
        }

        return DB::connection('pgsql_admin')
            ->table('library')
            ->where('canonical_source_id', $canonical->id)
            ->whereIn('conversion_method', self::SYSTEM_CONVERSION_METHODS)
            ->where('has_nodes', true)
            ->where('visibility', '!=', 'deleted')
            ->orderBy('created_at')
            ->value('book');
    }
}
