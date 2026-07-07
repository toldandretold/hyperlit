<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * inference_tickets — the "server prepares, client executes" seam for BYO-key
 * inference. When a user has configured their own API key / local LLM, a
 * server-orchestrated feature (vibe CSS, AI Brain, citation review) parks the
 * prompt here instead of calling the shared LLM; the native client claims it,
 * runs it with the user's key, and posts the completion back.
 *
 * RLS-scoped to the owning user (registered users only — BYO requires login, so
 * there is no anonymous creator_token arm). The UNIQUE (creator, feature,
 * context, request_hash) index is also the resume checkpoint: an already-answered
 * prompt is found and replayed instantly instead of re-issued.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE inference_tickets (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                creator varchar NOT NULL,
                feature varchar(30) NOT NULL,
                context_id varchar NULL,
                request_hash varchar(64) NOT NULL,
                status varchar(20) NOT NULL DEFAULT 'pending',
                request jsonb NOT NULL,
                completion jsonb NULL,
                error text NULL,
                expires_at timestamptz NOT NULL,
                claimed_at timestamptz NULL,
                completed_at timestamptz NULL,
                created_at timestamptz DEFAULT NOW(),
                updated_at timestamptz DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement(
            "CREATE INDEX inference_tickets_claim_idx ON inference_tickets (creator, feature, status)"
        );
        // Dedupe key = resume checkpoint. coalesce(context_id,'') so NULL contexts
        // (e.g. vibe CSS) still dedupe.
        DB::connection('pgsql_admin')->statement(
            "CREATE UNIQUE INDEX inference_tickets_dedupe ON inference_tickets (creator, feature, coalesce(context_id, ''), request_hash)"
        );

        DB::connection('pgsql_admin')->statement(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON inference_tickets TO {$appUser}"
        );

        DB::connection('pgsql_admin')->statement("ALTER TABLE inference_tickets ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE inference_tickets FORCE ROW LEVEL SECURITY");

        // Owner-only across the board (registered users; creator = app.current_user).
        foreach (['select' => 'USING', 'insert' => 'WITH CHECK', 'update' => 'USING', 'delete' => 'USING'] as $op => $clause) {
            DB::connection('pgsql_admin')->statement("
                CREATE POLICY inference_tickets_{$op}_policy ON inference_tickets
                FOR " . strtoupper($op) . "
                {$clause} (
                    creator IS NOT NULL
                    AND creator = current_setting('app.current_user', true)
                    AND current_setting('app.current_user', true) IS NOT NULL
                    AND current_setting('app.current_user', true) != ''
                )
            ");
        }
    }

    public function down(): void
    {
        foreach (['select', 'insert', 'update', 'delete'] as $op) {
            DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS inference_tickets_{$op}_policy ON inference_tickets");
        }
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS inference_tickets");
    }
};
