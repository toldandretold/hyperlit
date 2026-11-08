<?php

namespace App\Services\Licensing;

use App\Models\CanonicalSource;
use App\Services\SourceHarvest\OaLicenseMapper;
use Illuminate\Support\Facades\DB;

/**
 * Decides the `library.license` of a work Hyperlit did NOT author: a harvested version, a URL
 * import, an OpenAlex stub. The ONE place that turns upstream licence evidence into the
 * columns readers see (license / custom_license_text / license_url).
 *
 * Why it exists: only AutoVersionCreator used to map `work_license` → `license`. Every other
 * minting path (SystemVersionMinter for the journal HTML lane and ar5iv, UrlImportController
 * incl. Project Gutenberg, LibraryStubWriter) copied the raw string into `work_license` and
 * left `license` at the column default — CC-BY-SA-4.0-NO-AI, Hyperlit's OWN licence for a
 * user's original writing. So an NC-ND article or a public-domain Marx translation was shown
 * to readers as copyleft-No-AI.
 *
 * Evidence ladder (first RECOGNISED licence wins; an unrecognised string only wins if nothing
 * later is recognised either):
 *   1. the licence of the copy we actually downloaded (ContentFetchService won_license)
 *   2. the work's own licence (canonical / OpenAlex work_license)
 *   3. the journal's DOAJ licence — diamond journals license every article alike
 *   4. OA status: open → Open-Unspecified, otherwise All-Rights-Reserved
 */
class WorkLicenseResolver
{
    /**
     * @param  list<?string>  $candidates  raw licence strings, highest-priority first
     * @return array{license: string, custom_license_text: ?string, license_url: ?string}
     */
    public static function resolve(array $candidates, ?string $oaStatus = null): array
    {
        $firstUnrecognised = null;

        foreach ($candidates as $raw) {
            $raw = trim((string) $raw);
            if ($raw === '') {
                continue;
            }
            if ($hit = OaLicenseMapper::parse($raw)) {
                return $hit;
            }
            $firstUnrecognised ??= $raw;
        }

        if ($firstUnrecognised !== null) {
            return OaLicenseMapper::toLibraryLicense($firstUnrecognised, $oaStatus);
        }

        return OaLicenseMapper::fromStatus($oaStatus);
    }

    /**
     * @return array{license: string, custom_license_text: ?string, license_url: ?string}
     */
    public static function forCanonical(CanonicalSource $canonical, ?string $wonLicense = null): array
    {
        return self::resolve(
            [$wonLicense, $canonical->work_license, self::journalLicense($canonical->journal_source_id ?? null)],
            $canonical->oa_status,
        );
    }

    /** DOAJ licence of the canonical's journal, when the journal is in the registry. */
    public static function journalLicense(?string $journalSourceId): ?string
    {
        if (! $journalSourceId) {
            return null;
        }

        try {
            $v = DB::connection('pgsql_admin')->table('journal_sources')
                ->where('id', $journalSourceId)
                ->value('doaj_license');
        } catch (\Throwable) {
            return null;
        }

        return self::usableJournalLicense(is_string($v) ? $v : null);
    }

    /**
     * A journal-level licence is evidence about an article only when it names ONE licence we
     * recognise. "CC BY, CC BY-SA" says nothing about which one THIS article carries, and an
     * unrecognised journal string must not become the article's custom licence text.
     */
    public static function usableJournalLicense(?string $raw): ?string
    {
        return ($raw !== null && OaLicenseMapper::parse($raw) !== null) ? $raw : null;
    }
}
