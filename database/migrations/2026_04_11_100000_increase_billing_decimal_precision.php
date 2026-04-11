<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->decimal('credits', 10, 4)->default(0)->change();
            $table->decimal('debits', 10, 4)->default(0)->change();
        });

        Schema::table('billing_ledger', function (Blueprint $table) {
            $table->decimal('balance_after', 10, 4)->change();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->decimal('credits', 10, 2)->default(0)->change();
            $table->decimal('debits', 10, 2)->default(0)->change();
        });

        Schema::table('billing_ledger', function (Blueprint $table) {
            $table->decimal('balance_after', 10, 2)->change();
        });
    }
};
