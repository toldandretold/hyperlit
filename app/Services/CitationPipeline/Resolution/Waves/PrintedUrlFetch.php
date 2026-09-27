<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebFetchService;
use Illuminate\Support\Facades\Log;

/**
 * Printed-URL fetch (old Wave 6) — the citation's own testimony about where the work lives.
 *
 * The URL an author PRINTS outranks anything a title search returns, which is why earlier waves
 * PARK their matches for URL-bearing citations and this wave gets first refusal. Three
 * hard-won behaviours, each the scar of a real failure:
 *
 * - A FAILED fetch records WHY into waveResults['web_fetch'] (grade, reason, http_status,
 *   channel). This was the ONLY wave that recorded nothing on failure, which is how a reference
 *   with a live URL got diagnosed `no_candidates_all_waves` — indistinguishable from a
 *   fabricated reference. A refusal can still confirm the reference is REAL (a paywall
 *   interstitial declares the work's title without a word of its body), so a title carried by
 *   the refusal is recorded too.
 *
 * - A ref holding a PARKED LIBRARY MATCH is only surrendered to a fetch that actually READ the
 *   article (`gradeCarriesArticleText`, or a staged PDF — the conversion lane reads those).
 *   The wave's own success test is any non-null text, so without this a 400-character
 *   "Subscribe now" teaser would evict a real library copy of the work.
 *
 * - A cited PDF goes down the REAL conversion lane (`createPdfSourceStub` on the staged file)
 *   rather than having its text written here — plain text would bypass the pipeline the whole
 *   app is built around, and the row would be invisible to the OCR step.
 *
 * Full web-source VERIFICATION (identity against the cited title, canonical eligibility) still
 * runs in the VACUUM stage via importWebSource — this wave resolves, it does not certify.
 */
class PrintedUrlFetch implements ResolutionWave
{
    public function id(): string
    {
        return 'printed_url_fetch';
    }

    public function title(): string
    {
        return 'Fetch the URL the citation prints';
    }

    public function plain(): string
    {
        return 'The citation printed a web address, so we fetched that address itself — the '
            . 'author\'s own statement of where the work lives — before trusting any search '
            . 'result. What came back was graded, and a refusal was recorded rather than '
            . 'treated as proof the work does not exist.';
    }

    public function dev(): string
    {
        return 'extractUrl(content) else llmMetadata.url (protocol typos fixed); '
            . 'fetchAndValidateBatch through WebTextAcquirer\'s rung ladder. Success mints a stub '
            . '(createWebStubWithNodes, or createPdfSourceStub for pdf_staged) and resolves via '
            . 'resolveWithStub(web_fetch). Failure records grade/reason/status/channel into '
            . 'waveResults.web_fetch. A parked library match survives anything that is not '
            . 'article text.';
    }

    public function entryGate(): string
    {
        return 'Unresolved pool entries whose citation text or extracted metadata carries a URL.';
    }

    public function acceptGate(): string
    {
        return 'The fetch yields article-carrying text or a staged PDF; a teaser-grade page '
            . 'cannot displace a parked library match.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $webFetch = app(WebFetchService::class);
        $urlItems = [];
        $llmUrlEntries = [];
        foreach ($ctx->pool as $refId => $item) {
            $url = $webFetch->extractUrl($item['content']);

            // Fallback: use LLM-extracted URL (with protocol typo fix)
            if (!$url && !empty($item['llmMetadata']['url'])) {
                $llmUrl = $item['llmMetadata']['url'];
                $llmUrl = preg_replace('#^htts://#i', 'https://', $llmUrl);
                $llmUrl = preg_replace('#^htp://#i', 'http://', $llmUrl);
                $llmUrl = preg_replace('#^htps://#i', 'https://', $llmUrl);
                if (preg_match('#^https?://#i', $llmUrl)) {
                    $url = $llmUrl;
                    $llmUrlEntries[$refId] = true;
                }
            }

            if ($url) {
                $urlItems[$refId] = [
                    'url'   => $url,
                    'title' => $item['searchedTitle'] ?? 'Web Source',
                ];
            }
        }

        if (empty($urlItems)) {
            return;
        }

        Log::info('Wave 6: Web fetch', ['count' => count($urlItems)]);

        foreach ($webFetch->fetchAndValidateBatch($urlItems) as $refId => $fetched) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }
            $text = $fetched['text'] ?? null;
            $staged = ($fetched['grade'] ?? null) === WebTextAcquirer::GRADE_PDF_STAGED;
            if (!$text && !$staged) {
                $ctx->waveResults[$refId]['web_fetch'] = [
                    'url'         => $urlItems[$refId]['url'],
                    'outcome'     => $fetched['grade'] ?? 'unknown',
                    'reason'      => $fetched['reason'] ?? null,
                    'http_status' => $fetched['http_status'] ?? null,
                    'channel'     => $fetched['channel'] ?? null,
                    // 'rejected' here means the page was READ and the screen said it is not the
                    // cited work — a different fact from every other failure in this record.
                    'screen'      => $fetched['screen'] ?? null,
                ];
                if (!empty($fetched['title'])) {
                    $ctx->waveResults[$refId]['web_fetch']['title'] = $fetched['title'];
                }
                continue;
            }
            $item = $ctx->pool[$refId];

            // Record the SUCCESSFUL read too — this wave used to record only failure, so a
            // resolved citation's trace could not say how its source was acquired or whether the
            // relevance screen actually ran ("screened and passed" ≡ "never screened" until the
            // screen verdict was stamped on the result).
            $ctx->waveResults[$refId]['web_fetch'] = array_filter([
                'url'     => $urlItems[$refId]['url'],
                'outcome' => $fetched['grade'] ?? 'unknown',
                'channel' => $fetched['channel'] ?? null,
                'screen'  => $fetched['screen'] ?? null,
            ], fn ($v) => $v !== null);

            if (isset($ctx->host->urlDeferredLibraryMatches()[$refId])
                && !$staged
                && !$ctx->host->gradeCarriesArticleText($fetched['grade'] ?? null)
            ) {
                $ctx->waveResults[$refId]['url_first'] = 'url_text_too_weak_kept_library_match';
                Log::info('Printed URL read, but not as the article — keeping the library match', [
                    'refId' => $refId, 'grade' => $fetched['grade'] ?? null,
                    'url' => $urlItems[$refId]['url'] ?? null,
                ]);
                continue;
            }

            $stubTitle  = $item['searchedTitle'] ?? 'Web Source';
            $stubAuthor = !empty($item['llmMetadata']['authors']) ? implode('; ', $item['llmMetadata']['authors']) : null;
            $stubYear   = $item['llmMetadata']['year'] ?? null;
            $url        = $urlItems[$refId]['url'];

            $stubBookId = $staged
                ? $webFetch->createPdfSourceStub(
                    $ctx->db, $stubTitle, $stubAuthor, $stubYear,
                    (string) $fetched['staged_path'], $url, (int) ($fetched['prose_blocks'] ?? 0),
                )
                : $webFetch->createWebStubWithNodes(
                    $ctx->db, $stubTitle, $stubAuthor, $stubYear, $text, $url,
                    $fetched['grade'] ?? null, $fetched['staged_page'] ?? null,
                );
            if ($stubBookId) {
                $result = $ctx->host->resolveWithStub($item, $stubBookId, 'web_fetch', $ctx->db);
                $result['url'] = $url;
                $result['url_flags'] = $item['llmMetadata']['url_flags'] ?? null;
                $ctx->recordResult($result);
                $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $stubBookId);
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 6';
    }

    public function edges(): array
    {
        return [['to' => 'host_cooldown', 'label' => 'each URL descends the acquisition ladder']];
    }

}
