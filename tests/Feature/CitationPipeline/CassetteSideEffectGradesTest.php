<?php

/**
 * A `pdf_staged` acquire result is not DATA, it is a RECEIPT for a side effect — and caching a
 * receipt is how the characterisation harness lied about the ladder.
 *
 * `PdfSourceReader` writes the fetched bytes to `resources/markdown/{bookId}/original.pdf` and
 * returns a reference to that file; the ladder then builds a source stub from it. Replaying the
 * reference without performing the write left the ladder holding a pointer to a file that had
 * never been created, so two citations that resolved `web_fetch` and `brave_search` on the tape
 * came back `null` on replay. That reads exactly like a regression in the wave ladder and is
 * nothing of the kind — the harness was the broken party, which is the worst possible failure for
 * a tool whose entire job is to tell you whether the ladder changed.
 *
 * The rule, and what this file pins: CACHE PURE ANSWERS, RE-RUN SIDE-EFFECTING ONES. A miss on a
 * side-effecting grade is the designed path, not a fault, so it must not be counted as a cassette
 * miss either — otherwise the real misses drown among them.
 *
 * Staying offline is preserved because `PdfSourceReader` downloads through `Http::`, which IS taped
 * by LadderHttpCassette. The fall-through re-runs the LOGIC, not the network.
 */

use App\Services\CitationPipeline\Testing\CassetteWebTextAcquirer;
use App\Services\CitationPipeline\Testing\LadderCassette;
use App\Services\WebContent\WebTextAcquirer;

test('a pure grade is stored and replays without re-running the acquirer', function () {
    $recorder = LadderCassette::recording();
    $recorder->remember('WebTextAcquirer::acquire', ['https://x.test', true, null], [
        'grade' => WebTextAcquirer::GRADE_FULL_TEXT, 'text' => 'the article',
    ]);

    $path = sys_get_temp_dir() . '/ladder-se-' . bin2hex(random_bytes(6)) . '.json';
    $recorder->save($path);

    $replay = LadderCassette::replaying($path);
    $found = $replay->lookup('WebTextAcquirer::acquire', ['https://x.test', true, null], 'https://x.test', countAsMiss: false);

    expect($found['hit'])->toBeTrue()
        ->and($found['value']['text'])->toBe('the article')
        ->and($replay->misses())->toBe([])
        ->and($replay->fallthroughs())->toBe([]);

    unlink($path);
});

test('a staged PDF replays its FILE, not just its receipt', function () {
    // `staged_path` points at bytes on disk. Replaying the pointer while the file is absent is what
    // nulled two resolutions and looked like a ladder regression. The receipt and its referent must
    // travel together.
    $url = 'https://x.test/a.pdf';
    $args = [$url, true, null];
    $staged = sys_get_temp_dir() . '/ladder-staged-' . bin2hex(random_bytes(6)) . '.pdf';
    $bytes = "%PDF-1.4\n" . random_bytes(48) . "\n%%EOF";

    $recorder = LadderCassette::recording();
    $recorder->remember('WebTextAcquirer::acquire', $args, [
        'grade' => WebTextAcquirer::GRADE_PDF_STAGED, 'text' => null, 'staged_path' => $staged,
    ]);
    $recorder->remember('WebTextAcquirer::stagedBytes', $args, base64_encode($bytes));

    $path = sys_get_temp_dir() . '/ladder-se-' . bin2hex(random_bytes(6)) . '.json';
    $recorder->save($path);

    expect(is_file($staged))->toBeFalse('precondition: the staged file must not exist yet');

    $acquirer = app(CassetteWebTextAcquirer::class);
    $acquirer->cassette = LadderCassette::replaying($path);

    // A cassette HIT, so the real rung ladder is never entered — no browser, no network.
    $result = $acquirer->acquire($url);

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_PDF_STAGED)
        ->and(is_file($staged))->toBeTrue('replay must put the staged bytes back on disk')
        ->and(file_get_contents($staged))->toBe($bytes);

    unlink($staged);
    unlink($path);
});

test('an existing staged file is left alone rather than rewritten', function () {
    $url = 'https://x.test/b.pdf';
    $staged = sys_get_temp_dir() . '/ladder-staged-' . bin2hex(random_bytes(6)) . '.pdf';
    file_put_contents($staged, 'ALREADY THERE');

    $recorder = LadderCassette::recording();
    $recorder->remember('WebTextAcquirer::acquire', [$url, true, null], [
        'grade' => WebTextAcquirer::GRADE_PDF_STAGED, 'staged_path' => $staged,
    ]);
    $recorder->remember('WebTextAcquirer::stagedBytes', [$url, true, null], base64_encode('FROM TAPE'));

    $path = sys_get_temp_dir() . '/ladder-se-' . bin2hex(random_bytes(6)) . '.json';
    $recorder->save($path);

    $acquirer = app(CassetteWebTextAcquirer::class);
    $acquirer->cassette = LadderCassette::replaying($path);
    $acquirer->acquire($url);

    expect(file_get_contents($staged))->toBe('ALREADY THERE');

    unlink($staged);
    unlink($path);
});

test('a by-design fall-through is not counted as a cassette miss', function () {
    // Counting it would report the designed path as a harness failure and bury the real misses.
    $path = sys_get_temp_dir() . '/ladder-se-' . bin2hex(random_bytes(6)) . '.json';
    LadderCassette::recording()->save($path);

    $replay = LadderCassette::replaying($path);
    $replay->lookup('WebTextAcquirer::acquire', ['https://a.test/x.pdf'], 'https://a.test/x.pdf', countAsMiss: false);
    $replay->lookup('http', ['GET real.test/thing'], 'GET real.test/thing');

    expect($replay->stats()['fallthroughs'])->toBe(1)
        ->and($replay->stats()['misses'])->toBe(1)
        ->and($replay->fallthroughs()[0]['key'])->toBe('https://a.test/x.pdf')
        ->and($replay->misses()[0]['key'])->toBe('GET real.test/thing');

    unlink($path);
});

test('every side-effecting grade named is a real WebTextAcquirer grade', function () {
    // A typo here silently disables the protection — the grade would never match, the receipt
    // would be cached again, and the harness would resume lying.
    $constants = (new ReflectionClass(WebTextAcquirer::class))->getConstants();
    $grades = array_values(array_filter(
        $constants,
        fn ($v, $k) => str_starts_with($k, 'GRADE_') && is_string($v),
        ARRAY_FILTER_USE_BOTH
    ));

    $declared = (new ReflectionClass(CassetteWebTextAcquirer::class))->getConstant('SIDE_EFFECTING_GRADES');

    expect(array_diff($declared, $grades))->toBe([], 'not a real GRADE_* constant');
});
