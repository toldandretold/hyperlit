/**
 * Converts a BibTeX entry into a formatted academic citation.
 * @param {string} bibtex - The BibTeX string.
 * @returns {string} - The formatted citation.
 */
export function formatBibtexToCitation(bibtex) {
  // Helper function to parse BibTeX fields
  const parseBibtex = (bibtex) => {
    const fields = {};
    const fieldRegex = /(\w+)\s*=\s*[{"]([^"}]+)[}"]/g;
    let match;
    while ((match = fieldRegex.exec(bibtex)) !== null) {
      fields[match[1]] = match[2];
    }
    return fields;
  };

  // Parse the BibTeX string
  const fields = parseBibtex(bibtex);

  // Extract relevant fields
  const author = fields.author || "Unknown Author";
  const title = fields.title || "Untitled";
  const journal = fields.journal || null;
  const publisher = fields.publisher || null;
  const year = fields.year || "Unknown Year";
  const pages = fields.pages || null;
  const url = fields.url || null;

  // Determine if it's an article or a book
  const isArticle = !!journal;

  // Format the title
  let formattedTitle = isArticle ? `"${title}"` : `<i>${title}</i>`;
  if (url) {
    formattedTitle = `<a href="${url}" target="_blank">${formattedTitle}</a>`;
  }

  // Format the publisher
  let formattedPublisher = publisher;
  if (isArticle && publisher) {
    formattedPublisher = `<i>${publisher}</i>`;
  }

  // Format the citation
  let citation = `${author}, ${formattedTitle}`;
  if (isArticle) {
    citation += `, ${journal}`;
  } else if (formattedPublisher) {
    citation += ` (${formattedPublisher}`;
    if (year) {
      citation += `, ${year}`;
    }
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



// Example usage
const bibtexExample = `@article{nicholls2024non,
  title={Non-aligned common front: strategic imaginaries of the new international economic order (NIEO)},
  author={Nicholls, Sam},
  journal={Development in Practice},
  pages={1--11},
  year={2024},
  publisher={Taylor \\& Francis}
}`;

console.log(formatBibtexToCitation(bibtexExample));

export function generateBibtexFromForm(data) {
  // Use the citation ID or generate a unique key
  const citationID = data.citation_id && data.citation_id.trim() !== ''
    ? data.citation_id.trim()
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
