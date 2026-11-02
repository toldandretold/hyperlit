<?php

namespace App\Services\Oauth;

use App\Mcp\TokenAbilities;

/**
 * OAuth scope vocabulary = TokenAbilities verbatim, plus offline_access.
 *
 * The scope strings ARE the PAT ability names (TokenAbilities' docblock
 * promised exactly this mapping), so a granted scope set converts to PAT
 * abilities by simply dropping offline_access. offline_access is advertised
 * so Claude requests it and a refresh token is issued; we issue one either
 * way (harmless, and the connector dies after 7 days without it).
 *
 * Consent-page defaults mirror apiTokensOverlay.ts: read/annotate/report
 * pre-checked, import/write/spend opt-in. Keep the three lists in sync when
 * an ability is added.
 */
class OauthScopes
{
    /** @return list<string> */
    public static function supported(): array
    {
        return [...TokenAbilities::all(), 'offline_access'];
    }

    /** Scopes pre-checked on the consent page. @return list<string> */
    public static function defaults(): array
    {
        return [TokenAbilities::READ, TokenAbilities::ANNOTATE, TokenAbilities::REPORT];
    }

    /**
     * Granted scopes → PAT ability names.
     *
     * @param  list<string>  $scopes
     * @return list<string>
     */
    public static function abilitiesFrom(array $scopes): array
    {
        return array_values(array_intersect($scopes, TokenAbilities::all()));
    }

    /**
     * Parse a space-delimited scope param into supported scopes (unknown
     * scopes silently dropped per RFC 6749 §3.3's "ignore or fail" choice —
     * clients like claude.ai forward whatever scopes_supported advertises,
     * so failing hard would brick the flow on any future vocabulary skew).
     *
     * @return list<string>
     */
    public static function parse(?string $scopeParam): array
    {
        $requested = preg_split('/\s+/', trim((string) $scopeParam), -1, PREG_SPLIT_NO_EMPTY);

        return array_values(array_intersect($requested, self::supported()));
    }
}
