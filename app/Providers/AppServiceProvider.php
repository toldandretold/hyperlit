<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Session;
use Illuminate\Support\Facades\View;
use App\Services\DocumentImport\ValidationService;
use App\Services\DocumentImport\SanitizationService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\DocumentImport\Processors\DocxProcessor;
use App\Services\SourceImport\ImportOrchestrator;
use App\Services\SourceImport\Content\Ar5ivFetcher;
use App\Services\SourceImport\Content\OpenAccessPdfFetcher;
use App\Services\SourceImport\Content\PlaywrightPdfFetcher;
use App\Services\SourceImport\Metadata\ArxivMetadataResolver;
use App\Services\SourceImport\Metadata\OpenAlexMetadataResolver;
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
        // LlmService holds mutable per-review usage counters ($usageByModel /
        // $totalRequests). The citation-review pipeline splits its LLM-calling
        // phases into separate autowired collaborators; binding LlmService as a
        // singleton keeps them all sharing ONE instance, so getLlm()->getUsageStats()
        // (the appendix table + billReview credit charge) sees every request.
        // Without this, each phase gets its own instance and billing reads $0.
        $this->app->singleton(\App\Services\LlmService::class);

        // Register DocumentImport services as singletons
        $this->app->singleton(ValidationService::class);
        $this->app->singleton(SanitizationService::class);
        $this->app->singleton(FileHelpers::class);
        $this->app->singleton(MarkdownProcessor::class);
        $this->app->singleton(HtmlProcessor::class);
        $this->app->singleton(EpubProcessor::class);
        $this->app->singleton(ZipProcessor::class);
        $this->app->singleton(DocxProcessor::class);

        // SourceImport — URL/identifier-based imports (arXiv URL, DOI, etc.).
        // Resolvers and fetchers are tagged so adding a new identifier type or
        // content source later only means tagging the new class.
        $this->app->tag([
            OpenAlexMetadataResolver::class,
            ArxivMetadataResolver::class,
        ], 'source-import.resolvers');

        // Order matters: orchestrator iterates and falls through on failure.
        // arXiv fast-path first, then cheap PHP probe at metadata pdf_url, then
        // headless-browser fallback that can handle Cloudflare / JS-gated sites.
        $this->app->tag([
            Ar5ivFetcher::class,
            OpenAccessPdfFetcher::class,
            PlaywrightPdfFetcher::class,
        ], 'source-import.fetchers');

        $this->app->singleton(ImportOrchestrator::class, function ($app) {
            return new ImportOrchestrator(
                $app->make(\App\Services\SourceImport\Identifier\IdentifierNormalizer::class),
                $app->make(\App\Services\SourceImport\CanonicalRegistry::class),
                $app->make(\App\Services\SourceImport\Policy\AccessPolicy::class),
                $app->tagged('source-import.resolvers'),
                $app->tagged('source-import.fetchers'),
            );
        });
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

        // Inject user preferences into layout for synchronous frontend access
        View::composer('layout', function ($view) {
            $user = Auth::user();
            if ($user) {
                $view->with('userPreferences', $user->preferences ?? []);
            }
        });

        // Register custom session handler that bypasses RLS for session reads.
        // StartSession reads the session BEFORE SetDatabaseSessionContext sets
        // app.session_id, so a SECURITY DEFINER function is needed for the read.
        Session::extend('rls-database', function ($app) {
            $connection = $app['db']->connection(config('session.connection'));
            $table = config('session.table', 'sessions');
            $lifetime = config('session.lifetime');
            return new \App\Extensions\RlsSessionHandler($connection, $table, $lifetime, $app);
        });
    }
}
