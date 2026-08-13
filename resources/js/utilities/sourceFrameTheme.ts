/**
 * Theme a maintainer "original source" iframe to match the app.
 *
 * The source panes on /maintainer/conversion and /maintainer/journal-import render a RAW fetched
 * publisher page. Its own stylesheets are absolute URLs that mostly don't resolve here, so the
 * document paints no background and its text falls back to the UA's near-black — black on our
 * dark canvas, unreadable. Forcing the pane light fixed the reading but left a white slab beside
 * a dark reader, which is worse to sit in front of all day.
 *
 * The frame is SAME-ORIGIN (we stream the file from our own endpoint), so the honest fix is to
 * inject a stylesheet into it and paint it in the operator's current theme. Colours are read from
 * the parent's live custom properties rather than hard-coded, so dark / light / sepia all follow
 * automatically and a theme change needs no work here.
 *
 * Fidelity is deliberately not the goal: this pane exists to READ what we fetched, and the
 * publisher's real design is a browser tab away via `open ↗`. Returns false when it could not
 * skin the document (a PDF, or anything without a body) so the caller can fall back to a light
 * canvas — a PDF viewer paints its own background and is unaffected either way.
 */

const STYLE_ID = 'hyperlit-source-theme';

/**
 * Read a custom property off the host page, with a fallback for the unthemed case.
 *
 * Off BODY, not documentElement: the theme classes (`theme-dark` / `theme-light` / `theme-sepia`)
 * are set on `<body>`, so the light and sepia overrides only exist below it — reading from the
 * root returns the dark defaults and every theme comes out looking dark.
 */
function themeValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function buildCss(): string {
  const background = themeValue('--color-background', '#221f20');
  const text = themeValue('--color-text', '#cbcccc');
  const link = themeValue('--color-link', '#4eacae');
  const faint = themeValue('--color-text-faint', '#888');

  // `!important` throughout: publisher markup carries inline colours and bgcolor attributes, and
  // whichever of its stylesheets DO resolve would otherwise win on specificity.
  return `
    html, body {
      background: ${background} !important;
      color: ${text} !important;
    }
    /* Strip the page's own panels so nothing paints a white slab over the themed canvas. */
    div, section, article, aside, header, footer, nav, main, ul, ol, li, dl, dt, dd,
    p, span, td, th, table, tbody, thead, tr, figure, figcaption, blockquote, form, label {
      background-color: transparent !important;
      color: inherit !important;
      border-color: ${faint} !important;
    }
    h1, h2, h3, h4, h5, h6 { color: ${text} !important; }
    a, a:visited { color: ${link} !important; }
    pre, code, kbd, samp {
      background-color: color-mix(in srgb, ${text} 10%, transparent) !important;
      color: ${text} !important;
    }
    input, textarea, select, button {
      background-color: color-mix(in srgb, ${text} 8%, transparent) !important;
      color: ${text} !important;
      border: 1px solid ${faint} !important;
    }
    hr { border-color: ${faint} !important; }
    /* Images and figures keep their own colours — they ARE the fetched content. */
    img, svg, video, canvas { background: transparent !important; }
  `;
}

/**
 * Is this source a text document we may restyle, or a PDF/binary we must leave alone?
 *
 * Decided from the artifacts we KNOW are on disk, never from the loaded document: WebKit hands
 * its PDF viewer a real `body`, so "does it have a body" happily reports a PDF as skinnable and
 * we end up injecting a stylesheet into the viewer. The endpoint's own priority order is
 * pdf → html → md → binary, so a lane with an `original.pdf` is serving that and nothing else.
 */
export function sourceIsSkinnable(artifacts: string[]): boolean {
  if (artifacts.includes('original.pdf')) {
    return false;
  }

  return artifacts.some(
    (a) => a === 'original.html' || a === 'original.md' || a === 'fetched_page.html' || a === 'pasted_page.html',
  );
}

/**
 * Inject (or refresh) the theme stylesheet inside a same-origin source iframe.
 *
 * @returns true when the document was skinned; false when it can't be (no body / blocked).
 */
export function applySourceFrameTheme(frame: HTMLIFrameElement): boolean {
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    return false; // cross-origin — nothing we can do, and nothing we should try
  }

  if (!doc || !doc.body || !doc.head) {
    return false;
  }

  try {
    doc.getElementById(STYLE_ID)?.remove();
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = buildCss();
    doc.head.appendChild(style);
    // Keeps the frame's own scrollbars and form controls in the right register.
    doc.documentElement.style.colorScheme = isLightTheme() ? 'light' : 'dark';

    return true;
  } catch {
    return false;
  }
}

/** Light and sepia are light-ish; everything else is treated as dark. */
function isLightTheme(): boolean {
  const cls = document.body.className;

  return cls.includes('theme-light') || cls.includes('theme-sepia');
}
