// Tiny DOM lookup helpers for the cite-form modules. Return `any` so the
// form's heavy, mostly-unguarded `getElementById(...).style/.value` access
// converts cleanly under strict TS (the form is global in the document once
// injected). Leaf module — no imports.
export const $ = (id: string): any => document.getElementById(id);
export const qs = (sel: string): any => document.querySelector(sel);
export const qsa = (sel: string): any => document.querySelectorAll(sel);
