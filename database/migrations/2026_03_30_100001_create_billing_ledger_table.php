<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('billing_ledger', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('user_id')->constrained()->index();
            $table->string('type');            // 'credit' or 'debit'
            $table->decimal('amount', 10, 4);  // always positive
            $table->string('description');
            $table->string('category');        // 'ocr', 'ai_review', 'topup', 'adjustment', 'hosting'
            $table->jsonb('line_items')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->decimal('balance_after', 10, 2);
            $table->timestamp('created_at')->useCurrent();
            // No updated_at — ledger entries are immutable
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('billing_ledger');
    }
};
