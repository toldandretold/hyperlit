<?php

namespace App\Services\SourceHarvest;

/**
 * Maps an OpenAlex / Unpaywall license slug (the license of the copy we actually
 * imported) onto the app's existing `library.license` vocabulary, so a harvested
 * source displays its REAL license through the same UI a user's own book does —
 * not the site default (CC-BY-SA-4.0-NO-AI) it would otherwise inherit.
 *
 * The returned `license` code is one the frontend's LICENSE_INFO map renders
 * (resources/js/components/sourceContainer/licenseInfo.ts); anything unrecognised
 * falls back to `custom` + `custom_license_text` so the raw slug is still shown.
 *
 * Plain-English by design: bronze / closed / no-license => "All-Rights-Reserved"
 * ("free to read only, no reuse"), which is what a bronze OA copy actually is.
 */
class OaLicenseMapper
{
    /** Exact slug → library.license code. Slugs are lower-cased + version-stripped first. */
    private const MAP = [
        'cc-by'         => 'CC-BY-4.0',
        'cc-by-sa'      => 'CC-BY-SA-4.0',
        'cc-by-nc'      => 'CC-BY-NC-4.0',
        'cc-by-nd'      => 'CC-BY-ND-4.0',
        'cc-by-nc-sa'   => 'CC-BY-NC-SA-4.0',
        'cc-by-nc-nd'   => 'CC-BY-NC-ND-4.0',
        'cc0'           => 'CC0',
        'cc-zero'       => 'CC0',
        'pd'            => 'CC0',
        'public-domain' => 'CC0',
        'publicdomain'  => 'CC0',
    ];

    /**
     * @return array{license: string, custom_license_text: ?string}
     */
    public static function toLibraryLicense(?string $slug, ?string $oaStatus = null): array
    {
        $s = self::normalise($slug);

        if ($s === '') {
            // No license on the copy. Bronze/closed (or unknown status) = free to
            // read at most, all rights reserved. A genuinely-open status with a
            // missing license slug is "open, unspecified".
            $status = strtolower((string) $oaStatus);
            $open = in_array($status, ['gold', 'green', 'hybrid', 'diamond'], true);
            return ['license' => $open ? 'Open-Unspecified' : 'All-Rights-Reserved', 'custom_license_text' => null];
        }

        if (isset(self::MAP[$s])) {
            return ['license' => self::MAP[$s], 'custom_license_text' => null];
        }

        if (str_contains($s, 'publisher-specific')) {
            return ['license' => 'Publisher-Open', 'custom_license_text' => null];
        }
        if ($s === 'other-oa' || $s === 'unspecified-oa' || $s === 'other') {
            return ['license' => 'Open-Unspecified', 'custom_license_text' => null];
        }

        // Unrecognised but present — surface the raw slug via the custom path so
        // the user still sees SOMETHING truthful rather than a wrong default.
        return ['license' => 'custom', 'custom_license_text' => strtoupper(str_replace('-', ' ', $s))];
    }

    /** Lower-case, trim, strip any trailing "-4.0"/"/4.0" version suffix OpenAlex sometimes appends. */
    private static function normalise(?string $slug): string
    {
        $s = strtolower(trim((string) $slug));
        if ($s === '') {
            return '';
        }
        // "cc-by-4.0" / "cc-by/4.0" → "cc-by"
        $s = preg_replace('#[-/](\d+(\.\d+)?)$#', '', $s);
        return (string) $s;
    }
}
