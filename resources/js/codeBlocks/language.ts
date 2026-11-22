/**
 * Code-block language vocabulary — ZERO-IMPORT LEAF.
 *
 * A code block's language is CONTENT: it is stored as `class="language-x"` on
 * the `<code>` element (the markdown/marked + publisher-HTML convention, which
 * the import sanitiser already lets through). Everything else about a code
 * block's presentation (token colours, the header bar) is render-time only.
 *
 * Because the class is content that arrives from untrusted places (paste,
 * import, sync), it is validated against {@link LANGUAGE_CLASS_RE}: a crafted
 * class can neither smuggle arbitrary CSS hooks onto the element nor carry
 * attribute-breaking characters. Anything that fails is dropped, never kept.
 */

/** The ONLY accepted shape for a stored language class. */
export const LANGUAGE_CLASS_RE = /^language-[a-z0-9+#-]{1,30}$/;

/** Same shape for the `lang-x` alias some highlighters/publishers emit. */
const LANG_ALIAS_CLASS_RE = /^lang-[a-z0-9+#-]{1,30}$/;

export interface CodeLanguage {
  /** highlight.js grammar id (registered by hljsLoader). */
  id: string;
  /** Human label shown in the header. */
  label: string;
  /** Extra names a fence / class might use. */
  aliases: string[];
}

/**
 * The languages Hyperlit knows how to colour. Ordered for the picker menu
 * (most common in scholarly/technical writing first). Every `id` here MUST be
 * registered in hljsLoader.ts (a unit test pins this).
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'python', label: 'Python', aliases: ['py', 'python3', 'gyp'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs', 'node'] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'r', label: 'R', aliases: ['rlang', 'rscript'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'zsh', 'shell-script'] },
  { id: 'shell', label: 'Shell session', aliases: ['console', 'shellsession', 'terminal'] },
  { id: 'sql', label: 'SQL', aliases: ['postgres', 'postgresql', 'mysql', 'sqlite', 'plsql'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc', 'json5'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'xml', label: 'HTML / XML', aliases: ['html', 'xhtml', 'svg', 'rss', 'atom', 'xsl', 'plist', 'vue'] },
  { id: 'css', label: 'CSS', aliases: ['scss', 'less'] },
  { id: 'php', label: 'PHP', aliases: ['php3', 'php4', 'php5', 'php7', 'php8', 'blade'] },
  { id: 'java', label: 'Java', aliases: ['jsp'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb', 'gemspec', 'podspec'] },
  { id: 'latex', label: 'LaTeX', aliases: ['tex'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mkdown', 'mkd'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'plaintext', label: 'Plain text', aliases: ['text', 'txt', 'plain'] },
];

const BY_NAME: Map<string, CodeLanguage> = (() => {
  const m = new Map<string, CodeLanguage>();
  for (const lang of CODE_LANGUAGES) {
    m.set(lang.id, lang);
    for (const a of lang.aliases) m.set(a, lang);
  }
  return m;
})();

/** Resolve any name/alias ("py", "Python", "language-js") to a known language. */
export function resolveLanguage(raw: string | null | undefined): CodeLanguage | null {
  if (!raw) return null;
  const name = raw.trim().toLowerCase().replace(/^(language|lang)-/, '');
  return BY_NAME.get(name) ?? null;
}

/**
 * The language a code element DECLARES via its class (on `<code>` first, then
 * its `<pre>`), after validation. Returns the raw declared name too, so a
 * syntactically valid but unknown language ("language-haskell") can still be
 * labelled honestly even though we can't colour it.
 */
export function declaredLanguage(el: Element | null): { name: string; lang: CodeLanguage | null } | null {
  let cur: Element | null = el;
  for (let i = 0; i < 2 && cur; i++) {
    for (const cls of Array.from(cur.classList)) {
      if (LANGUAGE_CLASS_RE.test(cls) || LANG_ALIAS_CLASS_RE.test(cls)) {
        const name = cls.replace(/^(language|lang)-/, '');
        return { name, lang: resolveLanguage(name) };
      }
    }
    cur = cur.parentElement && cur.parentElement.tagName === 'PRE' ? cur.parentElement : null;
  }
  return null;
}

/**
 * Drop every language-ish class token that fails validation (`language-…` /
 * `lang-…` with characters outside the allowed set, or over-long). Returns true
 * if anything was removed. Used on paste and before decoration.
 */
export function sanitizeLanguageClasses(el: Element): boolean {
  let changed = false;
  for (const cls of Array.from(el.classList)) {
    const looksLikeLang = /^(language|lang)-/i.test(cls);
    if (!looksLikeLang) continue;
    if (!LANGUAGE_CLASS_RE.test(cls) && !LANG_ALIAS_CLASS_RE.test(cls)) {
      el.classList.remove(cls);
      changed = true;
    }
  }
  if (el.getAttribute('class') === '') el.removeAttribute('class');
  return changed;
}

/** Canonical stored class for a language id, or null if it would not validate. */
export function languageClassFor(id: string): string | null {
  const cls = `language-${id.toLowerCase()}`;
  return LANGUAGE_CLASS_RE.test(cls) ? cls : null;
}

/** Title-case an unknown-but-valid declared name for display ("haskell" → "Haskell"). */
export function displayNameFor(name: string): string {
  const known = resolveLanguage(name);
  if (known) return known.label;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
