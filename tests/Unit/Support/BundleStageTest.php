<?php

use App\Support\BundleStage;
use Illuminate\Filesystem\Filesystem;

/**
 * Two overlapping exports of the same book must not share a staging
 * directory. They used to (`.stage-{book}`, deleted at the start AND end of
 * every run), so a second click on the workbench's bundle button removed the
 * first run's files mid-write — prod 2026-11-15, "file_put_contents(
 * .stage-{book}/db/footnotes.json): No such file or directory".
 */

beforeEach(function () {
    $this->root = sys_get_temp_dir() . '/bundle-stage-test-' . bin2hex(random_bytes(4));
    mkdir($this->root, 0777, true);
});

afterEach(function () {
    (new Filesystem)->deleteDirectory($this->root);
});

test('a second run for the same key leaves the first run\'s stage alone', function () {
    $first = BundleStage::open($this->root, 'book_1');
    mkdir("{$first->dir}/db");
    file_put_contents("{$first->dir}/db/nodes.jsonl", "{}\n");

    // The overlapping export: opens, fills, seals and cleans up while the first is mid-write.
    $second = BundleStage::open($this->root, 'book_1');
    expect($second->dir)->not->toBe($first->dir);
    file_put_contents("{$second->dir}/manifest.json", '{}');
    expect($second->seal("{$this->root}/book_1.tar.gz"))->toBe(0);
    $second->discard();

    // The first run can still write the file that used to throw.
    expect(is_file("{$first->dir}/db/nodes.jsonl"))->toBeTrue();
    expect(file_put_contents("{$first->dir}/db/footnotes.json", '[]'))->toBe(2);

    $first->discard();
    expect(is_dir($first->dir))->toBeFalse();
});

test('seal replaces the bundle atomically and leaves no partial behind', function () {
    $out = "{$this->root}/book_1.tar.gz";
    file_put_contents($out, 'the previous bundle');

    $stage = BundleStage::open($this->root, 'book_1');
    file_put_contents("{$stage->dir}/manifest.json", '{"book":"book_1"}');
    expect($stage->seal($out))->toBe(0);
    $stage->discard();

    exec(sprintf('tar -xzOf %s ./manifest.json', escapeshellarg($out)), $lines, $code);
    expect($code)->toBe(0);
    expect(implode('', $lines))->toBe('{"book":"book_1"}');

    expect(glob("{$this->root}/*.partial"))->toBe([]);
    expect(glob("{$this->root}/.stage-*"))->toBe([]);
});

test('a failed seal keeps the previous bundle and reports the failure', function () {
    $out = "{$this->root}/book_1.tar.gz";
    file_put_contents($out, 'the previous bundle');

    $stage = BundleStage::open($this->root, 'book_1');
    $stage->discard(); // the stage is gone — tar has nothing to archive

    expect($stage->seal($out))->not->toBe(0);
    expect(file_get_contents($out))->toBe('the previous bundle');
    expect(glob("{$this->root}/*.partial"))->toBe([]);
});

test('debris from a run that died is swept, a live run\'s stage is not', function () {
    $dead = "{$this->root}/.stage-book_1";            // the old fixed name, left by a killed run
    $live = "{$this->root}/.stage-book_2-abc123";
    mkdir($dead);
    mkdir($live);
    touch($dead, time() - 3 * 3600);

    $stage = BundleStage::open($this->root, 'book_3');

    expect(is_dir($dead))->toBeFalse();
    expect(is_dir($live))->toBeTrue();
    expect(is_dir($stage->dir))->toBeTrue();
});
