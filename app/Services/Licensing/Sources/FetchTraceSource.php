<?php

namespace App\Services\Licensing\Sources;

use Illuminate\Support\Facades\File;

/**
 * The licence of the copy we ACTUALLY imported, recorded by ContentFetchService into
 * markdown/{book}/fetch_trace.json at harvest time (`won_license`). The strongest evidence
 * there is for a hosted text — it is about these bytes, not the work in the abstract.
 */
final class FetchTraceSource implements LicenseSource
{
    public function name(): string
    {
        return 'fetch_trace';
    }

    public function applies(object $row): bool
    {
        return File::exists(self::path($row->book));
    }

    public function lookup(object $row): LicenseFinding
    {
        $trace = json_decode((string) File::get(self::path($row->book)), true) ?: [];

        return LicenseFinding::said(is_string($trace['won_license'] ?? null) ? $trace['won_license'] : null);
    }

    private static function path(string $book): string
    {
        return resource_path("markdown/{$book}/fetch_trace.json");
    }
}
