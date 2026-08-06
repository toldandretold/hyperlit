<?php

namespace App\Services\Conversion;

/**
 * Decides whether a conversion-case fixture may be COMMITTED to the public repo.
 *
 * A captured fixture's ocr_response.json is the FULL TEXT of the work, so committing it is
 * redistribution. `is_oa` alone is not enough — OpenAlex's green/bronze flags only say "a free
 * copy exists somewhere", not that redistribution is licensed. So the gate is deliberately
 * conservative: commit ONLY when the work carries a recognised permissive license; everything
 * else (unknown license, other-oa, NC variants, user uploads/pastes with no canonical row at
 * all) goes to the git-ignored fixtures-local/ tree — still a full regression test locally
 * (run_regression.py discovers both trees), just never pushed.
 */
class FixtureLicenseGate
{
    /**
     * Licenses under which committing the full text to a public repo is clearly permitted.
     * Matching is prefix-based on the normalised token so "cc-by-4.0" passes but "cc-by-nc"
     * (its own entry-point prefix, checked longest-first below) does not.
     */
    private const PERMISSIVE_PREFIXES = ['cc0', 'cc-by-sa', 'cc-by', 'public-domain', 'pd'];

    private const NON_PERMISSIVE_PREFIXES = ['cc-by-nc', 'cc-by-nd'];

    /**
     * @param bool|null   $isOa        canonical_source.is_oa (null = no canonical row / unknown)
     * @param string|null $workLicense canonical_source.work_license
     * @return array{committable: bool, reason: string}
     */
    public static function decide(?bool $isOa, ?string $workLicense): array
    {
        $license = strtolower(trim((string) $workLicense));
        $license = str_replace([' ', '_'], '-', $license);

        if (!$isOa) {
            return ['committable' => false,
                    'reason' => $isOa === null
                        ? 'no OA signal (user upload/paste or no canonical row) -> local-only'
                        : 'not open access -> local-only'];
        }
        if ($license === '') {
            return ['committable' => false,
                    'reason' => 'OA but no known license (green/bronze copy) -> local-only'];
        }
        foreach (self::NON_PERMISSIVE_PREFIXES as $prefix) {
            if (str_starts_with($license, $prefix)) {
                return ['committable' => false,
                        'reason' => "license {$license} restricts redistribution -> local-only"];
            }
        }
        foreach (self::PERMISSIVE_PREFIXES as $prefix) {
            if (str_starts_with($license, $prefix)) {
                return ['committable' => true, 'reason' => "license {$license} -> committable"];
            }
        }

        return ['committable' => false,
                'reason' => "unrecognised license {$license} -> local-only"];
    }
}
