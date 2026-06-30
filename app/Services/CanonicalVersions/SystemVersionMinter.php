<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Mints SYSTEM-owned version stubs for a canonical work — the rows that become
 * `auto_version_book`. A system version is the canonical's OWN content fetched
 * untampered (PDF vacuum+OCR, ar5iv/LaTeXML, JATS, …); it is owned by
 * `canonicalizer_v1`, NOT by any user, so user edits/deletes never touch it.
 *
 * The provenance pair (conversion_method, foundation_source) identifies the
 * source lane:
 *   - PDF auto-version:  (pdf_ocr_auto_raw, canonical_pdf_vacuum)
 *   - ar5iv version:     (ar5iv_html,       ar5iv_latexml)
 *
 * Extracted from CreateAutoVersionsCommand::createStubLibraryRow so the ar5iv
 * minting command reuses the exact same row shape (same RLS-bypassing pgsql_admin
 * write, same canonical back-link, match_score 1.0 by construction).
 */
class SystemVersionMinter
{
    /**
     * Create a system-owned library row linked to the canonical. Returns a fresh
     * UUID book id — its own resources/markdown/<uuid>/ dir, never the user's book.
     * Content lands later (vacuum+OCR or the conversion job); has_nodes starts false.
     */
    public function mintSystemRow(
        CanonicalSource $canonical,
        string $conversionMethod,
        string $foundationSource
    ): string {
        $bookId = (string) Str::uuid();
        $now = now();

        DB::connection('pgsql_admin')->table('library')->insert([
            'book'                   => $bookId,
            'title'                  => $canonical->title,
            'author'                 => $canonical->author,
            'year'                   => $canonical->year,
            'journal'                => $canonical->journal,
            'publisher'              => $canonical->publisher,
            'abstract'               => $canonical->abstract,
            'type'                   => $canonical->type,
            'language'               => $canonical->language,
            'doi'                    => $canonical->doi,
            'openalex_id'            => $canonical->openalex_id,
            'is_oa'                  => $canonical->is_oa,
            'oa_status'              => $canonical->oa_status,
            'oa_url'                 => $canonical->oa_url,
            'pdf_url'                => $canonical->pdf_url,
            'work_license'           => $canonical->work_license,
            'cited_by_count'         => $canonical->cited_by_count,
            'has_nodes'              => false,
            'visibility'             => 'public',
            'listed'                 => false,
            'creator'                => AutoVersionResolver::CREATOR,
            'creator_token'          => null,
            'foundation_source'      => $foundationSource,
            'conversion_method'      => $conversionMethod,
            'is_publisher_uploaded'  => false,
            'canonical_source_id'    => $canonical->id,
            'canonical_match_score'  => 1.0,
            'canonical_match_method' => 'auto_version_creation',
            'canonical_matched_at'   => $now,
            'canonical_matched_by'   => AutoVersionResolver::CREATOR,
            'raw_json'               => json_encode([
                'auto_version' => true,
                'source'       => $foundationSource,
                'canonical_id' => $canonical->id,
            ]),
            'created_at'             => $now,
            'updated_at'             => $now,
        ]);

        return $bookId;
    }

    /**
     * Find an existing system stub for this canonical + source lane, if a prior run
     * created one (possibly before it finished converting). Keyed on
     * canonical_source_id + foundation_source so the PDF and ar5iv lanes don't collide.
     */
    public function findExistingSystemRow(CanonicalSource $canonical, string $foundationSource): ?object
    {
        return DB::connection('pgsql_admin')
            ->table('library')
            ->where('canonical_source_id', $canonical->id)
            ->where('foundation_source', $foundationSource)
            ->where('visibility', '!=', 'deleted')
            ->select('book', 'has_nodes', 'pdf_url_status')
            ->first();
    }
}
