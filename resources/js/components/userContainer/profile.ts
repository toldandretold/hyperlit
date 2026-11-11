// profile.ts - Logged-in profile view for the user container: renders the
// profile (My Library / Verify Email / Logout) and wires its button listeners
// (with hover styling). Takes the UserContainerManager as `self`.
import { getProfileHTML } from './forms';

export function showUserProfile(self: any) {
  const emailVerified = self.user?.email_verified_at !== null && self.user?.email_verified_at !== undefined;

  // Re-rendering a profile that is ALREADY showing the right thing is never
  // harmless: the innerHTML write destroys and recreates every row, which
  // drops focus, and — because several callers reach here redundantly, some of
  // them from async work (a delayed transfer prompt, an auth round trip) —
  // it can land while the flyout is open and yank a row out from under the
  // pointer mid-click. In the e2e tour that surfaced as #myBooksBtn being
  // "detached from the DOM" between Playwright's stability check and its
  // click. Ask the DOM whether the correct view is already mounted; the two
  // markers below fully determine getProfileHTML's output, so no stored flag
  // is needed (and none can go stale when a login/register view is mounted
  // here instead).
  const alreadyMounted = !!self.container.querySelector('#myBooksBtn')
    && (!!self.container.querySelector('#verifyEmailBtn') === !emailVerified);

  if (!alreadyMounted) {
    self.container.innerHTML = getProfileHTML(emailVerified);
  }

  if (!self.isOpen) {
    self.openContainer("profile");
  } else {
    self.container.style.width = "160px"; /* keep in sync with dimensions.profile */
  }

  // Only for a FRESH render: attachProfileButtonListeners uses bare
  // addEventListener, so re-running it over surviving rows would double-bind
  // every one of them (two SPA navigations per "My Library" click).
  if (!alreadyMounted) {
    self.attachProfileButtonListeners();
  }
}

export function attachProfileButtonListeners(self: any) {
  const logoutBtn = self.container.querySelector('#logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.handleLogout();
    });

    // Hover styling comes from the shared .menu-row-btn class (menuRow.css) —
    // no JS hover handlers, same as the other rows.
  }

  // Data sovereignty: the any-page data/privacy overlay (export, privacy
  // policy, delete account, future data defaults). Same shape as Stats.
  const dataSovereigntyBtn = self.container.querySelector('#dataSovereigntyBtn');
  if (dataSovereigntyBtn) {
    dataSovereigntyBtn.addEventListener('click', async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.closeContainer?.();
      const { openDataSovereigntyOverlay } = await import('../dataSovereignty/dataSovereigntyOverlay');
      openDataSovereigntyOverlay();
    });
  }

  const passkeysBtn = self.container.querySelector('#passkeysBtn');
  if (passkeysBtn) {
    passkeysBtn.addEventListener('click', async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      // Lazy: keeps the e2ee/WebAuthn code out of the eager bundle.
      const { showPasskeySettings } = await import('../../e2ee/ui/passkeySettings');
      await showPasskeySettings({
        container: self.container,
        onBack: () => showUserProfile(self),
      });
    });
  }

  const myBooksBtn = self.container.querySelector('#myBooksBtn');
  if (myBooksBtn) {
    myBooksBtn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.handleMyBooksClick();
    });
    // Hover styling comes from the shared .menu-row-btn class (menuRow.css) — same
    // transparent-until-hover row as the rest of the profile menu.
  }

  // Stats: the any-page creator reading-stats overlay (views, likes, depth).
  const statsBtn = self.container.querySelector('#statsBtn');
  if (statsBtn) {
    statsBtn.addEventListener('click', async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.closeContainer?.();
      const { openStatsOverlay } = await import('../statsOverlay/statsOverlay');
      void openStatsOverlay();
    });
  }

  // Notifications: the any-page "someone engaged with your work" feed.
  const notificationsBtn = self.container.querySelector('#notificationsBtn');
  if (notificationsBtn) {
    notificationsBtn.addEventListener('click', async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.closeContainer?.();
      const { openNotificationsOverlay } = await import('../notificationsOverlay/notificationsOverlay');
      void openNotificationsOverlay();
    });
    // Paint the unread pink dot onto this freshly-rendered row (the badge
    // module caches the count; this is a DOM sync, not a fetch).
    void import('../notificationsOverlay/notificationsOverlay')
      .then(({ applyNotificationsBadge }) => applyNotificationsBadge());
  }

  // Money: the any-page account/billing overlay (balance, tier, top-up, ledger).
  const moneyBtn = self.container.querySelector('#moneyBtn');
  if (moneyBtn) {
    moneyBtn.addEventListener('click', async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.closeContainer?.();
      const { openMoneyOverlay } = await import('../moneyOverlay/moneyOverlay');
      void openMoneyOverlay();
    });
  }

  // Commoner score ("hectares tilled") — PRIVATE own-view. Fill the line on
  // menu open; it stays hidden until a non-zero score loads (no "0 hectares"
  // to nag a user who hasn't earned any yet). Fire-and-forget — a failed read
  // just leaves the line hidden.
  const hectaresEl = self.container.querySelector('#commonerHectares');
  if (hectaresEl) {
    void (async () => {
      try {
        const res = await fetch('/api/me/commoner', {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        const data = await res.json().catch(() => null); // consumes the body (drain gate)
        if (!res.ok || !data) return;
        const hectares = Number(data.hectares) || 0;
        if (hectares <= 0) return;
        const accepted = Number(data.accepted) || 0;
        const liked = Number(data.liked) || 0;
        hectaresEl.innerHTML =
          `<span class="commoner-line">🌱 You've tilled <strong>${hectares}</strong> hectare${hectares === 1 ? '' : 's'} of the commons</span>`
          + `<span class="commoner-breakdown">${accepted} edit${accepted === 1 ? '' : 's'} accepted · ${liked} liked</span>`;
        hectaresEl.removeAttribute('hidden');
      } catch {
        /* cosmetic line — silent on failure */
      }
    })();
  }
}
