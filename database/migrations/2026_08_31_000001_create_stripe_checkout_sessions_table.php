<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Local record of every Stripe Checkout Session we create, so a top-up is never
 * "running blind": if the credit webhook is missed/errors, the pending row here
 * lets `billing:reconcile-stripe` discover the paid session, credit it, and
 * alert on anything stuck. The billing_ledger stays the source of truth for
 * WHETHER a credit happened (idempotency); this table tracks the session
 * lifecycle and drives reconciliation + alerting.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stripe_checkout_sessions', function (Blueprint $table) {
            $table->id();
            $table->string('session_id')->unique();        // Stripe cs_… id
            $table->unsignedBigInteger('user_id')->index(); // matches users.id (no FK: webhook/reconcile run outside RLS)
            $table->decimal('credit_amount', 10, 4);
            // pending  = created, not yet credited
            // credited = credit + ledger row committed (terminal)
            // expired  = Stripe session expired unpaid (terminal; stop checking)
            $table->string('status')->default('pending')->index();
            $table->unsignedInteger('attempts')->default(0); // reconciliation attempts
            $table->timestamp('credited_at')->nullable();
            $table->timestamp('alerted_at')->nullable();     // admin alerted about it being stuck
            $table->text('last_error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('stripe_checkout_sessions');
    }
};
