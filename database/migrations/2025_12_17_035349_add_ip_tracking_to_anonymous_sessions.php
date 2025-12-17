<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * 🔒 SECURITY: Add IP change tracking columns
     * These columns help detect potential token theft by tracking
     * how many times a token's IP address changes in a 24h window.
     */
    public function up(): void
    {
        Schema::table('anonymous_sessions', function (Blueprint $table) {
            $table->integer('ip_change_count')->default(0)->after('ip_address');
            $table->timestamp('last_ip_change_at')->nullable()->after('ip_change_count');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('anonymous_sessions', function (Blueprint $table) {
            $table->dropColumn(['ip_change_count', 'last_ip_change_at']);
        });
    }
};
