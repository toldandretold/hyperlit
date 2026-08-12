{{-- Shared inline styles for the /j journal pages. Inline (not a vite entry)
     because these are two small server-rendered pages; theme classes mirror
     the reader's hyperlit_theme_preference (set before paint in each view). --}}
<style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.55; }
    body.theme-dark { background: #121212; color: #e4e4e4; }
    body.theme-light { background: #fdfdfc; color: #1c1c1c; }
    body.theme-sepia { background: #f4ecd8; color: #3a3226; }
    .jp-page { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    .jp-page a { color: #4eacae; text-decoration: none; }
    .jp-page a:hover { text-decoration: underline; }
    .jp-breadcrumb { font-size: .85rem; opacity: .75; margin-bottom: 1.5rem; }
    .jp-header h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
    .jp-meta, .jp-counts { font-size: .9rem; opacity: .85; margin: .25rem 0; }
    .jp-meta span, .jp-meta a { margin-right: .9rem; }
    .jp-diamond { color: #4eacae; font-weight: 600; }
    .jp-works { margin-top: 2rem; padding-left: 2.2rem; }
    .jp-works li { margin: 0 0 .9rem; }
    .jp-title { font-weight: 600; }
    .jp-unreadable { opacity: .65; }
    .jp-work-meta { display: block; font-size: .82rem; opacity: .75; }
    .jp-unreviewed { opacity: .65; font-style: italic; }
    .jp-empty { list-style: none; opacity: .75; }
    .jp-pagination { display: flex; gap: 1.5rem; margin-top: 2rem; font-size: .9rem; }
</style>
