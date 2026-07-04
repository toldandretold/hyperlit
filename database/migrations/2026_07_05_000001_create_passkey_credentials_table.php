<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * WebAuthn passkey credentials (E2EE unlock ceremony — see docs/e2ee.md).
 *
 * Each row is one registered authenticator. Alongside the standard WebAuthn
 * credential data it stores the E2EE key material THIS credential can unwrap:
 *  - prf_salt: random 32B (b64url) fed to the PRF extension eval on assertion
 *  - wrapped_vault_key: the account vault key wrapped by this credential's
 *    PRF-derived KEK (hlenc envelope). Useless without the authenticator —
 *    the PRF output never leaves the client.
 *
 * Access is controller-scoped by user_id (rows contain only wrapped blobs).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('passkey_credentials', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->text('credential_id')->unique(); // b64url-encoded credential rawId
            $table->text('public_key');              // COSE public key, b64url
            $table->jsonb('transports')->nullable();
            $table->bigInteger('sign_count')->default(0);
            $table->string('aaguid', 64)->nullable();
            $table->string('name', 100)->nullable(); // user-facing label ("MacBook Touch ID")
            $table->text('prf_salt');
            // Null until the post-registration unlock ceremony wraps the vault
            // key for this credential (PRF output only exists client-side
            // during an assertion, so registration is two-phase).
            $table->text('wrapped_vault_key')->nullable();
            $table->jsonb('kek_params')->nullable(); // {info: "hlenc/kek/v1", version: "v1"}
            $table->timestamps();

            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('passkey_credentials');
    }
};
