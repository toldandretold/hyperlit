<?php

namespace App\Services\Licensing\Sources;

use App\Services\ContentFetchService;
use App\Services\Licensing\HtmlLicenseExtractor;

/**
 * Opt-in (`--fetch-pages`): fetch the work's landing page NOW and read its declared licence.
 * Plain HTTP only (no headless browser — a licence sweep must not spend the browser budget),
 * through ContentFetchService::acquirePageHtml so UrlGuard and the per-host proxy policy apply.
 * Hosted texts only: for a metadata stub the licence matters far less than the request costs.
 */
final class LivePageSource implements LicenseSource
{
    public function name(): string
    {
        return 'live_page';
    }

    public function applies(object $row): bool
    {
        return (bool) ($row->has_nodes ?? false) && self::url($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        try {
            $res = app(ContentFetchService::class)->acquirePageHtml(self::url($row), false);
        } catch (\Throwable $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        $html = $res['html'] ?? null;
        if (! is_string($html) || $html === '') {
            return LicenseFinding::none($res['reason'] ?? 'no page');
        }

        return LicenseFinding::said(HtmlLicenseExtractor::extract($html), $res['final_url'] ?? null);
    }

    private static function url(object $row): ?string
    {
        foreach ([$row->oa_url ?? null, $row->url ?? null] as $u) {
            if (is_string($u) && preg_match('#^https?://#i', $u) && ! preg_match('#\.pdf($|\?)#i', $u)) {
                return $u;
            }
        }
        $doi = RowIds::doi($row);

        return $doi ? "https://doi.org/{$doi}" : null;
    }
}
