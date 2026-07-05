// Zero-import leaf: THE encrypted-padlock icon — the private padlock with three
// asterisks scrawled across its body, signalling the content itself is scrambled
// (E2EE). This is the single source for every place the app marks encryption
// (visibility control, unlock modal, passkey list, locked cards, import toggle) —
// never use the 🔒/🔐 emoji for E2EE UI. Asterisk glyphs sit high in most fonts,
// so the baseline y is dropped to ~20 to land them on the body midline.
// NB: app/Services/LibraryCardGenerator.php carries a PHP copy of this markup
// for server-rendered encrypted cards — keep them visually in sync.
export function encryptedLockSvg(size = 20, style = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${style ? ` style="${style}"` : ''}>
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  <text x="7.5" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text>
  <text x="12" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text>
  <text x="16.5" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text>
</svg>`;
}
