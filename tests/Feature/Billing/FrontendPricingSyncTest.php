<?php

/**
 * Front-end billing preview must not drift from backend config (docs/billing.md).
 *
 * The PDF-import preview in resources/js/.../citeForm/fileUpload.ts shows the
 * user an estimated OCR cost BEFORE upload, using two hardcoded constants that
 * duplicate backend config: the OCR $/1k-pages rate and the tier multipliers.
 * Server-side billing is the source of truth, but the preview is what the user
 * READS — and it silently lied once (copy said "$1.00/1k" long after the pinned
 * model moved to $2.00). This guard reads the .ts source and fails the moment
 * either constant diverges from config/services.php, so the number the user is
 * quoted always matches what they'll actually be charged.
 *
 * A pure static-source check (no browser) — the regex reads the committed file.
 */

function fePricingSource(): string
{
    $path = base_path('resources/js/components/newbookContainer/citeForm/fileUpload.ts');
    expect(file_exists($path))->toBeTrue("fileUpload.ts moved — update this guard's path");

    return file_get_contents($path);
}

it('the PDF preview OCR rate matches the pinned production model price', function () {
    $src = fePricingSource();

    // const MISTRAL_OCR_COST_PER_1K_PAGES = 2.00;
    expect(preg_match('/MISTRAL_OCR_COST_PER_1K_PAGES\s*=\s*([0-9.]+)/', $src, $m))->toBe(1);
    $feRate = (float) $m[1];

    $pinned = config('services.mistral_ocr.model', 'mistral-ocr-2512');
    $backendRate = (float) config("services.llm.pricing.{$pinned}.per_1k_pages");

    expect($feRate)->toEqualWithDelta($backendRate, 0.0001,
        "fileUpload.ts MISTRAL_OCR_COST_PER_1K_PAGES ({$feRate}) != config price for the pinned model {$pinned} ({$backendRate}). "
        . 'Update the constant (and it feeds the info-tooltip text too).');
});

it('the PDF preview info-tooltip quotes the SAME rate as the constant (no drift between number and copy)', function () {
    $src = fePricingSource();

    // The tooltip text must be derived from the constant, not a second literal —
    // catches the exact "$1.00/1k" stale-copy bug. Assert there is no hardcoded
    // "$<number>/1k pages" dollar literal in the source (the rate is interpolated).
    expect(preg_match('/\$\d+\.\d+\/1k pages/', $src))->toBe(0,
        'fileUpload.ts hardcodes a "$X/1k pages" price literal in the tooltip copy — interpolate '
        . 'MISTRAL_OCR_COST_PER_1K_PAGES instead so the words can never disagree with the number.');
});

it('the PDF preview tier multipliers match config billing_tiers', function () {
    $src = fePricingSource();

    // BILLING_TIERS: { premium: {multiplier: 1.0, ...}, budget: {multiplier: 1.5, ...}, ... }
    foreach (config('services.billing_tiers') as $tier => $conf) {
        $backendMult = (float) $conf['multiplier'];

        // Match e.g.  budget:  { multiplier: 1.5, label: 'Budget' }
        $pattern = '/' . preg_quote($tier, '/') . '\s*:\s*\{\s*multiplier\s*:\s*([0-9.]+)/';
        expect(preg_match($pattern, $src, $m))->toBe(1,
            "fileUpload.ts BILLING_TIERS is missing tier '{$tier}' (present in config/services.php billing_tiers).");
        expect((float) $m[1])->toEqualWithDelta($backendMult, 0.0001,
            "fileUpload.ts multiplier for '{$tier}' ({$m[1]}) != config billing_tiers ({$backendMult}).");
    }
});
