<?php
// database/migrations/xxxx_xx_xx_xxxxxx_create_anonymous_sessions_table.php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('anonymous_sessions', function (Blueprint $table) {
            $table->id();
            $table->uuid('token')->unique();
            $table->timestamp('created_at');
            $table->timestamp('last_used_at');
            $table->ipAddress('ip_address')->nullable();
            $table->text('user_agent')->nullable();
            
            // Indexes for performance
            $table->index(['token', 'created_at']);
            $table->index('last_used_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('anonymous_sessions');
    }
};