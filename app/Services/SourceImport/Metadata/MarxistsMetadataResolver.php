<?php

namespace App\Services\SourceImport\Metadata;

use App\Services\SourceImport\Content\MarxistsStitcher;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Identifier\MarxistsId;
use Illuminate\Support\Facades\Cache;

/**
 * Metadata for a marxists.org work, read from the work's own contents page:
 * title, the page's author credit, year, language, and the licence the page
 * STATES (MIA's "Copyleft … ShareAlike" line → CC BY-SA 2.0, "Public Domain:" →
 * PDM, silence → Unknown — never a guess; docs/marxists-import.md).
 *
 * Cached briefly: the UI inspects, then commit re-resolves from scratch, and
 * each resolve is a request to a volunteer-run site.
 */
class MarxistsMetadataResolver implements MetadataResolver
{
    public const PUBLISHER = 'Marxists Internet Archive';

    private const CACHE_SECONDS = 900;

    public function __construct(private readonly MarxistsStitcher $stitcher) {}

    public function supports(Identifier $id): bool
    {
        return $id instanceof MarxistsId;
    }

    public function resolve(Identifier $id): ?SourceMetadata
    {
        if (!$id instanceof MarxistsId) {
            return null;
        }

        $key = 'marxists:metadata:' . sha1($id->value());
        $result = Cache::get($key) ?? $this->stitcher->metadata($id->url());
        if (!($result['ok'] ?? false)) {
            $error = (string) ($result['error'] ?? 'stitch_failed');
            // A site hiccup is "try again", not a verdict on the page — not cached, not a refusal.
            if (in_array($error, ['stitch_failed', 'page_unavailable'], true)) {
                return null;
            }
            Cache::put($key, $result, self::CACHE_SECONDS);
            throw new MetadataRefused($error, (string) ($result['detail'] ?? ''));
        }
        Cache::put($key, $result, self::CACHE_SECONDS);

        $meta = $result['metadata'] ?? [];
        $licence = is_array($meta['licence'] ?? null) ? $meta['licence'] : [];

        return new SourceMetadata([
            'title'        => $meta['title'] ?? null,
            // The credit as the page prints it; "Karl Marx, Friedrich Engels" → the "; " list.
            'author'       => self::authorList($meta['author'] ?? null),
            'year'         => isset($meta['year']) ? (int) $meta['year'] : null,
            'type'         => 'book',
            'publisher'    => self::PUBLISHER,
            'language'     => $meta['language'] ?? null,
            'url'          => $id->url(),
            'oa_url'       => $id->url(),
            // Freely readable on MIA, so the open branch of AccessPolicy — which is about
            // whether we may FETCH it. What licence it carries is a separate, stated fact:
            'is_oa'        => true,
            'oa_status'    => null,
            // The CODE, not the page's sentence: `library.work_license` is varchar(100) and MIA's
            // public-domain statement runs past 200 characters — every Lenin letter failed its
            // insert on it (prod 2026-11-24). The sentence itself is kept in `note`.
            'work_license' => ($licence['code'] ?? 'Unknown') !== 'Unknown' ? $licence['code'] : null,
            'license_evidence' => $licence['evidence'] ?? null,
            'license_code' => $licence['code'] ?? 'Unknown',
            'license_url'  => $licence['url'] ?? null,
            // The information block (Written / Source / Translated / Transcription …).
            'note'         => isset($meta['note']) ? mb_substr((string) $meta['note'], 0, 5000) : null,
            'author_credit' => $meta['author'] ?? null,
        ], 'marxists');
    }

    private static function authorList(?string $credit): ?string
    {
        $names = array_values(array_filter(array_map('trim', preg_split('/\s*(?:;|,|&|\band\b|\bund\b|\bu\.)\s*/iu', (string) $credit) ?: [])));

        return $names ? implode('; ', $names) : null;
    }
}
