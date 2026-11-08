<?php

namespace App\Support;

/**
 * The ONE vocabulary of `library.license` codes.
 *
 * Every writer validates against this list (DbLibraryController upsert/bulkCreate, the MCP
 * licence tool, OaLicenseMapper's output), and the front-end label map
 * (`resources/js/components/sourceContainer/licenses.generated.ts`) is GENERATED from it by
 * `php artisan licenses:export-js` — a parity test fails if the two drift. Before this the
 * vocabulary lived only in a TS map, the server accepted any string, and any code the map
 * did not know (`all-rights-reserved`, `cc-by-sa-4.0`, `MIT`) was shown to readers as the
 * site's own CC BY-SA No-AI licence — a third party's all-rights-reserved book displayed as
 * copyleft.
 *
 * Codes are stable identifiers that already live in ~360k rows; never rename one.
 */
final class Licenses
{
    /** The site default for a user's OWN original work. Never a default for third-party works. */
    public const DEFAULT_USER = 'CC-BY-SA-4.0-NO-AI';

    /** A work whose licence we genuinely do not know (e.g. a user-imported third-party file). */
    public const UNKNOWN = 'Unknown';

    public const CUSTOM = 'custom';

    /** CC term sets, in the order the picker lists them. */
    private const CC_TERMS = [
        'BY'       => 'by',
        'BY-SA'    => 'by-sa',
        'BY-NC'    => 'by-nc',
        'BY-ND'    => 'by-nd',
        'BY-NC-SA' => 'by-nc-sa',
        'BY-NC-ND' => 'by-nc-nd',
    ];

    /** CC versions a work can carry. 4.0 first: it is what the picker offers. */
    public const CC_VERSIONS = ['4.0', '3.0', '2.5', '2.0', '1.0'];

    /** @var array<string, array{label: string, url: ?string, selectable: bool, group: string}>|null */
    private static ?array $all = null;

    /**
     * code → {label, url, selectable, group}. `selectable` = offered in the user's picker
     * (every other code is still a valid stored value, e.g. a harvested CC BY 3.0 work).
     *
     * @return array<string, array{label: string, url: ?string, selectable: bool, group: string}>
     */
    public static function all(): array
    {
        if (self::$all !== null) {
            return self::$all;
        }

        $all = [
            self::DEFAULT_USER => [
                'label' => 'CC BY-SA 4.0 (No AI training)',
                'url' => '/license2025content',
                'selectable' => true,
                'group' => 'hyperlit',
            ],
        ];

        foreach (self::CC_TERMS as $code => $path) {
            foreach (self::CC_VERSIONS as $v) {
                $all["CC-{$code}-{$v}"] = [
                    'label' => "CC {$code} {$v}",
                    'url' => "https://creativecommons.org/licenses/{$path}/{$v}/",
                    'selectable' => $v === '4.0',
                    'group' => 'cc',
                ];
            }
        }

        $all += [
            'CC0' => [
                'label' => 'CC0 1.0 (public domain dedication)',
                'url' => 'https://creativecommons.org/publicdomain/zero/1.0/',
                'selectable' => true,
                'group' => 'public-domain',
            ],
            'PDM' => [
                'label' => 'Public domain',
                'url' => 'https://creativecommons.org/publicdomain/mark/1.0/',
                'selectable' => true,
                'group' => 'public-domain',
            ],
            'All-Rights-Reserved' => [
                'label' => 'All rights reserved',
                'url' => null,
                'selectable' => true,
                'group' => 'other',
            ],
            'Publisher-Open' => [
                'label' => 'Publisher open access (publisher-specific terms)',
                'url' => null,
                'selectable' => false,
                'group' => 'other',
            ],
            'Open-Unspecified' => [
                'label' => 'Open access (licence not stated)',
                'url' => null,
                'selectable' => false,
                'group' => 'other',
            ],
            self::UNKNOWN => [
                'label' => 'Licence unknown',
                'url' => null,
                'selectable' => true,
                'group' => 'other',
            ],
            self::CUSTOM => [
                'label' => 'Custom licence',
                'url' => null,
                'selectable' => true,
                'group' => 'custom',
            ],
        ];

        return self::$all = $all;
    }

    /** @return list<string> */
    public static function codes(): array
    {
        return array_keys(self::all());
    }

    public static function isValid(?string $code): bool
    {
        return $code !== null && isset(self::all()[$code]);
    }

    /**
     * Canonicalise a legacy/mis-cased stored code (`all-rights-reserved`, `cc-by-sa-4.0`) to
     * its vocabulary spelling; null when it matches nothing.
     */
    public static function canonicalCode(?string $code): ?string
    {
        if ($code === null || trim($code) === '') {
            return null;
        }
        if (self::isValid($code)) {
            return $code;
        }
        $lower = strtolower(trim($code));
        foreach (self::codes() as $c) {
            if (strtolower($c) === $lower) {
                return $c;
            }
        }

        return null;
    }

    /** @return array{label: string, url: ?string, selectable: bool, group: string} */
    public static function info(?string $code): array
    {
        return self::all()[self::canonicalCode($code) ?? self::UNKNOWN];
    }

    /** Absolute URL for a code's deed/terms page (relative site paths made absolute). */
    public static function absoluteUrl(?string $code): ?string
    {
        $url = self::info($code)['url'];
        if ($url !== null && str_starts_with($url, '/')) {
            return rtrim((string) config('app.url'), '/') . $url;
        }

        return $url;
    }

    /** CC code for a term path + version, e.g. ('by-nc', '3.0') → 'CC-BY-NC-3.0'. Null if unknown. */
    public static function ccCode(string $termPath, ?string $version): ?string
    {
        $termPath = strtolower($termPath);
        $code = array_search($termPath, self::CC_TERMS, true);
        if ($code === false) {
            return null;
        }
        $v = $version ?: '4.0';
        if (! in_array($v, self::CC_VERSIONS, true)) {
            // e.g. "4" → "4.0"; anything else falls back to the unversioned default.
            $v = in_array("{$v}.0", self::CC_VERSIONS, true) ? "{$v}.0" : '4.0';
        }

        return "CC-{$code}-{$v}";
    }
}
