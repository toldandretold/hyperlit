/**
 * Client-side metadata extraction for non-PDF file types.
 * Returns { title, author, year, publisher } with empty strings for missing fields.
 * All extraction is non-blocking — failures return empty metadata.
 */

let _JSZip = null;
async function loadJSZip() {
    if (_JSZip) return _JSZip;
    const mod = await import('https://cdn.skypack.dev/jszip');
    _JSZip = mod.default;
    return _JSZip;
}

/**
 * @param {File} file
 * @returns {Promise<{title: string, author: string, year: string, publisher: string}>}
 */
export async function extractFileMetadata(file) {
    const empty = { title: '', author: '', year: '', publisher: '' };
    try {
        const ext = file.name.split('.').pop().toLowerCase();
        let result;
        switch (ext) {
            case 'md':
                result = await extractMarkdown(file);
                break;
            case 'epub':
                result = await extractEpub(file);
                break;
            case 'docx':
                result = await extractDocx(file);
                break;
            case 'html':
            case 'htm':
                result = await extractHtml(file);
                break;
            default:
                return empty;
        }

        // Fallback: derive title from filename if extraction found nothing
        if (!result.title) {
            result.title = titleFromFilename(file.name);
        }

        return result;
    } catch (err) {
        console.warn('File metadata extraction failed (non-fatal):', err);
        return empty;
    }
}

function titleFromFilename(name) {
    // Strip extension, replace separators with spaces, trim
    return name.replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function extractMarkdown(file) {
    const text = await readFileSlice(file, 10 * 1024);
    const result = { title: '', author: '', year: '', publisher: '' };

    // Try YAML frontmatter
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
        const fm = fmMatch[1];
        result.title = yamlValue(fm, 'title');
        result.author = yamlValue(fm, 'author');
        const date = yamlValue(fm, 'date') || yamlValue(fm, 'year');
        const yearMatch = date.match(/(\d{4})/);
        if (yearMatch) result.year = yearMatch[1];
    }

    // Fallback: first # heading as title
    if (!result.title) {
        const headingMatch = text.match(/^#\s+(.+)$/m);
        if (headingMatch) result.title = headingMatch[1].trim();
    }

    return result;
}

function yamlValue(yaml, key) {
    const re = new RegExp('^' + key + '\\s*:\\s*["\']?(.+?)["\']?\\s*$', 'mi');
    const m = yaml.match(re);
    return m ? m[1].trim() : '';
}

async function extractEpub(file) {
    const result = { title: '', author: '', year: '', publisher: '' };
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);

    // Find OPF path from container.xml
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) return result;

    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/i)?.[1];
    if (!opfPath) return result;

    const opfXml = await zip.file(opfPath)?.async('text');
    if (!opfXml) return result;

    const parser = new DOMParser();
    const doc = parser.parseFromString(opfXml, 'application/xml');

    // Dublin Core metadata — try with and without namespace prefix
    result.title = dcText(doc, 'title');
    result.author = dcText(doc, 'creator');
    result.publisher = dcText(doc, 'publisher');

    const dateStr = dcText(doc, 'date');
    const yearMatch = dateStr.match(/(\d{4})/);
    if (yearMatch) result.year = yearMatch[1];

    // Fallback: first heading from the first content file in the spine
    if (!result.title) {
        result.title = await extractEpubFirstHeading(zip, doc, opfPath);
    }

    return result;
}

async function extractEpubFirstHeading(zip, opfDoc, opfPath) {
    // OPF base directory for resolving relative hrefs
    const opfDir = opfPath.includes('/') ? opfPath.replace(/\/[^/]+$/, '/') : '';

    // Build id→href map from <manifest>
    const manifest = {};
    const items = opfDoc.getElementsByTagNameNS('http://www.idpf.org/2007/opf', 'item');
    // Fallback: try without namespace (epub2)
    const itemList = items.length ? items : opfDoc.querySelectorAll('item');
    for (let i = 0; i < itemList.length; i++) {
        const item = itemList[i];
        const id = item.getAttribute('id');
        const href = item.getAttribute('href');
        const mediaType = item.getAttribute('media-type') || '';
        if (id && href && mediaType.includes('html')) {
            manifest[id] = opfDir + href;
        }
    }

    // Walk spine to find first content file
    const itemrefs = opfDoc.getElementsByTagNameNS('http://www.idpf.org/2007/opf', 'itemref');
    const itemrefList = itemrefs.length ? itemrefs : opfDoc.querySelectorAll('itemref');
    for (let i = 0; i < Math.min(itemrefList.length, 5); i++) {
        const idref = itemrefList[i].getAttribute('idref');
        const filePath = manifest[idref];
        if (!filePath) continue;

        const html = await zip.file(filePath)?.async('text');
        if (!html) continue;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        for (const tag of ['h1', 'h2', 'h3']) {
            const el = doc.querySelector(tag);
            const text = el?.textContent?.trim();
            if (text) return text;
        }
    }
    return '';
}

function dcText(doc, localName) {
    // Try namespaced lookup first
    let el = doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', localName)[0];
    // Fallback to prefixed tag name
    if (!el) el = doc.querySelector(`dc\\:${localName}, ${localName}`);
    return el?.textContent?.trim() || '';
}

async function extractDocx(file) {
    const result = { title: '', author: '', year: '', publisher: '' };
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);

    // Dublin Core metadata from docProps/core.xml
    const coreXml = await zip.file('docProps/core.xml')?.async('text');
    if (coreXml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(coreXml, 'application/xml');

        result.title = dcText(doc, 'title');
        result.author = dcText(doc, 'creator');
        // Note: dcterms:created is the file creation date, not publication year — skip it
    }

    // Fallback: first heading from word/document.xml (Word rarely fills dc:title)
    if (!result.title) {
        result.title = await extractDocxFirstHeading(zip);
    }

    return result;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function extractDocxFirstHeading(zip) {
    const docXml = await zip.file('word/document.xml')?.async('text');
    if (!docXml) return '';

    const parser = new DOMParser();
    const doc = parser.parseFromString(docXml, 'application/xml');

    // Find paragraphs with heading styles (Heading1, Heading2, Title, etc.)
    const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');
    for (let i = 0; i < Math.min(paragraphs.length, 30); i++) {
        const p = paragraphs[i];
        const pStyle = p.getElementsByTagNameNS(W_NS, 'pStyle')[0];
        const styleVal = pStyle?.getAttribute('w:val') || '';
        if (/^(Heading1|Heading2|Title|Subtitle)/i.test(styleVal)) {
            const runs = p.getElementsByTagNameNS(W_NS, 't');
            let text = '';
            for (let j = 0; j < runs.length; j++) {
                text += runs[j].textContent || '';
            }
            text = text.trim();
            if (text) return text;
        }
    }
    return '';
}

async function extractHtml(file) {
    const text = await readFileSlice(file, 20 * 1024);
    const result = { title: '', author: '', year: '', publisher: '' };

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');

    result.title = doc.querySelector('title')?.textContent?.trim() || '';
    result.author = doc.querySelector('meta[name="author"]')?.getAttribute('content')?.trim() || '';

    const dateContent = doc.querySelector('meta[name="date"]')?.getAttribute('content')?.trim() || '';
    const yearMatch = dateContent.match(/(\d{4})/);
    if (yearMatch) result.year = yearMatch[1];

    // Fallback: first h1 as title
    if (!result.title) {
        result.title = doc.querySelector('h1')?.textContent?.trim() || '';
    }

    return result;
}

function readFileSlice(file, maxBytes) {
    const slice = file.slice(0, maxBytes);
    return slice.text();
}
