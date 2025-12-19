<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Auth;
use App\Services\DocumentImport\ValidationService;
use App\Services\DocumentImport\SanitizationService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\DocumentImport\Processors\DocxProcessor;
use App\Models\PgLibrary;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;
use App\Policies\LibraryPolicy;
use App\Policies\HyperlightPolicy;
use App\Policies\HypercitePolicy;
use App\Auth\RlsUserProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // Register DocumentImport services as singletons
        $this->app->singleton(ValidationService::class);
        $this->app->singleton(SanitizationService::class);
        $this->app->singleton(FileHelpers::class);
        $this->app->singleton(MarkdownProcessor::class);
        $this->app->singleton(HtmlProcessor::class);
        $this->app->singleton(EpubProcessor::class);
        $this->app->singleton(ZipProcessor::class);
        $this->app->singleton(DocxProcessor::class);
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Register authorization policies
        Gate::policy(PgLibrary::class, LibraryPolicy::class);
        Gate::policy(PgHyperlight::class, HyperlightPolicy::class);
        Gate::policy(PgHypercite::class, HypercitePolicy::class);

        // Prevent destructive migration commands everywhere
        \Illuminate\Database\Console\Migrations\FreshCommand::prohibit();
        \Illuminate\Database\Console\Migrations\RefreshCommand::prohibit();
        \Illuminate\Database\Console\Migrations\ResetCommand::prohibit();

        // Register custom RLS-aware user provider for authentication
        // This uses a SECURITY DEFINER function to bypass RLS during login
        Auth::provider('rls-eloquent', function ($app, array $config) {
            return new RlsUserProvider($app['hash'], $config['model']);
        });
    }
}
