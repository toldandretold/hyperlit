<?php

namespace App\Services\Licensing\Sources;

use App\Services\SourceHarvest\OaLicenseMapper;

/**
 * Per-copy licences already cached on the canonical (`canonical_source.oa_locations`, from
 * Unpaywall / CORE / OpenAlex via OaLocationResolver). Free — no request.
 *
 * Which copy speaks for the work: the one whose PDF we host (pdf_url match) if any; else the
 * publisher's copy (the version of record); else a licence only when every copy that states
 * one AGREES. Disagreeing repository copies (an author's CC BY preprint beside an
 * all-rights-reserved VoR) prove nothing about the work as a whole.
 */
final class OaLocationsSource implements LicenseSource
{
    public function name(): string
    {
        return 'oa_locations';
    }

    public function applies(object $row): bool
    {
        return ! empty($row->oa_locations);
    }

    public function lookup(object $row): LicenseFinding
    {
        $cache = is_string($row->oa_locations) ? json_decode($row->oa_locations, true) : (array) $row->oa_locations;
        $locs = array_values(array_filter((array) ($cache['locations'] ?? []), fn ($l) => is_array($l) && trim((string) ($l['license'] ?? '')) !== ''));
        if (! $locs) {
            return LicenseFinding::none();
        }

        $pdf = trim((string) ($row->pdf_url ?? ''));
        if ($pdf !== '') {
            foreach ($locs as $l) {
                if (($l['pdf_url'] ?? null) === $pdf) {
                    return LicenseFinding::said($l['license'], 'hosted copy');
                }
            }
        }
        foreach ($locs as $l) {
            if (($l['host_type'] ?? null) === 'publisher') {
                return LicenseFinding::said($l['license'], 'publisher copy');
            }
        }

        $codes = array_unique(array_map(fn ($l) => OaLicenseMapper::parse($l['license'])['license'] ?? strtolower(trim($l['license'])), $locs));

        return count($codes) === 1
            ? LicenseFinding::said($locs[0]['license'], 'all copies agree')
            : LicenseFinding::none('copies disagree: ' . implode(', ', $codes));
    }
}
