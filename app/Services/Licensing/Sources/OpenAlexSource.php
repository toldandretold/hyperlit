<?php

namespace App\Services\Licensing\Sources;

use App\Services\OpenAlex\WorksApi;

/**
 * A FRESH OpenAlex record (upstream data improves; the row's work_license is a snapshot from
 * whenever it was minted). WorkNormaliser already falls back primary → best_oa → any location.
 */
final class OpenAlexSource implements LicenseSource
{
    public function name(): string
    {
        return 'openalex';
    }

    public function applies(object $row): bool
    {
        return RowIds::openalexId($row) !== null || RowIds::doi($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        try {
            $api = app(WorksApi::class);
            $id = RowIds::openalexId($row);
            $work = $id ? $api->fetchByOpenAlexId($id) : $api->fetchByDoi(RowIds::doi($row));
        } catch (\Throwable $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        if (! $work) {
            return LicenseFinding::none('not found');
        }

        return LicenseFinding::said(is_string($work['work_license'] ?? null) ? $work['work_license'] : null);
    }
}
