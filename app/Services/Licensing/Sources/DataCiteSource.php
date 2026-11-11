<?php

namespace App\Services\Licensing\Sources;

use App\Services\SourceHarvest\OaLicenseMapper;

/**
 * DataCite `dois/{doi}` → `rightsList[]`, for the DOIs Crossref doesn't register: Zenodo,
 * Figshare, institutional repositories, arXiv's 10.48550 DOIs. Prefers the entry that names a
 * real licence over the generic `info:eu-repo/semantics/openAccess` access statement.
 */
final class DataCiteSource implements LicenseSource
{
    public function name(): string
    {
        return 'datacite';
    }

    public function applies(object $row): bool
    {
        return RowIds::doi($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        try {
            $r = PoliteHttp::get('https://api.datacite.org/dois/' . rawurlencode(RowIds::doi($row)), [], 0.1);
        } catch (\Throwable $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        if (PoliteHttp::isInfraFailure($r)) {
            return LicenseFinding::failed('HTTP ' . $r->status());
        }
        if (! $r->successful()) {
            return LicenseFinding::none('HTTP ' . $r->status());
        }

        return LicenseFinding::said(self::pick((array) $r->json('data.attributes.rightsList', [])));
    }

    public static function pick(array $rightsList): ?string
    {
        $fallback = null;
        foreach ($rightsList as $r) {
            if (! is_array($r)) {
                continue;
            }
            foreach ([$r['rightsUri'] ?? null, $r['rightsIdentifier'] ?? null, $r['rights'] ?? null] as $v) {
                if (! is_string($v) || trim($v) === '') {
                    continue;
                }
                $code = OaLicenseMapper::parse($v)['license'] ?? null;
                if ($code !== null && $code !== 'Open-Unspecified') {
                    return $v;
                }
                $fallback ??= $v;
            }
        }

        return $fallback;
    }
}
