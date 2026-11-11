<?php

namespace App\Services\Licensing\Sources;

use App\Services\SourceHarvest\OaLicenseMapper;

/**
 * Books (Open Library rows, no DOI): Open Library edition → its Internet Archive scan
 * (`ocaid`) → `archive.org/metadata/{ocaid}` → `licenseurl`, or IA's own copyright assessment
 * (`possible-copyright-status = NOT_IN_COPYRIGHT`, i.e. public domain in the US).
 *
 * An Open Library WORK spans editions — the 1867 Capital is public domain, a 1990 translation
 * is not — so a work-level answer is given only when EVERY scanned edition we check agrees.
 * More than MAX_EDITIONS scans, or any disagreement, and we say nothing.
 */
final class InternetArchiveSource implements LicenseSource
{
    private const MAX_EDITIONS = 5;

    public function name(): string
    {
        return 'internet_archive';
    }

    public function applies(object $row): bool
    {
        return RowIds::openLibraryKey($row) !== null;
    }

    public function lookup(object $row): LicenseFinding
    {
        $key = RowIds::openLibraryKey($row);
        try {
            $ocaids = str_starts_with($key, '/books/') ? $this->editionOcaids($key) : $this->workOcaids($key);
        } catch (\RuntimeException $e) {
            return LicenseFinding::failed($e->getMessage());
        }
        if ($ocaids === []) {
            return LicenseFinding::none('no scanned edition');
        }
        if (count($ocaids) > self::MAX_EDITIONS) {
            return LicenseFinding::none(count($ocaids) . ' scanned editions — too many to vouch for the work');
        }

        $said = [];
        foreach ($ocaids as $ocaid) {
            try {
                $r = PoliteHttp::get('https://archive.org/metadata/' . rawurlencode($ocaid), [], 0.5);
            } catch (\Throwable $e) {
                return LicenseFinding::failed($e->getMessage());
            }
            if (PoliteHttp::isInfraFailure($r)) {
                return LicenseFinding::failed('HTTP ' . $r->status());
            }
            $said[$ocaid] = self::fromMetadata((array) $r->json('metadata', []));
        }

        $codes = array_unique(array_map(fn ($raw) => $raw === null ? '∅' : (OaLicenseMapper::parse($raw)['license'] ?? $raw), $said));
        if (count($codes) !== 1 || reset($codes) === '∅') {
            return LicenseFinding::none('editions disagree or state nothing: ' . implode(', ', $codes));
        }

        return LicenseFinding::said(reset($said), count($said) . ' edition(s): ' . implode(', ', array_keys($said)));
    }

    /** The licence an IA item states: its licenseurl, else its public-domain assessment. */
    public static function fromMetadata(array $m): ?string
    {
        $url = $m['licenseurl'] ?? null;
        if (is_string($url) && trim($url) !== '') {
            return trim($url);
        }
        $status = strtoupper(trim((string) (is_array($m['possible-copyright-status'] ?? null) ? ($m['possible-copyright-status'][0] ?? '') : ($m['possible-copyright-status'] ?? ''))));

        return $status === 'NOT_IN_COPYRIGHT' ? 'Public domain (Internet Archive: NOT_IN_COPYRIGHT)' : null;
    }

    /** @return list<string> */
    private function workOcaids(string $workKey): array
    {
        $r = PoliteHttp::get("https://openlibrary.org{$workKey}/editions.json", ['limit' => 50], 0.5);
        if (PoliteHttp::isInfraFailure($r)) {
            throw new \RuntimeException('Open Library HTTP ' . $r->status());
        }

        return array_values(array_unique(array_filter(array_map(
            fn ($e) => is_array($e) && is_string($e['ocaid'] ?? null) ? $e['ocaid'] : null,
            (array) $r->json('entries', []),
        ))));
    }

    /** @return list<string> */
    private function editionOcaids(string $editionKey): array
    {
        $r = PoliteHttp::get("https://openlibrary.org{$editionKey}.json", [], 0.5);
        if (PoliteHttp::isInfraFailure($r)) {
            throw new \RuntimeException('Open Library HTTP ' . $r->status());
        }
        $o = $r->json('ocaid');

        return is_string($o) && $o !== '' ? [$o] : [];
    }
}
