<?php

namespace App\Services\E2ee;

use App\Models\PasskeyCredential;
use App\Models\User;
use Illuminate\Http\Request;
use Symfony\Component\Serializer\SerializerInterface;
use Symfony\Component\Uid\Uuid;
use Webauthn\AttestationStatement\AttestationStatementSupportManager;
use Webauthn\AttestationStatement\NoneAttestationStatementSupport;
use Webauthn\AuthenticatorAssertionResponse;
use Webauthn\AuthenticatorAssertionResponseValidator;
use Webauthn\AuthenticatorAttestationResponse;
use Webauthn\AuthenticatorAttestationResponseValidator;
use Webauthn\AuthenticatorSelectionCriteria;
use Webauthn\CeremonyStep\CeremonyStepManagerFactory;
use Webauthn\CredentialRecord;
use Webauthn\Denormalizer\WebauthnSerializerFactory;
use Webauthn\Exception\WebauthnException;
use Webauthn\PublicKeyCredential;
use Webauthn\PublicKeyCredentialCreationOptions;
use Webauthn\PublicKeyCredentialDescriptor;
use Webauthn\PublicKeyCredentialParameters;
use Webauthn\PublicKeyCredentialRequestOptions;
use Webauthn\PublicKeyCredentialRpEntity;
use Webauthn\PublicKeyCredentialUserEntity;
use Webauthn\TrustPath\EmptyTrustPath;

/**
 * Thin wrapper over web-auth/webauthn-lib for the E2EE unlock ceremony
 * (see docs/e2ee.md). The server's only jobs are credential registration and
 * assertion verification — the PRF extension is evaluated on the authenticator
 * and read client-side; its output NEVER reaches the server.
 */
class WebAuthnService
{
    public const CREATION_SESSION_KEY = 'webauthn.creation_options';

    public const REQUEST_SESSION_KEY = 'webauthn.request_options';

    private SerializerInterface $serializer;

    public function __construct()
    {
        $attestationManager = new AttestationStatementSupportManager([new NoneAttestationStatementSupport()]);
        $this->serializer = (new WebauthnSerializerFactory($attestationManager))->create();
    }

    public function rpId(): string
    {
        return parse_url(config('app.url'), PHP_URL_HOST) ?: 'localhost';
    }

    private function rpEntity(): PublicKeyCredentialRpEntity
    {
        return PublicKeyCredentialRpEntity::create(config('app.name', 'Hyperlit'), $this->rpId());
    }

    private function ceremonyFactory(): CeremonyStepManagerFactory
    {
        $factory = new CeremonyStepManagerFactory();
        if (! app()->environment('production')) {
            // Allow http origins in local dev (WebAuthn itself still requires a
            // secure context in the browser; localhost qualifies).
            $factory->setSecuredRelyingPartyId([$this->rpId()]);
        }

        return $factory;
    }

    /**
     * Build creation options for registering a new passkey. The serialized
     * options are stashed in the session for the verification step.
     */
    public function creationOptions(User $user): string
    {
        $excludeCredentials = PasskeyCredential::where('user_id', $user->id)
            ->pluck('credential_id')
            ->map(fn (string $id) => PublicKeyCredentialDescriptor::create(
                PublicKeyCredentialDescriptor::CREDENTIAL_TYPE_PUBLIC_KEY,
                self::b64urlDecode($id),
            ))
            ->all();

        $options = PublicKeyCredentialCreationOptions::create(
            rp: $this->rpEntity(),
            user: PublicKeyCredentialUserEntity::create(
                $user->email,
                (string) $user->id,
                $user->name ?: $user->email,
            ),
            challenge: random_bytes(32),
            pubKeyCredParams: [
                PublicKeyCredentialParameters::create('public-key', -7),   // ES256
                PublicKeyCredentialParameters::create('public-key', -257), // RS256
            ],
            authenticatorSelection: AuthenticatorSelectionCriteria::create(
                userVerification: AuthenticatorSelectionCriteria::USER_VERIFICATION_REQUIREMENT_REQUIRED,
                residentKey: AuthenticatorSelectionCriteria::RESIDENT_KEY_REQUIREMENT_PREFERRED,
            ),
            attestation: PublicKeyCredentialCreationOptions::ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
            excludeCredentials: $excludeCredentials,
            timeout: 60000,
        );

        $json = $this->serializer->serialize($options, 'json');
        session([self::CREATION_SESSION_KEY => $json]);

        return $json;
    }

    /**
     * Verify an attestation response against the session-stored options.
     * Consumes the challenge (one shot). Returns the validated record.
     */
    public function verifyAttestation(string $credentialJson, Request $request): CredentialRecord
    {
        $optionsJson = session()->pull(self::CREATION_SESSION_KEY);
        if (! $optionsJson) {
            throw new WebauthnException('No pending passkey registration in this session');
        }
        $options = $this->serializer->deserialize($optionsJson, PublicKeyCredentialCreationOptions::class, 'json');

        $credential = $this->serializer->deserialize($credentialJson, PublicKeyCredential::class, 'json');
        $response = $credential->response;
        if (! $response instanceof AuthenticatorAttestationResponse) {
            throw new WebauthnException('Expected an attestation response');
        }

        $validator = AuthenticatorAttestationResponseValidator::create(
            $this->ceremonyFactory()->creationCeremony()
        );

        return $validator->check($response, $options, $request->getHost());
    }

    /**
     * Build request (assertion) options limited to the user's registered
     * credentials. Serialized options stashed in the session.
     */
    public function requestOptions(User $user): string
    {
        $allowCredentials = PasskeyCredential::where('user_id', $user->id)
            ->pluck('credential_id')
            ->map(fn (string $id) => PublicKeyCredentialDescriptor::create(
                PublicKeyCredentialDescriptor::CREDENTIAL_TYPE_PUBLIC_KEY,
                self::b64urlDecode($id),
            ))
            ->all();

        $options = PublicKeyCredentialRequestOptions::create(
            challenge: random_bytes(32),
            rpId: $this->rpId(),
            allowCredentials: $allowCredentials,
            userVerification: PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED,
            timeout: 60000,
        );

        $json = $this->serializer->serialize($options, 'json');
        session([self::REQUEST_SESSION_KEY => $json]);

        return $json;
    }

    /**
     * Verify an assertion response for the unlock ceremony. Consumes the
     * challenge. Returns the matching stored credential with its sign_count
     * updated (caller saves).
     */
    public function verifyAssertion(string $credentialJson, User $user, Request $request): PasskeyCredential
    {
        $optionsJson = session()->pull(self::REQUEST_SESSION_KEY);
        if (! $optionsJson) {
            throw new WebauthnException('No pending passkey assertion in this session');
        }
        $options = $this->serializer->deserialize($optionsJson, PublicKeyCredentialRequestOptions::class, 'json');

        $credential = $this->serializer->deserialize($credentialJson, PublicKeyCredential::class, 'json');
        $response = $credential->response;
        if (! $response instanceof AuthenticatorAssertionResponse) {
            throw new WebauthnException('Expected an assertion response');
        }

        $stored = PasskeyCredential::where('user_id', $user->id)
            ->where('credential_id', self::b64urlEncode($credential->rawId))
            ->first();
        if (! $stored) {
            throw new WebauthnException('Unknown credential for this user');
        }

        $record = $this->toCredentialRecord($stored, $user);
        $validator = AuthenticatorAssertionResponseValidator::create(
            $this->ceremonyFactory()->requestCeremony()
        );
        $updated = $validator->check($record, $response, $options, $request->getHost(), (string) $user->id);

        $stored->sign_count = $updated->counter;

        return $stored;
    }

    /** Rehydrate a webauthn-lib CredentialRecord from our DB columns. */
    private function toCredentialRecord(PasskeyCredential $stored, User $user): CredentialRecord
    {
        return CredentialRecord::create(
            publicKeyCredentialId: self::b64urlDecode($stored->credential_id),
            type: PublicKeyCredentialDescriptor::CREDENTIAL_TYPE_PUBLIC_KEY,
            transports: $stored->transports ?? [],
            attestationType: 'none',
            trustPath: EmptyTrustPath::create(),
            aaguid: Uuid::fromString($stored->aaguid ?: '00000000-0000-0000-0000-000000000000'),
            credentialPublicKey: self::b64urlDecode($stored->public_key),
            userHandle: (string) $user->id,
            counter: (int) $stored->sign_count,
        );
    }

    public static function b64urlEncode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $encoded): string
    {
        return base64_decode(strtr($encoded, '-_', '+/'), true) ?: '';
    }
}
