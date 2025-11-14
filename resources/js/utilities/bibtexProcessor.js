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

  // Article vs. book
  const isArticle = Boolean(journal);

  // Title formatting (quotes for articles, italics for books)
  let formattedTitle = isArticle ? `"${title}"` : `<i>${title}</i>`;
  console.log("🔗 URL found in BibTeX:", url);
  if (url) {
    formattedTitle = `<a href="${url}" target="_blank">${formattedTitle}</a>`;
    console.log("✅ Title formatted with link:", formattedTitle);
  } else {
    console.log("❌ No URL found, title will not be linked");
  }

  // Publisher italics for articles
  let formattedPublisher = publisher;
  if (isArticle && publisher) {
    formattedPublisher = `<i>${publisher}</i>`;
  }

  // Build the final citation
  let citation = `${author}, ${formattedTitle}`;
  if (isArticle) {
    citation += `, ${journal}`;
  } else if (formattedPublisher) {
    citation += ` (${formattedPublisher}`;
    if (year) citation += `, ${year}`;
    citation += `)`;
  } else if (year) {
    citation += ` (${year})`;
  }

  if (pages) {
    citation += `, ${pages}`;
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

  // Build the BibTeX entry lines
  let bibtexLines = [`@${type}{${citationID},`];

  // Add fields if they exist
  if (data.author) bibtexLines.push(`  author = {${escapeBibtex(data.author)}},`);
  if (data.title) bibtexLines.push(`  title = {${escapeBibtex(data.title)}},`);
  if (data.journal) bibtexLines.push(`  journal = {${escapeBibtex(data.journal)}},`);
  if (data.publisher) bibtexLines.push(`  publisher = {${escapeBibtex(data.publisher)}},`);
  if (data.year) bibtexLines.push(`  year = {${escapeBibtex(data.year)}},`);
  if (data.pages) bibtexLines.push(`  pages = {${escapeBibtex(data.pages)}},`);
  if (data.school) bibtexLines.push(`  school = {${escapeBibtex(data.school)}},`);
  if (data.note) bibtexLines.push(`  note = {${escapeBibtex(data.note)}},`);
  if (data.url) bibtexLines.push(`  url = {${escapeBibtex(data.url)}},`);

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
