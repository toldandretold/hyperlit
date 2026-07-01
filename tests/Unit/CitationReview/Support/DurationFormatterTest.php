<?php

use App\Services\CitationReview\Support\DurationFormatter;

$d = fn() => new DurationFormatter();

test('sub-minute renders as seconds', function () use ($d) {
    expect($d()->format(45))->toBe('45s');
});

test('minutes with and without trailing seconds', function () use ($d) {
    expect($d()->format(60))->toBe('1m');
    expect($d()->format(90))->toBe('1m 30s');
});

test('hours with and without trailing minutes', function () use ($d) {
    expect($d()->format(3600))->toBe('1h');
    expect($d()->format(3660))->toBe('1h 1m');
});
