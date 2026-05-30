# Clipboard fixtures

Real `text/html` clipboard payloads captured from publisher article pages, used
as deterministic regression fixtures for the paste format-processors.

## Why clipboard payloads, not rendered pages

`curl https://cambridge.org/...` fetches the full HTML page (JS-rendered shell,
paywall, cookie banner, navigation). That's *not* what
`event.clipboardData.getData("text/html")` receives when a user copies article
text. The clipboard payload is a much smaller, cleaner fragment of the article
DOM — the exact input the format processors see in production.

Capturing the clipboard payload means the fixtures stay stable even when the
publisher redesigns their site, and tests run instantly with no network.

## How to capture a new fixture

1. Open the publisher article in a browser.
2. Select all article content (Cmd+A is fine — the format processors are
   supposed to handle whatever the page gives you).
3. Cmd+C / Ctrl+C.
4. Open the capture tool. From the repo root, run:

   ```
   open resources/paste-capture.html
   ```

   It loads as a local `file://` page in your default browser — no dev server
   needed. (Don't paste the path into Safari's address bar; Safari will
   Google it. Use `open` from Terminal, or double-click the file in Finder.)

5. Click the dashed drop zone and paste (Cmd+V / Ctrl+V).
6. The page shows the detected format and content stats. Sanity-check that
   "Paragraphs" or "Elements" is non-trivial — some publishers use `<div>`
   or `<span>` for body text instead of `<p>`, so a low `<p>` count is not
   necessarily a bad capture.
7. The filename is auto-suggested as `<format>-<slug>.html`. Click
   **Download** and move the file into this directory.

## Naming convention

```
<publisher>-<short-slug>.html
```

| publisher prefix | source                          |
|------------------|---------------------------------|
| `cambridge-`     | cambridge.org/core              |
| `oup-`           | academic.oup.com                |
| `tandf-`         | tandfonline.com                 |
| `sciencedirect-` | sciencedirect.com               |
| `sage-`          | journals.sagepub.com            |
| `springer-fn-`   | Springer (footnote style)       |
| `springer-ad-`   | Springer (author-date style)    |

## Reference URLs used to seed this corpus

- OUP: https://academic.oup.com/cje/article/44/2/319/5550923
- Cambridge: https://www.cambridge.org/core/journals/historical-journal/article/contemporary-parliamentary-history-and-petitioners-in-the-long-parliament-c-16401642/59059B25E4588F8B53A17DC847F69B39
- Taylor & Francis: https://www.tandfonline.com/doi/full/10.1080/09614524.2024.2400160
- ScienceDirect: https://www.sciencedirect.com/science/article/pii/S0962629825001209
- Sage: https://journals.sagepub.com/doi/10.1177/00323292251375901
- Sage: https://journals.sagepub.com/doi/10.1177/02633957251384867
- Springer (footnotes): https://link.springer.com/article/10.1007/s40319-024-01479-z
- Springer (author-date): https://link.springer.com/article/10.1007/s44382-025-00004-1
