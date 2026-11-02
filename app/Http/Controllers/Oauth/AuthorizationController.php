<?php

namespace App\Http\Controllers\Oauth;

use App\Http\Controllers\Controller;
use App\Services\Oauth\AuthCodeStore;
use App\Services\Oauth\ClientRegistry;
use App\Services\Oauth\OauthScopes;
use Illuminate\Http\Request;

/**
 * The OAuth authorize endpoint: login + consent for MCP connectors.
 *
 * GET renders resources/views/oauth/authorize.blade.php (login state when no
 * web session, consent state when logged in); POST /oauth/authorize/decision
 * issues the one-time code. Both run the SAME validation ladder — decide()
 * re-validates the POSTed params rather than trusting hidden form fields.
 *
 * The ladder's ordering is the security property (RFC 9700 §4.1): until BOTH
 * client_id and redirect_uri have validated, errors are rendered on OUR page
 * and never redirected — a redirect to an unvalidated URI is an open
 * redirect, and with a code attached it is credential exfiltration. Only
 * after those two pass do errors travel back to the client the OAuth way
 * (redirect with ?error=…&state=…).
 */
class AuthorizationController extends Controller
{
    /** Consent-page copy per ability: [label, description]. */
    private const ABILITY_HELP = [
        'read' => ['Read', 'Read your library, book content, annotations, and search.'],
        'annotate' => ['Annotate', 'Create and edit highlights, hypercites, and shelves.'],
        'import' => ['Import', 'Import documents into your library (free formats).'],
        'write' => ['Write', 'Create and edit content in books you own.'],
        'spend' => ['Spend', 'Spend your credits (e.g. PDF OCR imports).'],
        'report' => ['Report bugs', 'May file a tool-malfunction report with the maintainer (includes your username).'],
    ];

    public function __construct(
        private readonly ClientRegistry $clients,
        private readonly AuthCodeStore $codes,
    ) {
    }

    public function show(Request $request)
    {
        $v = $this->validateAuthRequest($request);
        if ($v['response'] ?? null) {
            return $v['response'];
        }

        return $this->renderConsent($request, $v);
    }

    public function decide(Request $request)
    {
        if (! auth('web')->check()) {
            // The page JS reloads into the login state on a 401.
            return response()->json(['error' => 'unauthenticated'], 401);
        }

        $v = $this->validateAuthRequest($request);
        if ($v['response'] ?? null) {
            // A tampered hidden field. For JSON callers, surface the same
            // page-level refusals as a 400 rather than an HTML error page.
            return response()->json(['error' => 'invalid_request'], 400);
        }

        if ($request->input('action') !== 'approve') {
            return response()->json([
                'redirect' => $this->redirectBack($v['redirect_uri'], [
                    'error' => 'access_denied',
                    'state' => $v['state'],
                ]),
            ]);
        }

        // The approved scopes come from the consent checkboxes; they must be
        // a subset of what the client asked for (or of everything supported,
        // when the client sent no scope param).
        $selected = array_values(array_intersect(
            (array) $request->input('scopes', []),
            $v['offered_scopes'],
        ));

        if (OauthScopes::abilitiesFrom($selected) === []) {
            return response()->json([
                'error' => 'invalid_scope',
                'error_description' => 'Select at least one permission.',
            ], 422);
        }

        if (in_array('offline_access', $v['requested_scopes'], true)) {
            $selected[] = 'offline_access';
        }

        $code = $this->codes->put([
            'user_id' => $request->user()->id,
            'client_id' => $v['client_id'],
            'client_name' => $v['client_name'],
            'redirect_uri' => $v['redirect_uri'],
            'code_challenge' => $v['code_challenge'],
            'scopes' => array_values(array_unique($selected)),
        ]);

        return response()->json([
            'redirect' => $this->redirectBack($v['redirect_uri'], [
                'code' => $code,
                'state' => $v['state'],
            ]),
        ]);
    }

    /**
     * The shared validation ladder. Returns ['response' => …] on refusal, or
     * the validated context array.
     */
    private function validateAuthRequest(Request $request): array
    {
        // Rungs 1 + 2 — refuse ON OUR PAGE, never redirect (open-redirect guard).
        $clientId = (string) $request->input('client_id', '');
        $client = $clientId === '' ? null : $this->clients->resolve($clientId);
        if ($client === null) {
            return ['response' => $this->errorPage('Unknown or malformed client_id. The connecting app needs to re-register (its registration may predate a server key rotation).')];
        }

        $redirectUri = (string) $request->input('redirect_uri', '');
        if ($redirectUri === '' || ! $this->clients->redirectUriMatches($client['redirect_uris'], $redirectUri)) {
            return ['response' => $this->errorPage('The redirect_uri does not match this client\'s registration. Refusing to send you anywhere.')];
        }

        // From here the client is authenticated-enough to receive errors.
        $state = (string) $request->input('state', '');
        $fail = fn (string $error) => ['response' => redirect()->away(
            $this->redirectBack($redirectUri, ['error' => $error, 'state' => $state]),
        )];

        if ($request->input('response_type') !== 'code') {
            return $fail('unsupported_response_type');
        }

        $challenge = (string) $request->input('code_challenge', '');
        if ($challenge === '' || $request->input('code_challenge_method') !== 'S256') {
            return $fail('invalid_request'); // PKCE S256 is mandatory (OAuth 2.1)
        }

        // '' means absent: the consent form round-trips every param, so an
        // originally-omitted resource comes back as an empty string.
        $resource = $request->input('resource') ?: null;
        if ($resource !== null && $resource !== url('/mcp')) {
            return $fail('invalid_target'); // RFC 8707: we are exactly one resource
        }

        $requested = OauthScopes::parse($request->input('scope'));
        if ($requested === [] && trim((string) $request->input('scope')) !== '') {
            return $fail('invalid_scope'); // asked only for scopes we don't have
        }
        // No scope param at all → offer everything (RFC 6749 §3.3 default).
        $offered = $requested === [] ? OauthScopes::supported() : $requested;

        return [
            'client_id' => $clientId,
            'client_name' => $client['client_name'],
            'redirect_uri' => $redirectUri,
            'state' => $state,
            'code_challenge' => $challenge,
            'requested_scopes' => $offered,
            'offered_scopes' => $offered,
        ];
    }

    private function renderConsent(Request $request, array $v)
    {
        $abilities = OauthScopes::abilitiesFrom($v['offered_scopes']);
        $defaults = OauthScopes::defaults();

        return response()->view('oauth.authorize', [
            'clientName' => $v['client_name'],
            'redirectHost' => parse_url($v['redirect_uri'], PHP_URL_HOST) ?? $v['redirect_uri'],
            'abilityHelp' => self::ABILITY_HELP,
            'abilities' => $abilities,
            'defaultAbilities' => array_values(array_intersect($defaults, $abilities)),
            'params' => [
                'client_id' => $v['client_id'],
                'redirect_uri' => $v['redirect_uri'],
                'state' => $v['state'],
                'response_type' => 'code',
                'code_challenge' => $v['code_challenge'],
                'code_challenge_method' => 'S256',
                'scope' => $request->input('scope', ''),
                'resource' => $request->input('resource', ''),
            ],
            'error' => null,
        ]);
    }

    private function errorPage(string $message)
    {
        return response()->view('oauth.authorize', [
            'error' => $message,
            'clientName' => null,
            'redirectHost' => null,
            'abilityHelp' => self::ABILITY_HELP,
            'abilities' => [],
            'defaultAbilities' => [],
            'params' => [],
        ], 400);
    }

    private function redirectBack(string $redirectUri, array $query): string
    {
        $query = array_filter($query, fn ($value) => $value !== '' && $value !== null);
        $separator = str_contains($redirectUri, '?') ? '&' : '?';

        return $redirectUri.$separator.http_build_query($query);
    }
}
