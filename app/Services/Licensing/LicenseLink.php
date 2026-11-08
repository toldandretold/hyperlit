<?php

namespace App\Services\Licensing;

use App\Support\Licenses;
use Illuminate\Support\Facades\DB;

/**
 * Where a work's licence LINKS, and what to call it — for the server render (rel=license,
 * JSON-LD `license`, DC.rights) and MCP get_book. The front end mirrors these rules in
 * resources/js/components/sourceContainer/licenseInfo.ts (`licenseLinkFor`).
 *
 *   custom + licence book (public)  → the licence book; if it changed after the work's pin,
 *                                     /{book}/timemachine?at=<pin> (the terms it was published
 *                                     under), flagged `pinned_terms`
 *   custom + license_url            → that upstream terms page
 *   vocabulary code                 → its deed (Licenses::absoluteUrl), else no link
 */
final class LicenseLink
{
    /**
     * @param  object  $library  needs license, custom_license_text, license_url, license_book, license_book_at
     * @return array{code: string, label: string, url: ?string, pinned_terms: bool, license_book: ?string}
     */
    public static function for(object $library): array
    {
        $code = Licenses::canonicalCode($library->license ?? null) ?? Licenses::UNKNOWN;
        $info = Licenses::info($code);
        $base = rtrim((string) config('app.url'), '/');

        $out = [
            'code' => $code,
            'label' => $info['label'],
            'url' => Licenses::absoluteUrl($code),
            'pinned_terms' => false,
            'license_book' => null,
        ];

        if ($code !== Licenses::CUSTOM) {
            return $out;
        }

        $text = trim((string) ($library->custom_license_text ?? ''));
        if ($text !== '') {
            $out['label'] = mb_strimwidth($text, 0, 120, '…');
        }
        $out['url'] = ! empty($library->license_url) ? $library->license_url : null;

        $bookId = $library->license_book ?? null;
        if ($bookId) {
            $book = DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->first(['book', 'title', 'slug', 'visibility', 'encrypted', 'timestamp']);
            if ($book && $book->visibility === 'public' && ! $book->encrypted) {
                $pin = isset($library->license_book_at) ? (int) $library->license_book_at : null;
                $changed = $book->timestamp !== null ? (int) $book->timestamp : null;
                $out['license_book'] = $book->book;
                $out['label'] = $book->title ?: $out['label'];
                if ($pin && $changed && $changed > $pin) {
                    $out['url'] = "{$base}/{$book->book}/timemachine?at=" . rawurlencode(self::isoFromMs($pin));
                    $out['pinned_terms'] = true;
                } else {
                    $out['url'] = $base . '/' . ($book->slug ?: $book->book);
                }
            }
        }

        return $out;
    }

    /** The time machine's `at` is a timestamptz string (NodeHistoryController), not epoch ms. */
    public static function isoFromMs(int $ms): string
    {
        return gmdate('Y-m-d\\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000);
    }
}
