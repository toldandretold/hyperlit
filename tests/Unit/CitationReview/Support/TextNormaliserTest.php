<?php

use App\Services\CitationReview\Support\TextNormaliser;

$n = fn() => new TextNormaliser();

test('smart quotes and apostrophes collapse to ASCII', function () use ($n) {
    expect($n()->normaliseQuotes("\u{2018}a\u{2019} \u{201C}b\u{201D}"))->toBe("'a' \"b\"");
});

test('all dash variants become an ASCII hyphen', function () use ($n) {
    expect($n()->normaliseQuotes("x\u{2013}y\u{2014}z"))->toBe('x-y-z');
});

test('unicode whitespace and nbsp collapse to single spaces', function () use ($n) {
    expect($n()->normaliseQuotes("a\u{00A0}\u{202F}b   c"))->toBe('a b c');
});

test('html entities are decoded', function () use ($n) {
    expect($n()->normaliseQuotes('a &amp; b'))->toBe('a & b');
});
