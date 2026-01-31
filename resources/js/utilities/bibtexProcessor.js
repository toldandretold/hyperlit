import { getCurrentUserId } from "./auth.js";

/**
 * Converts a BibTeX entry into a formatted academic citation.
 * @param {string} bibtex - The BibTeX string.
 * @returns {Promise<string>} - The formatted citation.
 */
export async function formatBibtexToCitation(bibtex) {
  // Helper to pull out all key = { value } or "value" pairs
  const parseBibtex = (bibtex) => {
    const fields = {};
    const fieldRegex = /(\w+)\s*=\s*[{"]([^"}]+)[}"]/g;
    let match;
    while ((match = fieldRegex.exec(bibtex)) !== null) {
      fields[match[1]] = match[2];
    }
    return fields;
  };

  // Pull out all fields
  const fields = parseBibtex(bibtex);
  console.log("🔍 Parsed BibTeX fields:", fields);
  const rawAuthor = fields.author || "";
  const currentUserId = await getCurrentUserId();

  // Decide what to show for author
  let author;
  if (rawAuthor === currentUserId && /^[0-9a-fA-F-]{36}$/.test(rawAuthor)) {
    // Anonymous user viewing their own work
    author = "Anon (me)";
  } else if (/^[0-9a-fA-F-]{36}$/.test(rawAuthor)) {
    // Someone else's anonymous work
    author = "Anon";
  } else {
    // Real username or unknown
    author = rawAuthor || "Unknown Author";
  }

  // Grab the rest of your fields with defaults
  const title = fields.title || "Untitled";
  const journal = fields.journal || null;
  const publisher = fields.publisher || null;
  const year = fields.year || "Unknown Year";
  const pages = fields.pages || null;
  const url = fields.url || null;
  const volume = fields.volume || null;
  const issue = fields.number || null; // BibTeX uses "number" for issue
  const booktitle = fields.booktitle || null;
  const chapter = fields.chapter || null;
  const editor = fields.editor || null;

  // Parse the declared entry type from the BibTeX string (e.g. @article, @incollection)
  const typeMatch = bibtex.match(/@(\w+)\s*\{/);
  const entryType = typeMatch ? typeMatch[1].toLowerCase() : 'misc';
  const isArticle = entryType === 'article';
  const isChapter = entryType === 'incollection';

  // Title formatting: quotes for articles/chapters, italics for books
  let formattedTitle = (isArticle || isChapter) ? `"${title}"` : `<i>${title}</i>`;
  console.log("🔗 URL found in BibTeX:", url);
  if (url) {
    formattedTitle = `<a href="${url}" target="_blank">${formattedTitle}</a>`;
    console.log("✅ Title formatted with link:", formattedTitle);
  } else {
    console.log("❌ No URL found, title will not be linked");
  }

  // Build the final citation
  let citation = `${author}, ${formattedTitle}`;

  if (isChapter) {
    // Chapter in a book: Author, "Chapter Title" in *Book Title*, vol. X (ed. Editor, Publisher, Year), pages.
    citation += ` in <i>${booktitle}</i>`;
    if (volume) {
      citation += `, vol. ${volume}`;
      if (issue) citation += `(${issue})`;
    }
    const parenthetical = [];
    if (editor) parenthetical.push(`ed. ${editor}`);
    if (publisher) parenthetical.push(publisher);
    if (year) parenthetical.push(year);
    if (parenthetical.length > 0) {
      citation += ` (${parenthetical.join(', ')})`;
    }
    if (pages) citation += `, ${pages}`;
  } else if (isArticle) {
    // Article: Author, "Title" Journal, vol(issue) (year), pages.
    if (journal) citation += `, ${journal}`;
    if (volume) {
      citation += `, ${volume}`;
      if (issue) citation += `(${issue})`;
    }
    if (year) citation += ` (${year})`;
    if (pages) citation += `, ${pages}`;
  } else {
    // Book or other: Author, *Title* (Publisher, Year), pages.
    let formattedPublisher = publisher;
    if (formattedPublisher) {
      citation += ` (${formattedPublisher}`;
      if (year) citation += `, ${year}`;
      citation += `)`;
    } else if (year) {
      citation += ` (${year})`;
    }
    if (pages) citation += `, ${pages}`;
  }

  citation += ".";

  return citation;
}



export function generateBibtexFromForm(data) {
  // Use the book ID as the citation key (book is the primary key)
  const citationID = data.book && data.book.trim() !== ''
    ? data.book.trim()
    : 'citation' + Date.now();

  // Use the type or default to misc
  const type = data.type || 'misc';

  // Helper to escape special characters in BibTeX fields
  function escapeBibtex(value) {
    if (!value) return '';
    return value.replace(/[{}]/g, '\\$&'); // escape braces
  }

  // Define which fields are relevant for each BibTeX type
  const typeFields = {
    article:       ['author', 'title', 'journal', 'year', 'volume', 'issue', 'pages', 'url', 'note'],
    book:          ['author', 'title', 'publisher', 'year', 'pages', 'url', 'note'],
    incollection:  ['author', 'title', 'booktitle', 'editor', 'publisher', 'year', 'chapter', 'volume', 'issue', 'pages', 'url', 'note'],
    phdthesis:     ['author', 'title', 'school', 'year', 'url', 'note'],
    misc:          ['author', 'title', 'year', 'url', 'note'],
  };
  const allowedFields = typeFields[type] || typeFields.misc;

  // Map from form field names to BibTeX field names
  const bibtexFieldName = (field) => field === 'issue' ? 'number' : field;

  // Build the BibTeX entry lines — only include fields relevant to the type
  let bibtexLines = [`@${type}{${citationID},`];

  for (const field of allowedFields) {
    if (data[field]) {
      bibtexLines.push(`  ${bibtexFieldName(field)} = {${escapeBibtex(data[field])}},`);
    }
  }

  // Remove trailing comma from last field
  if (bibtexLines.length > 1) {
    const lastIndex = bibtexLines.length - 1;
    bibtexLines[lastIndex] = bibtexLines[lastIndex].replace(/,$/, '');
  }

  bibtexLines.push('}');
  const generatedBibtex = bibtexLines.join('\n');
  console.log("Generated BibTeX:", generatedBibtex);
  return generatedBibtex;
}

export function buildBibtexEntry({ book, title, author }) {
  // Use book ID as citation key (book is the primary key)
  // Here we store the *raw* author ID field in the bibtex.
  return `@book{${book},
  author = {${author}},
  title  = {${title}},
  year   = {${new Date().getFullYear()}},
}`;
}
