// Open the login form in the user container — the shared "you must log in to do
// this" affordance, mirroring the import flow (citeForm/submission.ts). Used by
// gated actions (AI review, harvest) so an anonymous click lands on login
// rather than silently failing.
export async function promptLogin(): Promise<void> {
  const { initializeUserContainer } = await import('../../components/userButton/userButton');
  const mgr: any = initializeUserContainer();
  if (mgr?.showLoginForm) mgr.showLoginForm();
}

// Open the register form. The register screen carries its own "log in instead"
// link (#showLogin), so this is the single entry point for "you need an account".
export async function promptRegister(): Promise<void> {
  const { initializeUserContainer } = await import('../../components/userButton/userButton');
  const mgr: any = initializeUserContainer();
  if (mgr?.showRegisterForm) mgr.showRegisterForm();
}

// Open the user panel's verify-email screen (resend link + change-email live
// there — components/userContainer/email.ts). Used by the publish gate when a
// logged-in but unverified account tries to make a book public.
export async function promptVerifyEmail(): Promise<void> {
  const { initializeUserContainer } = await import('../../components/userButton/userButton');
  const mgr: any = initializeUserContainer();
  if (mgr?.showVerifyEmailScreen) mgr.showVerifyEmailScreen();
}
