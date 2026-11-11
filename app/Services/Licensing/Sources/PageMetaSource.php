<?php

namespace App\Services\Licensing\Sources;

use App\Services\Licensing\HtmlLicenseExtractor;
use Illuminate\Support\Facades\File;

/**
 * The licence the publisher's page declared, read from the copy of that page we saved at
 * harvest/import time (markdown/{book}/fetched_page.html, original.html). Free — no request.
 */
final class PageMetaSource implements LicenseSource
{
    private const FILES = ['fetched_page.html', 'original.html'];

    public function name(): string
    {
        return 'page_meta';
    }

    public function applies(object $row): bool
    {
        return self::files($row->book) !== [];
    }

    public function lookup(object $row): LicenseFinding
    {
        foreach (self::files($row->book) as $path) {
            $html = (string) File::get($path);
            if ($raw = HtmlLicenseExtractor::extract(mb_substr($html, 0, 3_000_000))) {
                return LicenseFinding::said($raw, basename($path));
            }
        }

        return LicenseFinding::none();
    }

    /** @return list<string> */
    private static function files(string $book): array
    {
        return array_values(array_filter(
            array_map(fn ($f) => resource_path("markdown/{$book}/{$f}"), self::FILES),
            fn ($p) => File::exists($p),
        ));
    }
}
