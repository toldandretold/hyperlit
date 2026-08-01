<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

/**
 * Read-only audit: does any EXISTING book slug or username collide with a
 * reserved root route?
 *
 * The validation added in DbLibraryController/AuthController only guards NEW
 * names, and the reserved list grew after both had been accepting input for a
 * while (it never used to know about /q, /3d, /dev or /maintainer). Anything
 * this reports is already shadowed — the route wins, so the book or user page
 * is unreachable at its short URL.
 *
 * Renaming live rows is a human decision (it breaks existing links), so this
 * only reports. Companion gate: tests/Feature/Routing/ReservedRoutesTest.
 */
class RouteCollisionCheck extends Command
{
    protected $signature = 'routes:check-collisions';

    protected $description = 'Report book slugs / usernames shadowed by a reserved root route';

    public function handle(): int
    {
        $reserved = config('reserved-routes');
        $this->line(count($reserved) . ' reserved root segments (config/reserved-routes.php).');

        // Anything routable but undeclared is the more urgent problem: it means
        // a NEW name of that word could still be accepted and then shadowed.
        $registered = [];
        foreach (Route::getRoutes() as $route) {
            $first = explode('/', ltrim($route->uri(), '/'))[0] ?? '';
            if ($first !== '' && ! str_starts_with($first, '{')) {
                $registered[$first] = true;
            }
        }
        $undeclared = array_diff(array_keys($registered), $reserved);
        if ($undeclared) {
            $this->newLine();
            $this->error('Routable but NOT reserved — add to config/reserved-routes.php:');
            foreach ($undeclared as $segment) {
                $this->line("  /{$segment}");
            }
        }

        $db = DB::connection('pgsql_admin');
        $found = 0;

        $slugs = $db->table('library')->whereIn('slug', $reserved)->pluck('slug', 'book');
        if ($slugs->isNotEmpty()) {
            $this->newLine();
            $this->warn('Book slugs shadowed by a route (the book is unreachable at /<slug>):');
            foreach ($slugs as $book => $slug) {
                $this->line("  {$slug}  ← book {$book}");
                $found++;
            }
        }

        $names = $db->table('users')->whereIn('name', $reserved)->pluck('name');
        if ($names->isNotEmpty()) {
            $this->newLine();
            $this->warn('Usernames shadowed by a route (still reachable at /u/<name>):');
            foreach ($names as $name) {
                $this->line("  {$name}");
                $found++;
            }
        }

        $this->newLine();
        if ($found === 0 && ! $undeclared) {
            $this->info('✓ No collisions.');

            return self::SUCCESS;
        }

        if ($found > 0) {
            $this->line("{$found} existing row(s) affected. Renaming breaks existing links — decide per row;");
            $this->line('a book keeps working at /<bookId> regardless, and a user at /u/<name>.');
        }

        return self::SUCCESS;
    }
}
