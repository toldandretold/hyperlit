# Server security: detect an attack, keep attackers out, know when something changed

> Routine deploys are still just `./deploy/deploy.sh` (`hd`). This folder is the one-off setup of the security layer on the droplet plus the two hooks the deploy now runs (the dependency audit and the AIDE re-baseline). Read it once when installing, and again when an alert fires.

The box is ONE DigitalOcean droplet (2 vCPU / 4 GB / 50 GB, `marx@170.64.145.89`, nginx + PHP-FPM, ten Supervisor programs, Python OCR runs) behind Cloudflare. That rules out a SIEM (Wazuh wants 8 GB on its own) and favours a few small, boring, well-maintained tools that each do one job and together answer the three questions that matter: is someone attacking us, are they getting in, and did anything on disk change that we did not change. Research and the alternatives considered: the plan in the 2026-11-18 session (CrowdSec vs fail2ban, AIDE vs OSSEC, why no ModSecurity, why no Wazuh).

Resident cost of everything below: about 100 MB (CrowdSec agent + firewall bouncer, both under a systemd `MemoryMax`). AIDE and Lynis are cron/one-off spikes. Cloudflare and ufw cost nothing.

## The layers, in install order (cheapest win first)

- **Cloudflare dashboard (0 MB).** Free Managed WAF ruleset + Bot Fight Mode on; one rate-limiting rule for `/api/login`, `/api/register`, `/api/password/*`; Authenticated Origin Pulls on. Nothing to install on the box.
- **Origin lock: ufw (0 MB).** 80/443 accept only Cloudflare's ranges; 22 is keys-only. Without this anyone who finds the droplet IP talks to nginx directly and every Cloudflare control is decorative. `cloudflare-ips.sh --ufw` writes and refreshes the allow rules.
- **nginx real IP (0 MB).** `snippets/cloudflare-realip.conf`: take the visitor address from `CF-Connecting-IP`, but only on connections from Cloudflare. Prerequisite for everything that reads a log. `cloudflare-ips.sh --nginx` refreshes it.
- **CrowdSec (~100 MB).** Reads nginx + sshd logs, detects brute force / scanners / CVE probes / bad bots, bans at the firewall, and pulls the community blocklist. The modern fail2ban. Collections only, no AppSec/WAF module, no Cloudflare worker bouncer.
- **AIDE (cron spike).** File-integrity baseline of the OS and `/var/www/hyperlit`; a daily diff is the "web shell / backdoored vendor" alarm. `deploy.sh` re-baselines after a deploy so the report stays quiet unless something real moved.
- **Lynis (one-off).** Hardening audit with a score and a fix list. Run once now, again after the above, then after big host changes.
- **Dependency audit (in `deploy.sh`).** `composer audit` on production deps blocks a deploy on a CRITICAL advisory; `npm audit --omit=dev` warns on high+. The lockfile is the likeliest way in, and this is what caught the Laravel 11 situation (below).

Everything server-side is a manual `sudo` step, exactly like the supervisor confs. Do them in order and check `free -m` and `./deploy/supervisor/workers.sh health` between steps.

## 1. Cloudflare dashboard

Security → WAF → Managed rules: enable the free "Cloudflare Managed Ruleset". Security → Bots: Bot Fight Mode on. Security → WAF → Rate limiting rules: one rule, path matches `/api/login` or `/api/register` or starts with `/api/password/`, 10 requests per 10 seconds per IP, action Block for 10 minutes (Laravel's named limiters still apply behind it; this just stops the flood reaching PHP at all). SSL/TLS → Origin Server: enable Authenticated Origin Pulls, then on the box add Cloudflare's origin-pull CA to the nginx server block (`ssl_client_certificate` + `ssl_verify_client on`) so a request that did not come through Cloudflare is refused even if the firewall is misconfigured.

## 2. Origin lock (ufw)

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'                       # or: sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo /var/www/hyperlit/deploy/security/cloudflare-ips.sh --ufw   # 80/443 from Cloudflare only (adds ~22 rules)
sudo ufw enable                                          # answer y; keep your SSH session open and test a NEW one
sudo ufw status numbered
```

Verify from your laptop: `curl -skI --max-time 8 https://170.64.145.89/` must time out, `curl -sI https://hyperlit.io/` must return 200. Refresh monthly with the cron line in `cloudflare-ips.sh --help` (it refuses to apply a list that looks wrong, so a Cloudflare outage can never empty the allow list).

Order matters on SSH: add your SSH allow rule BEFORE `ufw enable`, and if you narrow 22 to a fixed IP, make sure that IP is static. DigitalOcean's web console is the recovery path if you lock yourself out.

## 3. nginx real IP

```bash
sudo /var/www/hyperlit/deploy/security/cloudflare-ips.sh --nginx    # writes /etc/nginx/snippets/cloudflare-realip.conf, runs nginx -t, reloads
grep -n 'cloudflare-realip' /etc/nginx/nginx.conf || echo "ADD: include snippets/cloudflare-realip.conf; inside http {}"
sudo nginx -t && sudo systemctl reload nginx
tail -n 3 /var/log/nginx/access.log                                  # first field is now a visitor IP, not 104.x / 172.x
```

The include goes in the `http {}` block of `/etc/nginx/nginx.conf`, not per server, so every vhost agrees. Laravel already trusts the same ranges in `bootstrap/app.php` (`trustProxies`), so its per-IP rate limiters were correct before this; after it, `REMOTE_ADDR` is the visitor too, which is what CrowdSec and the logs need. `tests/Feature/Architecture/CloudflareRangesParityTest.php` keeps the three lists (Laravel, nginx seed, CrowdSec whitelist) identical.

## 4. CrowdSec

```bash
# repo + agent + firewall bouncer (Ubuntu)
curl -s https://install.crowdsec.net | sudo sh
sudo apt install crowdsec crowdsec-firewall-bouncer-nftables

# what to read, what never to ban, memory ceilings
sudo cp /var/www/hyperlit/deploy/security/crowdsec/acquis.yaml /etc/crowdsec/acquis.yaml
sudo cp /var/www/hyperlit/deploy/security/crowdsec/whitelists.yaml /etc/crowdsec/parsers/s02-enrich/hyperlit-whitelists.yaml
sudo sed -i 's|# - 203.0.113.7.*|- <YOUR.HOME.IP>|' /etc/crowdsec/parsers/s02-enrich/hyperlit-whitelists.yaml
sudo mkdir -p /etc/systemd/system/crowdsec.service.d /etc/systemd/system/crowdsec-firewall-bouncer.service.d
sudo cp /var/www/hyperlit/deploy/security/crowdsec/crowdsec-memorymax.conf /etc/systemd/system/crowdsec.service.d/memorymax.conf
sudo cp /var/www/hyperlit/deploy/security/crowdsec/firewall-bouncer-memorymax.conf /etc/systemd/system/crowdsec-firewall-bouncer.service.d/memorymax.conf

# detection collections (parsers + scenarios); the installer usually detects nginx/sshd and adds the first two
sudo cscli collections install crowdsecurity/nginx crowdsecurity/sshd crowdsecurity/linux crowdsecurity/base-http-scenarios crowdsecurity/http-cve crowdsecurity/whitelist-good-actors
sudo systemctl daemon-reload
sudo systemctl restart crowdsec crowdsec-firewall-bouncer
sudo systemctl enable crowdsec crowdsec-firewall-bouncer

# optional: free hosted alert view for one machine
sudo cscli console enroll <key from https://app.crowdsec.net>
```

Check it is reading the right things: `sudo cscli metrics` must show lines parsed for `/var/log/nginx/access.log` and the `ssh.service` journal source; `sudo cscli bouncers list` shows the firewall bouncer as validated; `sudo cscli decisions list` is the live ban list. Provoke it from a VPN or phone hotspot IP (so the whitelist does not apply): `for i in $(seq 1 30); do curl -s -o /dev/null https://hyperlit.io/wp-login.php; done` and watch the decision appear within a minute; your own IP must never appear there.

Two things deliberately NOT installed: the AppSec/WAF component (runs inline in nginx, has been reported at gigabytes of RAM, and Cloudflare's WAF already covers it) and the Cloudflare worker bouncer (the old Cloudflare bouncer is deprecated; the Workers one is complex and wants a paid plan; with the origin locked to Cloudflare a firewall ban at the origin is the same outcome).

Unban yourself or a user: `sudo cscli decisions delete --ip 1.2.3.4`. See why someone was banned: `sudo cscli alerts list` then `sudo cscli alerts inspect <id> -d`. If `journalctl -u crowdsec` ever shows it killed at the 300 MB cap, find the cache that grew (`cscli metrics`) rather than raising the cap.

## 5. AIDE

```bash
sudo apt install aide aide-common
sudo cp /var/www/hyperlit/deploy/security/aide/99_hyperlit /etc/aide/aide.conf.d/99_hyperlit
sudo aide --config=/etc/aide/aide.conf --config-check       # the rules parse (Ubuntu: aide.wrapper --config-check)
sudo /var/www/hyperlit/deploy/security/aide/rebaseline.sh   # first baseline (a few minutes; niced)
sudo sed -i 's/^MAILTO=.*/MAILTO=sam@hyperlit.io/' /etc/default/aide   # where the daily report goes
sudo systemctl enable --now dailyaidecheck.timer            # Debian 12 runs the daily check from a timer, off by default
```

Debian 12 (the droplet) runs the daily check from `dailyaidecheck.timer` (enable it, above) and mails the diff to `MAILTO`; `99_hyperlit` adds the app tree and excludes the directories the app writes at runtime (`storage/`, `bootstrap/cache`, `public/build`, `resources/markdown`, logs, conversion scratch), so a running import never reads as tampering. `vendor/` IS watched: a backdoored Composer package is the current supply-chain shape.

Deploys change files legitimately, so `deploy.sh` step "AIDE baseline" accepts the new state after every deploy that changed code. For unattended `--yes` deploys that needs passwordless sudo for exactly one script:

```bash
echo 'marx ALL=(root) NOPASSWD: /var/www/hyperlit/deploy/security/aide/rebaseline.sh' | sudo tee /etc/sudoers.d/hyperlit-aide
sudo chmod 0440 /etc/sudoers.d/hyperlit-aide && sudo visudo -c
```

After an `apt upgrade` run `sudo ./deploy/security/aide/rebaseline.sh --report` by hand: it shows what changed, then accepts it. (The script uses `aide.wrapper` where Ubuntu provides it and plain `aide --config=/etc/aide/aide.conf` on Debian; `deploy.sh`'s AIDE step keys on the same check.) Reading a report: a change under `/var/www/hyperlit` with no deploy in the last 24 h, a new file under `public/` or `/usr/bin`, a changed `~/.ssh/authorized_keys` or `/etc/crontab`, or anything in `/etc/nginx` or `/etc/php` you did not edit, is an incident until explained. Mail delivery must actually work (`echo test | mail -s aide sam@hyperlit.io`); a report nobody receives is no report.

## 6. Lynis

```bash
sudo apt install lynis
sudo lynis audit system --quick | tee /tmp/lynis-$(date +%F).txt
sudo grep -E 'Hardening index|Suggestion|Warning' /var/log/lynis-report.dat /var/log/lynis.log | head -60
```

Work the warnings first, then the suggestions that are cheap (SSH `PermitRootLogin no`, `PasswordAuthentication no`, `unattended-upgrades`, `fs.protected_*` sysctls, legal banners can be ignored). Re-run after; the hardening index should move. Also worth doing once: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades` so security patches land on their own.

## 7. The dependency audit in deploy.sh

`deploy.sh` now has a "Dependency audit" step before anything is installed. `composer audit --no-dev --locked` is summarised per package with its worst severity; a CRITICAL advisory stops the deploy (`--skip-audit` overrides for an emergency hotfix, after which you fix the lockfile), anything lower is a warning with counts. `npm audit --omit=dev --audit-level=high` is a warning: those packages ship in the browser bundle so they matter, but a transitive advisory in a rendering library must not block a server hotfix.

### State of the lockfiles on 2026-11-18, and what remains

The first run of the gate found 50 advisories across 13 production Composer packages, including ONE critical: `laravel/framework` 11.46.1 (Laravel TokenGuard authentication bypass through non-string API credentials, GHSA-f9x3-7vq9-cph6, fixed in 11.56.1). Laravel 11's security support ended 2026-03-12, so the 11.x line stopped getting most fixes, Composer 2.10 refuses to resolve ANY 11.x release because every one of them carries an unfixed advisory (`policy.advisories.block`), and `roave/security-advisories` cannot be installed for the same reason.

**Done the same day (local lockfile, within the existing `^11.9` constraint):** `composer update --no-blocking --with-all-dependencies laravel/framework league/commonmark guzzlehttp/guzzle guzzlehttp/psr7 symfony/http-foundation symfony/http-kernel symfony/routing symfony/mime symfony/mailer symfony/serializer symfony/polyfill-intl-idn league/flysystem paragonie/sodium_compat` moved the framework to 11.57.1 (the last 11.x) and the twelve transitive packages to current patch releases. `composer audit --no-dev` now lists only `laravel/framework`, five advisories, none critical, all fixed only in 12.x: CRLF injection in the default `email` validation rule (high), temporary signed-URL path confusion (medium), concurrency task output injection (low), debug-page XSS (low). The gate therefore WARNS on every deploy rather than stopping it. Two dev-only advisories (`phpunit/phpunit` unsafe deserialisation in PHPT coverage, `symfony/yaml` parser DoS family) are not in the production tree and not gated; `composer update phpunit/phpunit symfony/yaml` clears them when convenient.

**Also done:** `katex` 0.16.38 → 0.19.1 (prototype pollution, GHSA-238p-pmpm-9mq7). Rendering was diffed formula by formula across the upgrade: the only changes are the documented `katex-` prefix on a few internal structural classes (`base`, `strut`, `sizing`, `accent`, `newline`) and italic-correction margins rounded to four decimals, nothing visible; `resources/css` targets only `.katex-display`, which is unchanged. `npm audit fix` then moved `dompurify` 3.4.3 → 3.4.18 (a dozen IN_PLACE / hook-pollution advisories, none in a mode this app uses, but the sanitizer of pasted HTML is not the place to carry known holes) and `fflate` 0.8.2 → 0.8.3. `npm audit --omit=dev` reports zero. One trap from that bump, so nobody bisects it again: DOMPurify ≥ 3.4.8 reads `nodeName` through a getter cached from `Node.prototype` (cross-realm clobbering hardening), and happy-dom, the vitest DOM, overrides that getter per subclass with a base that returns `''`, so under the test runner the sanitizer stripped EVERY element and three unrelated overlap-highlight tests went red while real Chromium and jsdom were fine. `tests/javascript/setup/test-setup.js` now shims the getter to be polymorphic and `tests/javascript/architecture/dompurifyHappyDomCompat.test.js` names the cause if either library moves. What remains on npm is dev tooling only (`@vitest/mocker`, `happy-dom`, `glob`, `minimatch`, `picomatch`), which never ships to a browser; clear them with the next vitest/happy-dom major.

**Done later the same day: Laravel 12.** `laravel/framework` ^12.0 (12.73.0), `pestphp/pest` ^3.0 (3.8.7, PHPUnit 11.5.56), `nunomaduro/collision` ^8.6; `laravel/mcp` stays at 0.4.1 (it declares `^12.28.1` support). Of the upgrade guide's behaviour changes only one touches this codebase: `HasUuids` on `InferenceTicket` now mints UUIDv7 (ordered) instead of v4, and nothing validates those ids as v4, so it was left on the new default. No `Concurrency::run`, no `Schema::getTables()`-family introspection, no `image` validation rule, no `mergeIfMissing`, the `local` disk is explicitly rooted at `storage/app`, Carbon was already 3.x. The full PHP suite passed on 12 (3865 tests, 14453 assertions; 7 skips and 5 todos are pre-existing markers). `composer audit` is clean with AND without dev deps. Prod PHP is 8.2 and no locked package requires more. **One thing the PHP suite did NOT catch, found by the grand-tour e2e:** after the upgrade every login "succeeded" and the very next request was 401. Laravel 12.45+ stores an HMAC of the password hash in the session (`password_hash_web`, 64 hex chars); `laravel/sanctum` 4.2.0's own `AuthenticateSession` still compared the RAW bcrypt hash, saw a mismatch, logged the device out, flushed the session and threw `AuthenticationException` on the first stateful request after login (so the second request was simply anonymous, which is why it looked flaky). Sanctum 4.2.2 added the HMAC format; the lock is now 4.5.0 (Fortify 1.43.0 alongside). The Feature suite uses `actingAs`, so it never exercised login → next request; `tests/Feature/Auth/LoginSessionPersistsTest.php` now does, through the real stateful middleware stack. Lesson for the next framework major: update the first-party auth packages (sanctum, fortify) IN THE SAME `composer update`, and run the grand tour before calling it done. With the tree clean, `.github/workflows/security-audit.yml` (weekly + every push/PR) was flipped from report-only to ENFORCING: `composer audit --locked` on the full tree, `npm audit --omit=dev --audit-level=high` on runtime deps, the same two checks `deploy.sh` runs.

## When an alert fires: the 10-minute triage

- **CrowdSec banned someone:** `sudo cscli alerts list`, inspect the top one. A scanner hitting `/wp-login.php`, `/.env`, `/.git/config` is normal background noise; the ban did its job. A ban on a real user's IP (they complain the site is "down" while it is up for everyone else) is a false positive: `cscli decisions delete --ip`, then look at which scenario fired and whether an app endpoint is throwing 4xx in bulk by design.
- **AIDE reports changes:** was there a deploy or `apt upgrade` in the window? If yes and the paths match (`vendor/`, `public/build`, `/usr/bin`), re-baseline. If no, treat as an incident: `sudo aide.wrapper --check` for the full diff, `last -a`, `sudo journalctl -u ssh --since -2d`, `sudo cscli alerts list`, `ls -la /var/www/hyperlit/public` for anything that is not ours, `ps auxf` for processes you do not recognise. Do not "fix" the file first; copy it out for a look.
- **Cloudflare shows a spike:** Security → Events. If it is reaching the origin, check `cscli metrics` is seeing it (real IPs); if nginx is logging Cloudflare IPs again, the real-IP include has been lost.
- **Workers are OOM-ing after this was installed:** `systemctl status crowdsec` memory line, `journalctl -k | grep -i kill`. The cap is 300 MB; if CrowdSec is at it, a cache grew. Nothing here may cost a conversion worker its RAM.

## What the repo carries (this folder)

- `cloudflare-ips.sh` — fetch Cloudflare's ranges; `--nginx` rewrites the real-IP snippet (validates with `nginx -t`, rolls back on failure), `--ufw` keeps the 80/443 allow rules in step (adds before it deletes; refuses a short list), `--check` diffs only. Cron monthly.
- `nginx/cloudflare-realip.conf` — the seed/explanation of the nginx snippet; the live copy is generated.
- `crowdsec/acquis.yaml` (what to read), `crowdsec/whitelists.yaml` (Cloudflare ranges + operator, never banned), `crowdsec/*-memorymax.conf` (systemd memory ceilings).
- `aide/99_hyperlit` (app-tree rules and runtime exclusions), `aide/rebaseline.sh` (accept the current disk as baseline; `--report` shows the diff first; called by `deploy.sh`).
- `tests/Feature/Architecture/CloudflareRangesParityTest.php` (PHP suite) — Laravel, nginx seed and CrowdSec whitelist trust identical Cloudflare ranges.

## Ruled out, so nobody re-litigates it

Wazuh / OSSEC (SIEM; 8 GB minimum on its own box; the agent alone becomes an option if a monitoring droplet is ever rented). ModSecurity + OWASP CRS on nginx (compile the connector per nginx upgrade; CRS 403s the editor's raw HTML POSTs without heavy tuning; Cloudflare's managed WAF already does this in front). Coraza (no stable nginx connector yet). CrowdSec AppSec (RAM; redundant with Cloudflare WAF). Falco / Suricata / Zeek / auditd (nothing to see behind Cloudflare on one box, or logs nobody reads without a SIEM). fail2ban (fine, but CrowdSec is the same cost with HTTP-layer scenarios and the shared blocklist). Self-hosted Uptime Kuma or Sentry on this box (RAM; use Cloudflare health checks or a free external pinger).
