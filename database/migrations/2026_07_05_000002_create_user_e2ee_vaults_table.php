<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Per-user E2EE vault recovery blob (see docs/e2ee.md).
 *
 * One row per user who has set up encrypted books: the account vault key
 * wrapped by a KEK derived (PBKDF2) from the one-time recovery code the user
 * was shown at setup. The server cannot decrypt it — this is the lifeline
 * when all passkeys are lost. Controller-scoped by user_id.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_e2ee_vaults', function (Blueprint $table) {
            $table->foreignId('user_id')->primary()->constrained()->cascadeOnDelete();
            $table->text('recovery_wrapped_vault_key');
            $table->jsonb('recovery_kdf_params'); // {alg, salt, iterations, version}
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_e2ee_vaults');
    }
};
