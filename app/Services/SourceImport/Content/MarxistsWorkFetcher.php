<?php

namespace App\Services\SourceImport\Content;

use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Identifier\MarxistsId;
use App\Services\SourceImport\Metadata\SourceMetadata;

/**
 * Fetches a marxists.org work as `original.epub` — by crawling its pages and
 * stitching them (MarxistsStitcher). Slow by design (it waits between
 * requests), so UrlImportController hands marxists imports to
 * StitchMarxistsWorkJob instead of calling this inside the request.
 */
class MarxistsWorkFetcher implements ContentFetcher
{
    public function __construct(private readonly MarxistsStitcher $stitcher) {}

    public function supports(Identifier $id, SourceMetadata $metadata): bool
    {
        return $id instanceof MarxistsId;
    }

    public function fetch(Identifier $id, SourceMetadata $metadata, string $destDir): FetchResult
    {
        if (!$id instanceof MarxistsId) {
            return FetchResult::failure('unsupported_identifier');
        }

        $result = $this->stitcher->build($id->url(), $destDir);
        $epub = rtrim($destDir, '/') . '/original.epub';
        if (!($result['ok'] ?? false) || !is_file($epub)) {
            return FetchResult::failure((string) ($result['error'] ?? 'stitch_failed'));
        }
        @chmod($epub, 0644);

        return FetchResult::success($epub, 'epub');
    }
}
