// Open the login form in the user container — the shared "you must log in to do
// this" affordance, mirroring the import flow (citeForm/submission.ts). Used by
// gated actions (AI review, harvest) so an anonymous click lands on login
// rather than silently failing.
export async function promptLogin(): Promise<void> {
  const { initializeUserContainer } = await import('../../components/userButton/userButton');
  const mgr: any = initializeUserContainer();
  if (mgr?.showLoginForm) mgr.showLoginForm();
}
