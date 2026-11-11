<?php

namespace App\Services\Licensing\Sources;

/**
 * Crossref `works/{doi}` → `message.license[]`: the publisher's own deposit, and the one
 * source that reliably states the CC VERSION (OpenAlex/Unpaywall only give `cc-by`).
 *
 * Only `vor` (version of record) and `unspecified` entries speak for the published work.
 * `am` licences are for the accepted manuscript (Elsevier deposits a CC BY-NC-ND AAM licence
 * on articles whose VoR is all rights reserved) and `tdm` licences are text-mining permissions
 * — labelling the work with either would be a false claim. An entry whose start date is still
 * in the future (an embargo) isn't in force yet; of those in force, the latest start wins.
 */
final class CrossrefSource implements LicenseSource
{
    public function name(): string
    {
        return 'crossref';
    }

    public function applies(object $row): bool
    {
        return RowIds::doi($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        // The VoR licence describes the PUBLISHED version. When the copy we host is an
        // accepted/submitted manuscript, it says nothing about the text a reader sees here.
        $hosted = RowIds::hostedVersion($row);
        if ($hosted !== null && $hosted !== 'publishedVersion') {
            return LicenseFinding::none("we host the {$hosted}; Crossref licenses the version of record");
        }

        try {
            $r = PoliteHttp::get('https://api.crossref.org/works/' . rawurlencode(RowIds::doi($row)), ['mailto' => 'sam@hyperlit.io'], 0.1);
        } catch (\Throwable $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        if (PoliteHttp::isInfraFailure($r)) {
            return LicenseFinding::failed('HTTP ' . $r->status());
        }
        if (! $r->successful()) {
            return LicenseFinding::none('HTTP ' . $r->status()); // 404: not a Crossref DOI (DataCite's, or a bad DOI)
        }

        return LicenseFinding::said(self::pick((array) $r->json('message.license', [])));
    }

    /** The in-force VoR/unspecified licence URL from a Crossref `license` array, or null. */
    public static function pick(array $licenses, ?int $now = null): ?string
    {
        $now ??= time();
        $best = null;
        $bestStart = PHP_INT_MIN;
        foreach ($licenses as $l) {
            if (! is_array($l) || ! in_array($l['content-version'] ?? 'unspecified', ['vor', 'unspecified'], true)) {
                continue;
            }
            $start = self::startOf($l);
            if ($start !== null && $start > $now) {
                continue;
            }
            $start ??= PHP_INT_MIN + 1;
            if (is_string($l['URL'] ?? null) && $start >= $bestStart) {
                $best = $l['URL'];
                $bestStart = $start;
            }
        }

        return $best;
    }

    private static function startOf(array $l): ?int
    {
        $parts = $l['start']['date-parts'][0] ?? null;
        if (! is_array($parts) || ! isset($parts[0])) {
            return null;
        }

        return gmmktime(0, 0, 0, (int) ($parts[1] ?? 1), (int) ($parts[2] ?? 1), (int) $parts[0]);
    }
}
