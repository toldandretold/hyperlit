// profile.ts - Logged-in profile view for the user container: renders the
// profile (My Library / Verify Email / Logout) and wires its button listeners
// (with hover styling). Takes the UserContainerManager as `self`.
import { getProfileHTML } from './forms';

export function showUserProfile(self: any) {
  const emailVerified = self.user?.email_verified_at !== null && self.user?.email_verified_at !== undefined;
  self.container.innerHTML = getProfileHTML(emailVerified);

  if (!self.isOpen) {
    self.openContainer("profile");
  } else {
    self.container.style.width = "160px"; /* keep in sync with dimensions.profile */
  }

  // Attach button listeners
  self.attachProfileButtonListeners();
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
}
