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

        // TTS provider seam — config-selected so a self-hosted Kokoro service
        // can swap in without touching GenerateBookAudioJob.
        $this->app->bind(\App\Services\Tts\TtsProviderInterface::class, function () {
            return match (config('services.tts.provider', 'deepinfra')) {
                default => new \App\Services\Tts\DeepInfraKokoroProvider,
            };
        });

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
        // SEO hardening: absolute URLs (canonical, og:url, the cached sitemap) must
        // always be built on the canonical host, never the request host — one crawl
        // of www.hyperlit.io/sitemap.xml would otherwise poison the 1h sitemap cache
        // with www URLs. Production-only so http://hyperlit.test is untouched.
        if ($this->app->isProduction()) {
            \Illuminate\Support\Facades\URL::forceRootUrl(config('app.url'));
            \Illuminate\Support\Facades\URL::forceScheme('https');
        }

        // E2EE lock/publish byte-swaps (image + audio blobs): one PUT per FILE,
        // so an audiobook lock legitimately fires hundreds of owner-authed
        // requests in a minute. Inline `throttle:X,1` middlewares all share ONE
        // per-user bucket (the key is just sha1(user id)), so the swaps starved
        // against the tree pull/push and 429'd the lock — a NAMED limiter gets
        // its own bucket. (Registered HERE: RouteServiceProvider is vestigial —
        // not in bootstrap/providers.php — so nothing in it ever runs.)
        \Illuminate\Support\Facades\RateLimiter::for('blob-swap', function ($request) {
            return \Illuminate\Cache\RateLimiting\Limit::perMinute(600)
                ->by($request->user()?->id ?: $request->ip());
        });

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
