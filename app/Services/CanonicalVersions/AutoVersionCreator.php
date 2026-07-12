<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;
use App\Services\ContentFetchService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Creates (or completes) the system auto-version for one canonical: mint a
 * system-owned library stub, fetch its content (ContentFetchService's full
 * acquisition ladder — JATS / OA PDF / HTML / browser lanes), OCR the PDF
 * lane, then wire canonical.auto_version_book via AutoVersionResolver.
 *
 * This is the per-canonical body of `library:create-auto-versions`, extracted
 * so queue jobs (the Source Network Harvester) can run it directly. It calls
 * ContentFetchService rather than Artisan::call('citation:vacuum'/'citation:ocr')
 * on purpose: the commands are thin wrappers, an exit code collapses the rich
 * result array (status/reason/lane), and command instances cache state inside
 * long-running queue workers.
 *
 * Idempotent by construction: assign-first wires a pointer from any previous
 * partial run without fetching; SystemVersionMinter::findExistingSystemRow
 * reuses stubs; a --skip-ocr / contentless outcome stays 'deferred' (pointer
 * NULL) so the canonical remains eligible for a later pass.
 */
class AutoVersionCreator
{
    public function __construct(
        private AutoVersionResolver $resolver,
        private SystemVersionMinter $minter,
        private ContentFetchService $fetcher,
    ) {
    }

    /**
     * @return array{status: string, book: ?string, lane: ?string, reason: ?string}
     *   status: assigned | assigned_existing | fetch_failed | ocr_failed | deferred | error
     */
    public function create(CanonicalSource $canonical, bool $skipOcr = false): array
    {
        try {
            // If an eligible (already-converted) version exists from a previous
            // run, the resolver wires the pointer without any fetching.
            if ($book = $this->resolver->assign($canonical)) {
                return [
                    'status' => 'assigned_existing',
                    'book'   => $book,
                    'lane'   => $this->conversionMethodOf($book),
                    'reason' => 'pointer wired from existing converted version',
                ];
            }

            $existingStub = $this->minter->findExistingSystemRow(
                $canonical,
                AutoVersionResolver::FOUNDATION_SOURCE
            );
            $bookId = $existingStub
                ? $existingStub->book
                : $this->minter->mintSystemRow(
                    $canonical,
                    AutoVersionResolver::CONVERSION_METHOD,
                    AutoVersionResolver::FOUNDATION_SOURCE
                );

            // ---- Fetch (the citation:vacuum single-fetch semantics) ----
            $record = $this->loadRecord($bookId);
            if (!$record) {
                return ['status' => 'error', 'book' => $bookId, 'lane' => null, 'reason' => 'stub library row vanished'];
            }

            $url = $record->oa_url ?: ($record->pdf_url ?: null);
            $doi = $record->doi ?? null;

            if (!$url && !$doi) {
                return [
                    'status' => 'fetch_failed',
                    'book'   => $bookId,
                    'lane'   => null,
                    'reason' => 'no fetchable URL (no oa_url, pdf_url, or doi)',
                ];
            }

            // Skip re-fetch when a previous attempt already stamped pdf_url_status
            // (unless the row has an oa_url, which uses a different path) — the
            // same guard citation:vacuum applies. The OCR step below may still
            // complete a 'downloaded' row from that earlier run.
            $alreadyFetched = !$record->oa_url && ($record->pdf_url_status ?? null);

            $fetchTrace = ['candidates' => 0, 'won_host' => null, 'won_source' => null];
            if (!$alreadyFetched) {
                $result = $this->fetcher->fetch($record);
                $fetchTrace = $this->fetcher->lastFetchTrace();
                if (($result['status'] ?? null) === 'failed') {
                    return [
                        'status' => 'fetch_failed',
                        'book'   => $bookId,
                        'lane'   => null,
                        'reason' => $result['reason'] ?? 'fetch failed',
                        'via'    => $fetchTrace['candidates'] > 0 ? "tried {$fetchTrace['candidates']} OA locations" : null,
                    ];
                }
            }

            // ---- OCR (the citation:ocr single semantics) ----
            if (!$skipOcr) {
                // Re-read: the fetch may have imported directly (JATS/HTML lanes
                // set pdf_url_status='imported' with nodes already present) or
                // left a downloaded PDF awaiting OCR.
                $record = $this->loadRecord($bookId);

                if (($record->pdf_url_status ?? null) !== 'imported') {
                    $pdfPath = resource_path("markdown/{$bookId}/original.pdf");

                    if (!File::exists($pdfPath)) {
                        return [
                            'status' => 'ocr_failed',
                            'book'   => $bookId,
                            'lane'   => $record->conversion_method ?? null,
                            'reason' => 'no PDF on disk to OCR',
                        ];
                    }

                    $ocr = $this->fetcher->processLocalPdf($pdfPath, $bookId);
                    if (($ocr['status'] ?? null) === 'failed') {
                        return [
                            'status' => 'ocr_failed',
                            'book'   => $bookId,
                            'lane'   => $record->conversion_method ?? null,
                            'reason' => $ocr['reason'] ?? 'OCR failed',
                        ];
                    }
                }
            }

            // ---- Wire the pointer. Requires has_nodes=true, so a skip-ocr /
            // contentless stub stays 'deferred' (pointer NULL) and the canonical
            // remains eligible for a later OCR pass. ----
            if ($book = $this->resolver->assign($canonical)) {
                return [
                    'status' => 'assigned',
                    'book'   => $book,
                    'lane'   => $this->conversionMethodOf($book),
                    'reason' => null,
                    'via'    => $fetchTrace['won_host'] ? "from {$fetchTrace['won_host']}" : null,
                ];
            }

            return [
                'status' => 'deferred',
                'book'   => $bookId,
                'lane'   => $this->conversionMethodOf($bookId),
                'reason' => 'stub has no converted content yet',
            ];
        } catch (\Throwable $e) {
            return [
                'status' => 'error',
                'book'   => $bookId ?? null,
                'lane'   => null,
                'reason' => $e->getMessage(),
            ];
        }
    }

    private function loadRecord(string $bookId): ?object
    {
        return DB::connection('pgsql_admin')->table('library')->where('book', $bookId)->first();
    }

    private function conversionMethodOf(string $bookId): ?string
    {
        return DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $bookId)
            ->value('conversion_method');
    }
}
