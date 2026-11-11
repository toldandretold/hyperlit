<?php

namespace App\Services\Licensing\Sources;

/** Europe PMC `search?resultType=core` → `license` (biomedical literature, PMC OA subset). */
final class EuropePmcSource implements LicenseSource
{
    public function name(): string
    {
        return 'europepmc';
    }

    public function applies(object $row): bool
    {
        return RowIds::doi($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        try {
            $r = PoliteHttp::get('https://www.ebi.ac.uk/europepmc/webservices/rest/search', [
                'query' => 'DOI:"' . RowIds::doi($row) . '"',
                'resultType' => 'core',
                'format' => 'json',
                'pageSize' => 1,
            ], 0.2);
        } catch (\Throwable $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        if (PoliteHttp::isInfraFailure($r)) {
            return LicenseFinding::failed('HTTP ' . $r->status());
        }
        if (! $r->successful()) {
            return LicenseFinding::none('HTTP ' . $r->status());
        }
        $hit = $r->json('resultList.result.0');
        if (! is_array($hit) || strtolower((string) ($hit['doi'] ?? '')) !== RowIds::doi($row)) {
            return LicenseFinding::none('not indexed');
        }

        return LicenseFinding::said(is_string($hit['license'] ?? null) ? $hit['license'] : null);
    }
}
