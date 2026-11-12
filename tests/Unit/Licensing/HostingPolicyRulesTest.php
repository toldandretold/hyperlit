<?php

/**
 * HostingPolicy::mayPublish — may Hyperlit serve the text of a work it holds but didn't write?
 */

use App\Services\Licensing\HostingPolicy;

function hp(array $row): object
{
    return (object) array_merge(['license' => null, 'creator' => 'canonicalizer_v1', 'type' => null], $row);
}

test('all rights reserved is never published', function () {
    expect(HostingPolicy::mayPublish(hp(['license' => 'All-Rights-Reserved'])))->toBeFalse();
    expect(HostingPolicy::mayPublish(hp(['license' => 'all-rights-reserved'])))->toBeFalse();
});

test('a web page with no licence (or the old No-AI default) is never published', function () {
    expect(HostingPolicy::mayPublish(hp(['creator' => 'WebFetch', 'license' => 'Unknown'])))->toBeFalse();
    expect(HostingPolicy::mayPublish(hp(['creator' => 'WebFetch', 'license' => 'CC-BY-SA-4.0-NO-AI'])))->toBeFalse();
    expect(HostingPolicy::mayPublish(hp(['type' => 'web_source', 'license' => null])))->toBeFalse();
    // ...but a web page that really declares an open licence may be.
    expect(HostingPolicy::mayPublish(hp(['creator' => 'WebFetch', 'license' => 'CC-BY-4.0'])))->toBeTrue();
});

test('open licences, and Unknown on a harvested work still awaiting discovery, stay published', function () {
    foreach (['CC-BY-4.0', 'CC-BY-NC-ND', 'PDM', 'CC0', 'Open-Unspecified', 'Publisher-Open', 'custom', 'Unknown', 'arXiv-Nonexclusive'] as $code) {
        expect(HostingPolicy::mayPublish(hp(['license' => $code])))->toBeTrue("{$code} should stay published");
    }
});
