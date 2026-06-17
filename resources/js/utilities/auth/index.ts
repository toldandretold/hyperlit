// auth/ — public barrel. Re-exports the full auth API (formerly utilities/auth.js):
//   ./state       shared mutable state leaf
//   ./csrf        XSRF token read + ensure-before-stateful-request
//   ./session     init / identity / CSRF / login-logout state
//   ./permissions canUserEditBook + permission cache
//   ./crossTab    logout + cross-tab/same-tab BroadcastChannel sync
export * from './csrf';
export * from './session';
export * from './permissions';
export * from './crossTab';
