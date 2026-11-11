<?php

namespace App\Services\Licensing\Sources;

use App\Services\SemanticScholarService;

/** Semantic Scholar `openAccessPdf.license` — the licence of the open copy S2 links. */
final class SemanticScholarSource implements LicenseSource
{
    public function name(): string
    {
        return 'semantic_scholar';
    }

    public function applies(object $row): bool
    {
        return RowIds::doi($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        $res = app(SemanticScholarService::class)->openAccessLicenseByDoi(RowIds::doi($row));
        if ($res['infra']) {
            return LicenseFinding::failed($res['note'] ?? 'request failed');
        }

        return LicenseFinding::said($res['license'], $res['note']);
    }
}
