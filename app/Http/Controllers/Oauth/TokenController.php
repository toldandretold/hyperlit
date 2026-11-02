<?php

namespace App\Http\Controllers\Oauth;

use App\Http\Controllers\Controller;
use App\Models\OauthRefreshToken;
use App\Models\User;
use App\Services\Oauth\AuthCodeStore;
use App\Services\Oauth\ClientRegistry;
use App\Services\Oauth\OauthScopes;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The OAuth token endpoint: authorization_code and refresh_token grants.
 *
 * Stateless (no session, no CSRF — see routes/oauth.php) and public-client
 * only: the caller proves itself with the PKCE code_verifier (code grant) or
 * possession of the refresh token (refresh grant), never a client secret.
 * The access token it returns is an ORDINARY Sanctum PAT, so /mcp treats it
 * identically to a hand-minted one and the user can see/revoke it under
 * "MCP for AI access".
 *
 * Refresh rotation: every refresh use mints a NEW PAT + refresh pair in the
 * same family and tombstones the old refresh row (rotated_at). A rotated
 * token presented again is reuse — a stolen-token signal — and revokes the
 * whole family including its PATs. A refresh row whose PAT reference is NULL
 * without rotated_at means the user deleted the token in the UI: refusal +
 * family revocation, so a revoked connector cannot refresh itself back.
 *
 * The user is hydrated via auth_lookup_user_by_id() (SECURITY DEFINER), the
 * HyperlitPersonalAccessToken pattern — these requests have no RLS context,
 * so a plain User::find() would see nothing.
 *
 * Errors are RFC 6749 §5.2 (invalid_grant for every dead-credential case —
 * Claude keys its "re-authorize now" behavior off that exact string).
 */
class TokenController extends Controller
{
    private const ACCESS_TOKEN_DAYS = 7;

    private const REFRESH_TOKEN_DAYS = 60;

    private const FAMILY_LIFETIME_DAYS = 365; // matches ApiTokenController::MAX_LIFETIME_DAYS

    public function __construct(
        private readonly ClientRegistry $clients,
        private readonly AuthCodeStore $codes,
    ) {
    }

    public function __invoke(Request $request)
    {
        return match ($request->input('grant_type')) {
            'authorization_code' => $this->authorizationCodeGrant($request),
            'refresh_token' => $this->refreshTokenGrant($request),
            default => $this->oauthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token.'),
        };
    }

    private function authorizationCodeGrant(Request $request)
    {
        $clientId = (string) $request->input('client_id', '');
        if ($this->clients->resolve($clientId) === null) {
            return $this->oauthError('invalid_client', 'Unknown or malformed client_id.', 401);
        }

        $code = (string) $request->input('code', '');
        $payload = $code === '' ? null : $this->codes->consume($code);
        if ($payload === null) {
            return $this->oauthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
        }

        if (! hash_equals($payload['client_id'], $clientId)) {
            return $this->oauthError('invalid_grant', 'Authorization code was issued to a different client.');
        }

        // Token-time redirect_uri binding (RFC 6749 §4.1.3).
        if ((string) $request->input('redirect_uri', '') !== $payload['redirect_uri']) {
            return $this->oauthError('invalid_grant', 'redirect_uri does not match the authorization request.');
        }

        // PKCE S256: BASE64URL(SHA256(code_verifier)) must equal the stored challenge.
        $verifier = (string) $request->input('code_verifier', '');
        $computed = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        if ($verifier === '' || ! hash_equals($payload['code_challenge'], $computed)) {
            return $this->oauthError('invalid_grant', 'PKCE verification failed.');
        }

        $resource = $request->input('resource') ?: null;
        if ($resource !== null && $resource !== url('/mcp')) {
            return $this->oauthError('invalid_target', 'Unknown resource. This server issues tokens for '.url('/mcp').' only.');
        }

        $user = $this->hydrateUser((int) $payload['user_id']);
        if ($user === null) {
            return $this->oauthError('invalid_grant', 'The authorizing account no longer exists.');
        }

        return $this->issueTokens(
            user: $user,
            clientId: $clientId,
            clientName: $payload['client_name'],
            scopes: $payload['scopes'],
            familyId: (string) Str::uuid(),
            familyExpiresAt: now()->addDays(self::FAMILY_LIFETIME_DAYS),
        );
    }

    private function refreshTokenGrant(Request $request)
    {
        $presented = (string) $request->input('refresh_token', '');
        if ($presented === '') {
            return $this->oauthError('invalid_request', 'refresh_token is required.');
        }

        $row = OauthRefreshToken::where('token_hash', hash('sha256', $presented))->first();
        if ($row === null) {
            return $this->oauthError('invalid_grant', 'Unknown refresh token.');
        }

        if ($row->revoked_at !== null) {
            return $this->oauthError('invalid_grant', 'This refresh token has been revoked.');
        }

        if ($row->rotated_at !== null) {
            // Reuse of a rotated token = possible theft → kill the family.
            $this->revokeFamily($row->family_id);

            return $this->oauthError('invalid_grant', 'Refresh token reuse detected; this connection has been revoked. Re-authorize to continue.');
        }

        if ($row->personal_access_token_id === null) {
            // The user deleted the access token in the UI — that is a revoke.
            $this->revokeFamily($row->family_id);

            return $this->oauthError('invalid_grant', 'Access was revoked by the user. Re-authorize to continue.');
        }

        if ($row->expires_at->isPast() || $row->family_expires_at->isPast()) {
            return $this->oauthError('invalid_grant', 'Refresh token expired. Re-authorize to continue.');
        }

        $clientId = $request->input('client_id');
        if ($clientId !== null && $clientId !== '' && ! hash_equals($row->client_id, (string) $clientId)) {
            return $this->oauthError('invalid_grant', 'Refresh token was issued to a different client.');
        }

        $user = $this->hydrateUser((int) $row->user_id);
        if ($user === null) {
            return $this->oauthError('invalid_grant', 'The authorizing account no longer exists.');
        }

        $oldPatId = $row->personal_access_token_id;

        return DB::transaction(function () use ($row, $user, $oldPatId) {
            $row->forceFill(['rotated_at' => now()])->save();

            // The superseded access token dies with the rotation.
            $user->tokens()->where('id', $oldPatId)->delete();

            return $this->issueTokens(
                user: $user,
                clientId: $row->client_id,
                clientName: $row->client_name,
                scopes: $row->scopes,
                familyId: $row->family_id,
                familyExpiresAt: $row->family_expires_at,
            );
        });
    }

    /**
     * Mint the PAT + refresh pair and shape the RFC 6749 §5.1 response.
     *
     * @param  list<string>  $scopes
     */
    private function issueTokens(User $user, string $clientId, string $clientName, array $scopes, string $familyId, $familyExpiresAt)
    {
        $abilities = OauthScopes::abilitiesFrom($scopes);
        if ($abilities === []) {
            return $this->oauthError('invalid_scope', 'No usable scopes were granted.');
        }

        $accessExpiry = now()->addDays(self::ACCESS_TOKEN_DAYS);
        $pat = $user->createToken(mb_substr($clientName, 0, 80).' (OAuth)', $abilities, $accessExpiry);

        $refreshToken = 'hrt_'.Str::random(64);
        OauthRefreshToken::create([
            'token_hash' => hash('sha256', $refreshToken),
            'family_id' => $familyId,
            'user_id' => $user->id,
            'client_id' => $clientId,
            'client_name' => $clientName,
            'scopes' => $scopes,
            'personal_access_token_id' => $pat->accessToken->id,
            'expires_at' => now()->addDays(self::REFRESH_TOKEN_DAYS)->min($familyExpiresAt),
            'family_expires_at' => $familyExpiresAt,
        ]);

        return response()->json([
            'access_token' => $pat->plainTextToken,
            'token_type' => 'Bearer',
            'expires_in' => (int) now()->diffInSeconds($accessExpiry),
            'refresh_token' => $refreshToken,
            'scope' => implode(' ', $scopes),
        ], 200, ['Cache-Control' => 'no-store', 'Pragma' => 'no-cache']);
    }

    private function revokeFamily(string $familyId): void
    {
        $patIds = OauthRefreshToken::where('family_id', $familyId)
            ->whereNotNull('personal_access_token_id')
            ->pluck('personal_access_token_id');

        if ($patIds->isNotEmpty()) {
            \App\Models\HyperlitPersonalAccessToken::whereIn('id', $patIds)->delete();
        }

        OauthRefreshToken::where('family_id', $familyId)
            ->whereNull('revoked_at')
            ->update(['revoked_at' => now()]);
    }

    /**
     * SECURITY DEFINER user hydration — these requests have no RLS context.
     */
    private function hydrateUser(int $userId): ?User
    {
        $row = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$userId]);
        if (! $row || in_array($row->status ?? null, ['deleting', 'deleted'], true)) {
            return null;
        }

        $user = new User();
        $user->setRawAttributes((array) $row, true);
        $user->exists = true;

        return $user;
    }

    private function oauthError(string $code, string $description, int $status = 400)
    {
        return response()->json([
            'error' => $code,
            'error_description' => $description,
        ], $status, ['Cache-Control' => 'no-store', 'Pragma' => 'no-cache']);
    }
}
