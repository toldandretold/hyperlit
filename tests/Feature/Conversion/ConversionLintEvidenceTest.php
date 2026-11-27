<?php

use App\Services\Conversion\ConversionLint;

it('reads the converter\'s integrity record off disk, so its findings reach the lint', function () {
    // The detectors above were fed the record directly; on prod the record was written for
    // 889 books and none of it was reported, because this reader never picked it up.
    $book = 'lint-evidence-test-' . bin2hex(random_bytes(4));
    $dir = resource_path("markdown/{$book}");
    mkdir($dir, 0777, true);
    try {
        file_put_contents("{$dir}/footnote_meta.json", json_encode(['integrity' => [
            'lost_text' => [['page' => 2, 'chars' => 400, 'before' => 'An opening paragraph that ends as it should.',
                'excerpt' => 'A paragraph the page prints and the book does not hold.']],
        ]]));
        $evidence = ConversionLint::evidenceFor($book);
        expect($evidence['integrity']['lost_text'])->toHaveCount(1);
        $r = (new ConversionLint)->lintBook(
            [['startLine' => '100', 'content' => '<p>An opening paragraph that ends as it should.</p>']], [], $evidence);
        expect(array_column($r['findings'], 'detector'))->toBe(['lost_text']);
    } finally {
        @unlink("{$dir}/footnote_meta.json");
        @rmdir($dir);
    }
});
