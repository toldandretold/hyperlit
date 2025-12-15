<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Services\DocumentImport\ValidationService;
use App\Services\DocumentImport\SanitizationService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\DocumentImport\Processors\DocxProcessor;

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
        //
    }
}
