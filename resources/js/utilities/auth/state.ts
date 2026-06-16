// auth/state.ts — zero-import leaf holding the shared mutable auth state.
// session / permissions / crossTab all read+write through this single object so
// they stay in sync without importing each other's module-level `let`s (which
// would create cycles). Mutating a property here is equivalent to the old
// module-level reassignment — every reader sees the latest value.

export const authState: any = {
  currentUserInfo: null,
  anonymousToken: null,
  authInitialized: false,
  initializeAuthPromise: null,
};

// Cache for canUserEditBook results to avoid repeated async checks
export const editPermissionCache = new Map<string, boolean>();
