<?php

namespace App\Services\CitationPipeline\Testing;

use App\Services\WebContent\WebTextAcquirer;

/**
 * The one ladder call the HTTP cassette cannot reach.
 *
 * `WebTextAcquirer::acquire()` has rungs that never touch the `Http` facade — the headless browser
 * (patchright) and the caption reader (yt-dlp), both subprocesses — so `LadderHttpCassette` is blind
 * to them. It is also the slowest thing in a scan by an order of magnitude, which matters when the
 * point of the harness is a diff loop run dozens of times during the wave extraction.
 *
 * Cassetting here rather than at `WebFetchService::fetchAndValidateBatch` is deliberate: it is one
 * rung lower, so `gradePooledResponse()`, the relevance `screen()` and `outcome()` keep running LIVE
 * on replay. Those are exactly the pieces a refactor most needs checked — the relevance screen is
 * the only identity check a readable page gets, and freezing it would hide the very class of bug
 * this harness exists to catch.
 *
 * THE STAGED-PDF TRAP. A `pdf_staged` result is not data, it is a RECEIPT: `PdfSourceReader` writes
 * the bytes to `resources/markdown/{bookId}/original.pdf` and returns `staged_path` pointing at
 * them. Replaying the receipt without performing the write left the ladder holding a pointer to a
 * file that had never been created, so two citations that resolved `web_fetch` and `brave_search`
 * on the tape came back `null` on replay — which reads exactly like a regression in the wave ladder
 * and is nothing of the kind.
 *
 * Re-running those live was the first fix and it was not good enough: the landing-page rung reaches
 * a PDF by way of the BROWSER, which is a subprocess and therefore off-tape, so a "replay" was
 * quietly making real network calls and two consecutive replays disagreed about what the ladder even
 * asked (0 misses, then 5, then 0). So the side effect is taped as well: the staged bytes are
 * recorded beside the result and re-staged on replay if the file is absent. The receipt and the
 * thing it refers to travel together, which is the only way either of them means anything.
 */
class CassetteWebTextAcquirer extends WebTextAcquirer
{
    /**
     * Grades whose result REFERS to something on disk rather than carrying it. Caching one without
     * its referent hands the caller a dangling pointer.
     */
    private const SIDE_EFFECTING_GRADES = [WebTextAcquirer::GRADE_PDF_STAGED];

    /** Companion entry holding the bytes a side-effecting grade wrote. */
    private const STAGED_BYTES = 'WebTextAcquirer::stagedBytes';

    public ?LadderCassette $cassette = null;

    public function acquire(string $url, bool $allowBrowser = true, ?string $citationTitle = null): array
    {
        if (!$this->cassette) {
            return parent::acquire($url, $allowBrowser, $citationTitle);
        }

        // The citation TITLE is part of the key: it steers the identity-confirmation rung, so two
        // citations pointing at one URL can legitimately get different answers from it.
        $args = [$url, $allowBrowser, $citationTitle];

        return $this->cassette->mode === LadderCassette::MODE_REPLAY
            ? $this->replay($args, $url, $allowBrowser, $citationTitle)
            : $this->record($args, $url, $allowBrowser, $citationTitle);
    }

    private function record(array $args, string $url, bool $allowBrowser, ?string $citationTitle): array
    {
        $result = parent::acquire($url, $allowBrowser, $citationTitle);

        if ($this->isSideEffecting($result)) {
            $path = $result['staged_path'] ?? null;

            // Only cacheable if the referent can travel with it. If the bytes cannot be read, store
            // NOTHING — a miss then falls through to a live call, which is worse than a frozen tape
            // but far better than a dangling pointer that silently nulls a resolution.
            if (is_string($path) && is_file($path)) {
                $this->cassette->remember(self::STAGED_BYTES, $args, base64_encode((string) file_get_contents($path)));
                $this->cassette->remember('WebTextAcquirer::acquire', $args, $result);
            }

            return $result;
        }

        $this->cassette->remember('WebTextAcquirer::acquire', $args, $result);

        return $result;
    }

    private function replay(array $args, string $url, bool $allowBrowser, ?string $citationTitle): array
    {
        // A miss here is survivable by design (an uncacheable side-effecting result), so it is not
        // counted against the run — otherwise the designed path reads as a harness failure and the
        // real misses drown among them. Any network the fall-through needs is still taped at HTTP.
        $found = $this->cassette->lookup('WebTextAcquirer::acquire', $args, $url, countAsMiss: false);

        if (!$found['hit']) {
            return parent::acquire($url, $allowBrowser, $citationTitle);
        }

        $result = $found['value'];

        if ($this->isSideEffecting($result)) {
            $this->restageFile($result['staged_path'] ?? null, $args);
        }

        return $result;
    }

    private function isSideEffecting(array $result): bool
    {
        return in_array($result['grade'] ?? null, self::SIDE_EFFECTING_GRADES, true);
    }

    /** Put the recorded bytes back where the result says they are, so the pointer resolves. */
    private function restageFile(?string $path, array $args): void
    {
        if (!is_string($path) || $path === '' || is_file($path)) {
            return;
        }

        $bytes = $this->cassette->lookup(self::STAGED_BYTES, $args, $path, countAsMiss: false);
        if (!$bytes['hit']) {
            return;
        }

        if (!is_dir(dirname($path))) {
            mkdir(dirname($path), 0775, true);
        }

        file_put_contents($path, base64_decode((string) $bytes['value'], true));
    }
}
