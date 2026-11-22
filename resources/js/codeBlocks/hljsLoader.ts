/**
 * Lazy highlight.js loader. Only books that actually render a <pre> pay for the
 * highlighter: the core + grammars are a dynamic import, fetched once and
 * memoised. Grammar ids registered here must match codeBlocks/language.ts.
 */
import type { HLJSApi, LanguageFn } from 'highlight.js';

let loading: Promise<HLJSApi> | null = null;
let loaded: HLJSApi | null = null;

/** Synchronous access once loaded (null before) — lets a re-render colour without a flash. */
export function getLoadedHighlighter(): HLJSApi | null {
  return loaded;
}

export function loadHighlighter(): Promise<HLJSApi> {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  loading = (async () => {
    const [core, ...langs] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/r'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/shell'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/php'),
      import('highlight.js/lib/languages/java'),
      import('highlight.js/lib/languages/c'),
      import('highlight.js/lib/languages/cpp'),
      import('highlight.js/lib/languages/go'),
      import('highlight.js/lib/languages/rust'),
      import('highlight.js/lib/languages/ruby'),
      import('highlight.js/lib/languages/latex'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/diff'),
      import('highlight.js/lib/languages/plaintext'),
    ]);
    const ids = REGISTERED_LANGUAGE_IDS;
    const hljs = core.default;
    // We never let hljs touch the DOM itself (we only read its escaped output),
    // so silence its "unescaped HTML" console warning path entirely.
    hljs.configure({ ignoreUnescapedHTML: true, throwUnescapedHTML: false });
    langs.forEach((mod, i) => {
      hljs.registerLanguage(ids[i]!, (mod as { default: LanguageFn }).default);
    });
    loaded = hljs;
    return hljs;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Ids registered by {@link loadHighlighter} (pinned against language.ts by a test). */
export const REGISTERED_LANGUAGE_IDS = [
  'python', 'javascript', 'typescript', 'r', 'bash', 'shell', 'sql', 'json', 'yaml',
  'xml', 'css', 'php', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'latex', 'markdown',
  'diff', 'plaintext',
] as const;
