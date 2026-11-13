<?php

namespace App\Services\SourceImport;

use App\Models\PgLibrary;
use App\Services\ContentFetchService;
use App\Services\LibraryService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Makes a user-owned PRIVATE copy of a system version's content.
 *
 * Why it exists: HostingPolicy holds a system copy private when its licence does not let
 * Hyperlit redistribute it. The person who asked for that work can still keep their own
 * private copy — the same standing as uploading the PDF themselves — so a single-work import
 * that lands on a held copy hands them one of these instead of a book they cannot open.
 *
 * It is also the primitive a future "make this my version" action needs: take an existing
 * version's converted content and give the caller a book of their own, linked to the same
 * canonical. Nothing is re-fetched, re-OCR'd or re-billed (ContentFetchService::
 * adoptConvertedArtifacts replays the converted artifacts).
 */
class PersonalCopyMaker
{
    /** Never in AutoVersionResolver::SYSTEM_CONVERSION_METHODS — a personal copy is not an auto version. */
    public const CONVERSION_METHOD = 'personal_copy';

    public function __construct(private ContentFetchService $fetcher) {}

    /**
     * @param  string   $wantedBookId  the id/slug the importer asked for; suffixed if taken
     * @return string   the new book id
     */
    public function make(string $sourceBook, string $wantedBookId, ?string $creator, ?string $creatorToken): string
    {
        if (!$creator && !$creatorToken) {
            throw new \RuntimeException('a personal copy needs an owner');
        }

        $db = DB::connection('pgsql_admin');
        $source = $db->table('library')->where('book', $sourceBook)->first();
        if (!$source) {
            throw new \RuntimeException("source version {$sourceBook} not found");
        }

        $bookId = $this->freeBookId($wantedBookId);
        $now = now();

        $db->table('library')->insert([
            'book'                   => $bookId,
            'title'                  => $source->title,
            'author'                 => $source->author,
            'year'                   => $source->year,
            'journal'                => $source->journal,
            'publisher'              => $source->publisher,
            'abstract'               => $source->abstract,
            'type'                   => $source->type,
            'language'               => $source->language,
            'doi'                    => $source->doi,
            'openalex_id'            => $source->openalex_id,
            'is_oa'                  => $source->is_oa,
            'oa_status'              => $source->oa_status,
            'oa_url'                 => $source->oa_url,
            'pdf_url'                => $source->pdf_url,
            'url'                    => $source->url,
            'work_license'           => $source->work_license,
            // The licence of the copy the ladder actually fetched — never the No-AI default,
            // which is the licence for a user's OWN writing.
            'license'                => $source->license,
            'custom_license_text'    => $source->custom_license_text,
            'license_url'            => $source->license_url,
            'license_source'         => $source->license_source,
            'cited_by_count'         => $source->cited_by_count,
            'volume'                 => $source->volume,
            'issue'                  => $source->issue,
            'completeness'           => $source->completeness,
            'completeness_reason'    => $source->completeness_reason,
            'has_nodes'              => false,
            'visibility'             => 'private',
            'listed'                 => false,
            'creator'                => $creator,
            'creator_token'          => $creator ? null : $creatorToken,
            'foundation_source'      => self::CONVERSION_METHOD,
            'conversion_method'      => self::CONVERSION_METHOD,
            'is_publisher_uploaded'  => false,
            'canonical_source_id'    => $source->canonical_source_id,
            'canonical_match_score'  => 1.0,
            'canonical_match_method' => 'single_work_import',
            'canonical_matched_at'   => $now,
            'timestamp'              => round(microtime(true) * 1000),
            // imported_via=url keeps the row inside LicenseDiscovery::thirdPartyWorks: it is
            // someone else's work, so licence discovery must keep looking after it.
            'raw_json'               => json_encode([
                'imported_via' => 'url',
                'copied_from'  => $sourceBook,
            ]),
            'created_at'             => $now,
            'updated_at'             => $now,
        ]);

        try {
            $nodes = $this->fetcher->adoptConvertedArtifacts($sourceBook, $bookId);
        } catch (\Throwable $e) {
            // Never leave a contentless private row behind in the importer's library.
            $db->table('library')->where('book', $bookId)->delete();
            throw $e;
        }

        $db->table('library')->where('book', $bookId)->update([
            'has_nodes'  => $nodes > 0,
            'timestamp'  => round(microtime(true) * 1000),
            'updated_at' => now(),
        ]);

        // The card on the owner's page — same seam UrlImportController uses. Best-effort.
        if ($creator) {
            try {
                $model = PgLibrary::on('pgsql_admin')->where('book', $bookId)->first();
                if ($model) {
                    app(LibraryService::class)->syncHomepage($creator, $model);
                }
            } catch (\Throwable $e) {
                Log::warning('Personal copy: homepage sync failed (continuing)', ['book' => $bookId, 'error' => $e->getMessage()]);
            }
        }

        return $bookId;
    }

    private function freeBookId(string $wanted): string
    {
        $db = DB::connection('pgsql_admin');
        $base = preg_replace('/[^a-zA-Z0-9_-]/', '', $wanted) ?: ('book_' . now()->getTimestampMs());

        if (!$db->table('library')->where('book', $base)->exists()) {
            return $base;
        }
        for ($i = 2; $i < 50; $i++) {
            if (!$db->table('library')->where('book', "{$base}-{$i}")->exists()) {
                return "{$base}-{$i}";
            }
        }

        return $base . '-' . substr(md5((string) microtime(true)), 0, 6);
    }
}
