# PHP 8.2 → 8.4 on the droplet — side-by-side, reversible

> **Why:** upstream PHP 8.2 stops getting security fixes on **31 Dec 2026**. Prod runs Debian 12's own `php8.2-fpm` (`8.2.36-1~deb12u1`). Bookworm is in Debian LTS now (its fixes arrive as DLAs, e.g. the Nov 2026 nginx fix), and LTS *may* keep backporting into php8.2 after upstream stops — check with `sudo apt install debian-security-support && check-support-status` before treating the date as a hard deadline. Do the upgrade anyway: LTS PHP coverage is best-effort, and the next Laravel major needs PHP ≥ 8.3.

## The shape of it (read this first)

- **PHP 8.4 from `packages.sury.org`, installed BESIDE 8.2.** Ondřej Surý is Debian's own PHP maintainer; this is the standard way to get a newer PHP on stable Debian.
- **NOT a dist-upgrade to Debian 13 (trixie).** Trixie ships 8.4 natively, but the upgrade also moves Python 3.11 → 3.13 (the conversion pipeline, and the 3.11 syntax floor in CLAUDE.md), Postgres to a new major, and every other package on the box. That's a separate, much bigger project.
- **8.2 keeps serving the whole time until the cutover**, and the cutover is three switches (the nginx socket, the `php` CLI alternative, and a supervisor restart). Rollback is the same three switches flipped back. Leave 8.2 installed for two weeks after.
- **Take a DigitalOcean snapshot before you start.** It's the real safety net if anything goes sideways at the OS level.

## Step 1 — Rehearse locally (no prod contact)

1. Install PHP 8.4 in Herd and pin this site to it: `herd isolate 8.4` from the project root (local is 8.3.8 today).
2. Turn on deprecation logging for the rehearsal: `LOG_DEPRECATIONS_CHANNEL=single` in `.env`, then watch `storage/logs/laravel.log`. 8.4 deprecations are warnings, not breakage, but they turn into log noise on prod.
3. `composer install` then `composer check-platform-reqs` — every line should say `success`.
4. `php artisan test` (the PHP suite). Python is unaffected, so pytest doesn't need re-running.
5. Run the SPA grand tour e2e (`npm run test:e2e`, spec `workflows/spa-grand-tour.spec.js`). The Laravel 12 upgrade's login→401 bug was caught ONLY by the grand tour, not by the PHP suite (`deploy/security/README.md` §"Laravel 12").
6. Undo with `herd unisolate` when done, if you want local back on 8.3.

Already done in the code: the one 8.4 deprecation a scan found — an implicitly-nullable parameter (`bool $x = null` → `?bool $x = null`) in `UserHomeServerController::generateUserHomeBook`. A line-based grep can miss multi-line signatures, which is what step 2 is for.

## Step 2 — Prod pre-flight (read-only, changes nothing)

Snapshot the droplet in the DigitalOcean panel first. Then capture what 8.4 has to reproduce:

```
ssh marx@170.64.145.89
dpkg -l 'php8.2*' | awk '/^ii/{print $2}' | tee ~/php82-packages.txt
php -m | tee ~/php82-modules.txt
grep -n "fastcgi_pass" /etc/nginx/sites-available/*
update-alternatives --display php
sudo grep -vE '^\s*(;|$)' /etc/php/8.2/fpm/pool.d/www.conf | tee ~/php82-pool.txt
diff <(php -n -r 'foreach (ini_get_all(null,false) as $k=>$v) echo "$k=$v\n";') <(php -r 'foreach (ini_get_all(null,false) as $k=>$v) echo "$k=$v\n";')
ls /etc/php/8.2/fpm/conf.d/ /etc/php/8.2/cli/conf.d/ | grep -v '^[0-9][0-9]-[a-z_]*\.ini$'
```

- The `diff` line shows every ini value that differs from PHP's built-in defaults. Most of it is just the extensions being loaded; what you're looking for is hand-set values (`memory_limit`, `upload_max_filesize`, `post_max_size`, `max_execution_time`, opcache settings).
- The last line shows any hand-added conf.d files (a `99-custom.ini` or similar).
- The pool file matters most for the RAM budget: `pm`, `pm.max_children`, `pm.start_servers`, `pm.max_requests`, `user`/`group`, `listen`. On a 1.9 GB box, 8.4's pool must use the same numbers (`deploy/supervisor/README.md` budget).

## Step 3 — Install 8.4 beside 8.2 (site unaffected)

```
sudo apt-get update && sudo apt-get install -y lsb-release ca-certificates curl
sudo curl -sSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg
echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/php.list
sudo apt-get update
sed 's/^php8\.2/php8.4/' ~/php82-packages.txt | grep '^php8\.4' | xargs sudo apt-get install -y
```

**Then immediately pin the CLI back to 8.2:**

```
sudo update-alternatives --set php /usr/bin/php8.2
php -v    # must still say 8.2
```

- **Why the pin:** installing `php8.4-cli` flips `/usr/bin/php` to 8.4 automatically (alternatives auto mode picks the newest). Supervisor's workers, the scheduler and `deploy.sh` all call bare `php`, so without the pin they'd quietly move to 8.4 the next time they recycle — before you've tested anything.
- **If `apt` errors on a package name:** a few extensions are named differently or are built into 8.4. Drop that one from the list and re-run; compare `php8.4 -m` against `~/php82-modules.txt` at the end. `imagick` matters (the OG image renderer checks for it); so do `pgsql`, `mbstring`, `xml`/`dom`, `zip`, `intl`, `gd`, `curl`, `bcmath`.
- **Side effect to know about:** sury also builds 8.2, so the next `apt upgrade` will move the existing 8.2 packages from Debian's build to sury's 8.2 build. Same version line, still fine; it's just no longer "Debian's own".

## Step 4 — Port config and smoke-test 8.4 privately

1. Copy the hand-set ini values from step 2 into `/etc/php/8.4/fpm/conf.d/99-hyperlit.ini` AND `/etc/php/8.4/cli/conf.d/99-hyperlit.ini` (the CLI copy matters for workers — `memory_limit` especially).
2. Make `/etc/php/8.4/fpm/pool.d/www.conf` match `~/php82-pool.txt`, except `listen` stays `/run/php/php8.4-fpm.sock`.
3. `sudo php-fpm8.4 -t && sudo systemctl restart php8.4-fpm`
4. Confirm modules match: `diff <(php8.4 -m) ~/php82-modules.txt` — only `Zend OPcache`-style naming noise is OK.
5. Check the app boots on 8.4 from the CLI without touching prod state: `cd /var/www/hyperlit && php8.4 artisan --version && php8.4 artisan about`. Also `php8.4 /usr/bin/composer check-platform-reqs` (adjust the composer path if `which composer` says otherwise).
6. Optional but cheap — a private HTTP smoke test. Add a throwaway server block listening only on localhost that points at the 8.4 socket: copy the main `server { … }` from `sites-available/default` into `/etc/nginx/sites-enabled/php84-test`, change `listen` to `127.0.0.1:8084;` (no ssl, no http2), and `fastcgi_pass` to `unix:/run/php/php8.4-fpm.sock;`. Then `sudo nginx -t && sudo systemctl reload nginx`, and `curl -sI -H 'Host: hyperlit.io' http://127.0.0.1:8084/` plus a book URL. ufw blocks 8084 from outside anyway. Delete the file afterwards.

## Step 5 — Cutover (~1 minute, pick a quiet hour)

```
# 1. web: point nginx at 8.4
sudo sed -i 's#php8\.2-fpm\.sock#php8.4-fpm.sock#' /etc/nginx/sites-available/default
sudo nginx -t && sudo systemctl reload nginx

# 2. CLI: workers, scheduler, deploy.sh
sudo update-alternatives --set php /usr/bin/php8.4

# 3. restart every worker + the scheduler onto 8.4 (queue:restart alone doesn't restart schedule:work)
sudo supervisorctl restart all

# 4. rebuild caches under 8.4, as the app user (same user deploy.sh resolves)
cd /var/www/hyperlit && sudo -u "$(stat -c %U bootstrap/cache)" php artisan optimize

# 5. retire the 8.2 pool (keep the packages for rollback)
sudo systemctl stop php8.2-fpm && sudo systemctl disable php8.2-fpm
```

## Step 6 — Verify

- `php -v` → 8.4; `ps -eo lstart,cmd | grep '[q]ueue:work'` → all started just now.
- Load the homepage and a book logged out, log in, make an edit and check it syncs (this is the flow the grand tour guards).
- `tail -f storage/logs/laravel.log` and `sudo tail -f /var/log/php8.4-fpm.log` for a few minutes.
- Trigger one small import (exercises the `imports` worker + Python), and check an OG image renders (exercises `imagick`).
- `free -m` a few minutes in: memory should match what it was before (same pool numbers).

## Rollback (same three switches, reversed)

```
sudo systemctl enable --now php8.2-fpm
sudo sed -i 's#php8\.4-fpm\.sock#php8.2-fpm.sock#' /etc/nginx/sites-available/default
sudo nginx -t && sudo systemctl reload nginx
sudo update-alternatives --set php /usr/bin/php8.2
sudo supervisorctl restart all
cd /var/www/hyperlit && sudo -u "$(stat -c %U bootstrap/cache)" php artisan optimize
```

## Afterwards (two weeks later, once it's boring)

- Remove 8.2: `sudo apt-get purge 'php8.2*'` — then `php -v` again, to be sure the alternative didn't move.
- `.github/workflows/security-audit.yml` pins `php-version: '8.2'` → change it to `'8.4'`.
- Consider `"config": { "platform": { "php": "8.4" } }` in `composer.json`, so a local `composer update` can never resolve a package prod can't run.
- PHP now ships security releases roughly monthly; sury packages arrive through the normal `apt upgrade`, so whatever applies Debian security updates on the box keeps doing so. Confirm with `systemctl status unattended-upgrades` that it covers the sury origin (`/etc/apt/apt.conf.d/50unattended-upgrades` → `Unattended-Upgrade::Origins-Pattern` needs an `origin=deb.sury.org` line, or sury updates only land when you run apt by hand).
