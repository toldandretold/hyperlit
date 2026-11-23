<?php

namespace App\Services\Authors;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Support\UsernameKey;
use Illuminate\Support\Facades\DB;

/**
 * Where an author page's texts CAME from, and who brought them in — the credit
 * line under the hero of /a/{slug} (docs/authors.md).
 *
 * Two different facts, shown separately:
 *  - LOCATIONS: the archive a text was taken from (a scrape manifest's site, or
 *    the host of the book's source URL) — "marxists.org", "Project Gutenberg".
 *  - CONTRIBUTORS: the Hyperlit users whose imports these are, linked to /u/.
 *
 * Derived from the shelf's PUBLIC members on every render, never stored, so it
 * is right the moment a book joins or leaves the page. Only public books are
 * read, so a user is named only for a text they chose to publish.
 */
class AuthorPageSources
{
    /** Hosts that are an identifier or Hyperlit itself, not a place a text was taken from. */
    private const NOT_A_LOCATION = ['doi.org', 'dx.doi.org', 'hyperlit.io', 'hyperlit.test', 'openalex.org'];

    /** Names a reader knows better than the hostname. */
    private const LABELS = [
        'gutenberg.org' => 'Project Gutenberg',
        'archive.org' => 'Internet Archive',
        'arxiv.org' => 'arXiv',
    ];

    /**
     * @return array{locations: list<array{label: string, url: string, count: int}>,
     *               contributors: list<array{name: string, url: string, count: int}>}
     */
    public function forShelf(string $shelfId): array
    {
        $rows = DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'library.book', '=', 'shelf_items.book')
            ->where('shelf_items.shelf_id', $shelfId)
            ->where('library.visibility', 'public')
            ->get(['library.creator', 'library.url', DB::raw("library.raw_json::jsonb ->> 'scrape_site' as scrape_site")]);

        $locations = [];
        $contributors = [];
        foreach ($rows as $row) {
            if ($host = self::host($row->scrape_site ?: $row->url)) {
                $locations[$host] = ($locations[$host] ?? 0) + 1;
            }
            $creator = trim((string) $row->creator);
            if ($creator !== '' && $creator !== AutoVersionResolver::CREATOR) {
                $contributors[$creator] = ($contributors[$creator] ?? 0) + 1;
            }
        }
        arsort($locations);
        arsort($contributors);

        return [
            'locations' => array_map(
                fn (string $host, int $n) => ['label' => self::LABELS[$host] ?? $host, 'url' => 'https://' . $host, 'count' => $n],
                array_keys($locations), $locations
            ),
            'contributors' => array_map(
                fn (string $name, int $n) => ['name' => $name, 'url' => UsernameKey::profileUrl($name), 'count' => $n],
                array_keys($contributors), $contributors
            ),
        ];
    }

    /** A bare, lower-case hostname (no www.) from a site name or URL — or null when it is not one. */
    private static function host(?string $value): ?string
    {
        $value = trim((string) $value);
        if ($value === '') {
            return null;
        }
        $host = str_contains($value, '://') ? (string) parse_url($value, PHP_URL_HOST) : explode('/', $value)[0];
        $host = preg_replace('/^www\./', '', strtolower($host)) ?? '';

        if (preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/', $host) !== 1) {
            return null;
        }

        return in_array($host, self::NOT_A_LOCATION, true) ? null : $host;
    }
}
