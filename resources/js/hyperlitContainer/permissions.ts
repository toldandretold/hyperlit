/**
 * checkIfUserHasAnyEditPermission — does the user have edit rights on ANY present item?
 * (drives whether the edit button shows). Thin orchestrator: resolve the auth identity once,
 * then ask each present type's handler. Lives outside index.ts so history.ts imports it here —
 * breaking the index↔history cycle.
 */
import { getAuthContextSync, getAuthContext } from '../utilities/auth.js';
import { getHandler } from './contentTypes/registry';

export async function checkIfUserHasAnyEditPermission(contentTypes: any, newHighlightIds: any = [], db: any = null) {
  const auth = getAuthContextSync() || await getAuthContext();
  const { user: currentUser, userId: currentUserId } = auth;
  const ctx = { newHighlightIds, db, currentUser, currentUserId };

  for (const ct of contentTypes) {
    const handler = getHandler(ct.type);
    if (handler?.checkPermission && await handler.checkPermission(ct, ctx)) {
      return true;
    }
  }

  // Note: hypercites/citations are intentionally NOT editable here — the edit button
  // shows only when there's editable content (footnotes or owned highlights).
  return false;
}
