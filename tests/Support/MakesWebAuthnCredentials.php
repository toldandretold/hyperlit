<?php

namespace Tests\Support;

/**
 * Forges REAL WebAuthn credentials for ceremony tests: none-attestation
 * registration objects and ES256-signed assertions, hand-encoded in CBOR.
 * Everything webauthn-lib verifies (challenge, origin, rpIdHash, flags,
 * signature, counter) is genuine — no mocking of the validators.
 */
trait MakesWebAuthnCredentials
{
    /** @var array<string, \OpenSSLAsymmetricKey> credentialId(b64url) => EC private key */
    protected array $webauthnKeys = [];

    protected function b64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    protected function b64urlDecode(string $encoded): string
    {
        return base64_decode(strtr($encoded, '-_', '+/')) ?: '';
    }

    private function cborText(string $s): string
    {
        // Texts used here are < 24 chars, so the length fits the initial byte.
        return chr(0x60 | strlen($s)) . $s;
    }

    private function cborBytes(string $b): string
    {
        $len = strlen($b);
        if ($len < 24) {
            return chr(0x40 | $len) . $b;
        }
        if ($len < 256) {
            return "\x58" . chr($len) . $b;
        }

        return "\x59" . pack('n', $len) . $b;
    }

    /** COSE_Key map for an ES256 (EC2 / P-256) public key. */
    private function coseEc2Key(string $x, string $y): string
    {
        return "\xA5"          // map(5)
            . "\x01\x02"       // 1 (kty)  : 2 (EC2)
            . "\x03\x26"       // 3 (alg)  : -7 (ES256)
            . "\x20\x01"       // -1 (crv) : 1 (P-256)
            . "\x21" . $this->cborBytes($x)  // -2 (x)
            . "\x22" . $this->cborBytes($y); // -3 (y)
    }

    /** @return array{key: \OpenSSLAsymmetricKey, x: string, y: string} */
    private function makeEcKeypair(): array
    {
        $key = openssl_pkey_new([
            'curve_name' => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
        $details = openssl_pkey_get_details($key);

        return [
            'key' => $key,
            'x' => str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT),
            'y' => str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT),
        ];
    }

    protected function webauthnOrigin(): string
    {
        return rtrim(config('app.url'), '/');
    }

    protected function webauthnRpId(): string
    {
        return parse_url(config('app.url'), PHP_URL_HOST);
    }

    /**
     * Build a registration credential (none attestation) answering $options
     * (the decoded JSON from /api/passkeys/registration-options).
     *
     * @return array{credential: array<string, mixed>, credentialId: string} credentialId is b64url
     */
    public function makeAttestationCredential(array $options, ?string $origin = null): array
    {
        $keypair = $this->makeEcKeypair();
        $credentialId = random_bytes(32);
        $credentialIdB64 = $this->b64url($credentialId);
        $this->webauthnKeys[$credentialIdB64] = $keypair['key'];

        $clientData = json_encode([
            'type' => 'webauthn.create',
            'challenge' => $options['challenge'],
            'origin' => $origin ?? $this->webauthnOrigin(),
            'crossOrigin' => false,
        ]);

        $authData = hash('sha256', $this->webauthnRpId(), true) // rpIdHash
            . "\x45"                                            // flags: UP | UV | AT
            . pack('N', 0)                                      // signCount
            . str_repeat("\0", 16)                              // AAGUID
            . pack('n', strlen($credentialId))
            . $credentialId
            . $this->coseEc2Key($keypair['x'], $keypair['y']);

        $attestationObject = "\xA3"                             // map(3)
            . $this->cborText('fmt') . $this->cborText('none')
            . $this->cborText('attStmt') . "\xA0"               // empty map
            . $this->cborText('authData') . $this->cborBytes($authData);

        return [
            'credential' => [
                'id' => $credentialIdB64,
                'rawId' => $credentialIdB64,
                'type' => 'public-key',
                'authenticatorAttachment' => 'platform',
                'clientExtensionResults' => ['prf' => ['enabled' => true]],
                'response' => [
                    'clientDataJSON' => $this->b64url($clientData),
                    'attestationObject' => $this->b64url($attestationObject),
                    'transports' => ['internal'],
                ],
            ],
            'credentialId' => $credentialIdB64,
        ];
    }

    /**
     * Build a signed assertion answering $options (decoded JSON from
     * /api/passkeys/assertion-options) for a previously forged credential.
     *
     * @return array<string, mixed> the credential to POST to /api/passkeys/assert
     */
    public function makeAssertionCredential(
        array $options,
        string $credentialIdB64,
        int $userId,
        ?string $origin = null,
        int $signCount = 1,
    ): array {
        $key = $this->webauthnKeys[$credentialIdB64]
            ?? throw new \RuntimeException("No forged key for credential {$credentialIdB64}");

        $clientData = json_encode([
            'type' => 'webauthn.get',
            'challenge' => $options['challenge'],
            'origin' => $origin ?? $this->webauthnOrigin(),
            'crossOrigin' => false,
        ]);

        $authData = hash('sha256', $this->webauthnRpId(), true)
            . "\x05"                 // flags: UP | UV
            . pack('N', $signCount);

        openssl_sign($authData . hash('sha256', $clientData, true), $signature, $key, OPENSSL_ALGO_SHA256);

        return [
            'id' => $credentialIdB64,
            'rawId' => $credentialIdB64,
            'type' => 'public-key',
            'authenticatorAttachment' => 'platform',
            'clientExtensionResults' => ['prf' => ['enabled' => true]],
            'response' => [
                'clientDataJSON' => $this->b64url($clientData),
                'authenticatorData' => $this->b64url($authData),
                'signature' => $this->b64url($signature),
                'userHandle' => $this->b64url((string) $userId),
            ],
        ];
    }
}
