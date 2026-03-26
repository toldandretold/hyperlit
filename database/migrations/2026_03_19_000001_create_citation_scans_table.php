<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('citation_scans', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('book')->index();
            $table->string('status', 20)->default('pending');
            $table->integer('total_entries')->default(0);
            $table->integer('already_linked')->default(0);
            $table->integer('newly_resolved')->default(0);
            $table->integer('failed_to_resolve')->default(0);
            $table->integer('enriched_existing')->default(0);
            $table->jsonb('results')->nullable();
            $table->text('error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('citation_scans');
    }
};
