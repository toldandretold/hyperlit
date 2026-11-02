<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * OAuth refresh tokens for the MCP connector flow (thin OAuth over Sanctum).
 *
 * The /oauth/token endpoint exchanges an authorization code (claude.ai,
 * Claude mobile, Claude Code) for an ORDINARY Sanctum personal access token
 * plus a refresh token stored here. Rotation model: every refresh USE mints a
 * new PAT + a new row in the same family_id and stamps the old row
 * rotated_at. A rotated token presented again is REUSE (a stolen-token
 * signal) and revokes the whole family.
 *
 * Deliberately NOT RLS-restricted, same rationale as personal_access_tokens:
 * this table is consulted by grant_type=refresh_token requests, which carry
 * no session and no bearer — there IS no RLS context yet; the row itself is
 * what identifies the user (resolved via auth_lookup_user_by_id(), never a
 * raw users read). It holds no plaintext secrets: token_hash is sha256 of the
 * opaque refresh token, which is shown to the client once.
 *
 * personal_access_token_id is ON DELETE SET NULL, not CASCADE, on purpose:
 * rotation deletes the superseded PAT but the old refresh row must SURVIVE as
 * the reuse-detection tombstone. A UI revoke (user deletes the PAT under
 * "MCP for AI access") nulls the reference, and the token endpoint treats
 * `personal_access_token_id IS NULL AND rotated_at IS NULL` as user-revoked:
 * invalid_grant + family revocation, so a revoked connector cannot silently
 * refresh itself back to life.
 *
 * Written/read on the DEFAULT connection (app role, granted below), like
 * personal_access_tokens. Pruned daily via model:prune (OauthRefreshToken).
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE oauth_refresh_tokens (
                id bigserial PRIMARY KEY,
                token_hash varchar(64) NOT NULL UNIQUE,
                family_id uuid NOT NULL,
                user_id bigint NOT NULL,
                client_id text NOT NULL,
                client_name varchar(255) NOT NULL DEFAULT '',
                scopes jsonb NOT NULL,
                personal_access_token_id bigint REFERENCES personal_access_tokens(id) ON DELETE SET NULL,
                expires_at timestamptz NOT NULL,
                family_expires_at timestamptz NOT NULL,
                rotated_at timestamptz,
                revoked_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement('
            CREATE INDEX oauth_refresh_tokens_family
            ON oauth_refresh_tokens (family_id)
        ');

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_refresh_tokens TO {$appUser}");
        DB::connection('pgsql_admin')->statement("GRANT USAGE ON SEQUENCE oauth_refresh_tokens_id_seq TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS oauth_refresh_tokens');
    }
};
