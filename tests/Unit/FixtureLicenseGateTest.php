<?php

namespace Tests\Unit;

use App\Services\Conversion\FixtureLicenseGate;
use PHPUnit\Framework\TestCase;

/**
 * The gate that keeps non-redistributable book content out of the public repo:
 * a captured fixture's ocr_response.json is the FULL TEXT of the work, so only
 * provably-permissive licenses may route to the committable fixtures/ tree.
 * Everything ambiguous fails safe to fixtures-local/ (git-ignored).
 */
class FixtureLicenseGateTest extends TestCase
{
    public function test_permissive_cc_licenses_are_committable(): void
    {
        foreach (['cc-by', 'cc-by-4.0', 'CC-BY', 'cc-by-sa', 'cc0', 'public-domain'] as $license) {
            $d = FixtureLicenseGate::decide(true, $license);
            $this->assertTrue($d['committable'], "expected {$license} to be committable");
        }
    }

    public function test_nc_and_nd_variants_are_not_committable(): void
    {
        foreach (['cc-by-nc', 'cc-by-nc-4.0', 'cc-by-nc-sa', 'cc-by-nd'] as $license) {
            $d = FixtureLicenseGate::decide(true, $license);
            $this->assertFalse($d['committable'], "expected {$license} to be local-only");
        }
    }

    public function test_oa_without_known_license_fails_safe(): void
    {
        // green/bronze OA: "a free copy exists somewhere" is NOT a redistribution license.
        $d = FixtureLicenseGate::decide(true, null);
        $this->assertFalse($d['committable']);
        $this->assertStringContainsString('no known license', $d['reason']);

        $d = FixtureLicenseGate::decide(true, 'other-oa');
        $this->assertFalse($d['committable']);
    }

    public function test_no_oa_signal_fails_safe(): void
    {
        // user upload / paste — no canonical row at all
        $d = FixtureLicenseGate::decide(null, null);
        $this->assertFalse($d['committable']);
        $this->assertStringContainsString('no OA signal', $d['reason']);

        // explicit not-OA — even a permissive-looking license string doesn't rescue it
        $d = FixtureLicenseGate::decide(false, 'cc-by');
        $this->assertFalse($d['committable']);
    }
}
