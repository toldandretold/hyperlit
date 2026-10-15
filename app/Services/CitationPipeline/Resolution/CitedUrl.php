<?php

namespace App\Services\CitationPipeline\Resolution;

use App\Services\WebFetchService;

/**
 * THE printed URL for a pool item — one derivation, because four call sites
 * (PrintedUrlFetch, BraveSearchFallback's host gate, the URL-first deferral
 * and its library-match variant) each did `extractUrl(content) ?: llm url`,
 * and for a MULTI-WORK footnote that is backwards: the content is the whole
 * footnote, so extractUrl returns the FIRST work's URL whatever work the item
 * is. deloitte c09: the IIA sub fetched work 1's finance.gov.au page, minted
 * the wrong-work stub, and reported "matched" — while its own printed PDF URL
 * (live, HTTP 200) was never requested.
 *
 * Rules:
 * - a SUB ({refId}::subN) uses ONLY its own work's llmMetadata.url — the
 *   footnote text cannot say which of its URLs belongs to which work;
 * - a multi-work PARENT prefers its own work's llmMetadata.url, falling back
 *   to the content's first URL (works are usually cited in order, so the
 *   first URL is the primary's when extraction captured none);
 * - a single-work entry keeps the historical order: the content IS the
 *   citation as printed, so it outranks a possibly-mangled extraction.
 */
class CitedUrl
{
    /**
     * @param array $item a resolution-pool item (content, llmMetadata, parentRefId?)
     * @return array{url: string, from: 'content'|'llm'}|null
     */
    public static function printed(array $item, ?WebFetchService $webFetch = null): ?array
    {
        $webFetch ??= app(WebFetchService::class);

        $llmUrl = self::fixProtocol($item['llmMetadata']['url'] ?? null);
        $isSub = !empty($item['parentRefId']);
        $isMultiParent = !$isSub && !empty($item['llmMetadata']['sub_citations']);

        if ($isSub) {
            return $llmUrl !== null ? ['url' => $llmUrl, 'from' => 'llm'] : null;
        }

        $contentUrl = $webFetch->extractUrl((string) ($item['content'] ?? '')) ?: null;

        if ($isMultiParent) {
            if ($llmUrl !== null) {
                return ['url' => $llmUrl, 'from' => 'llm'];
            }
            return $contentUrl !== null ? ['url' => $contentUrl, 'from' => 'content'] : null;
        }

        if ($contentUrl !== null) {
            return ['url' => $contentUrl, 'from' => 'content'];
        }
        return $llmUrl !== null ? ['url' => $llmUrl, 'from' => 'llm'] : null;
    }

    /** Convenience: just the URL. */
    public static function printedUrl(array $item, ?WebFetchService $webFetch = null): ?string
    {
        return self::printed($item, $webFetch)['url'] ?? null;
    }

    /** Repair the protocol typos OCR produces; refuse anything else non-http(s). */
    private static function fixProtocol(mixed $url): ?string
    {
        if (!is_string($url) || $url === '') {
            return null;
        }
        $url = preg_replace('#^htts://#i', 'https://', $url);
        $url = preg_replace('#^htp://#i', 'http://', $url);
        $url = preg_replace('#^htps://#i', 'https://', (string) $url);

        return preg_match('#^https?://#i', (string) $url) ? $url : null;
    }
}
