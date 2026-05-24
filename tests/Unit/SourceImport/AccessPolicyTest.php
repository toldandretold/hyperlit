<?php

use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Services\SourceImport\Policy\AccessPolicy;

beforeEach(function () {
    $this->policy = new AccessPolicy();
});

test('open access metadata yields canonical + publishable + free', function () {
    $metadata = new SourceMetadata(['is_oa' => true, 'work_license' => 'cc-by'], 'openalex');
    $plan = $this->policy->decide($metadata);

    expect($plan->createCanonicalVersion)->toBeTrue();
    expect($plan->allowPublish)->toBeTrue();
    expect($plan->chargeUser)->toBeFalse();
    expect($plan->access)->toBe('open');
    expect($plan->reason)->toBe('open_access');
});

test('closed access yields no canonical, no publish, charges user', function () {
    $metadata = new SourceMetadata(['is_oa' => false], 'openalex');
    $plan = $this->policy->decide($metadata);

    expect($plan->createCanonicalVersion)->toBeFalse();
    expect($plan->allowPublish)->toBeFalse();
    expect($plan->chargeUser)->toBeTrue();
    expect($plan->access)->toBe('closed');
    expect($plan->reason)->toBe('closed_access');
});

test('missing is_oa flag defaults to closed', function () {
    $metadata = new SourceMetadata([], 'openalex');
    $plan = $this->policy->decide($metadata);

    expect($plan->access)->toBe('closed');
});
