/**
 * Reference Key Generator
 *
 * Generates lookup keys for bibliography references to enable matching with in-text citations.
 * Part of the modular paste processor system.
 *
 * Key Generation Strategy:
 * 1. Extract year (required)
 * 2. Extract author/surname
 * 3. Generate multiple key variations for flexible matching:
 *    - surname + year (e.g., "smith2020")
 *    - sorted surnames + year (for multi-author)
 *    - acronyms + year (e.g., "oup2020")
 *    - initials + year (e.g., "abc2020")
 *
 * @param {string} text - The reference text to generate keys from
 * @param {string} contextText - Additional context for author extraction
 * @param {string} formatType - Format identifier (e.g., 'oup', 'taylor-francis')
 * @returns {string[]} Array of generated keys
 */
export function generateReferenceKeys(text, contextText = '', formatType = 'general') {
  // Handle bracketed years by treating them as regular years for key generation
  const processedText = text.replace(/\[(\d{4})\]/g, ' $1 ');

  // Find year
  const yearMatch = processedText.match(/(\d{4}[a-z]?)/);
  if (!yearMatch) return [];

  const year = yearMatch[1];
  const authorsText = text.split(year)[0];

  const keys = [];
  const addKey = (key) => { if (key && !keys.includes(key)) keys.push(key); };

  const hasAuthor = /[a-zA-Z]/.test(authorsText);
  let authorSource = hasAuthor ? authorsText : contextText;

  // Taylor & Francis-specific handling: extract from citation IDs
  if (formatType === 'taylor-francis') {
    // For T&F, we often have citation patterns like "CIT0061" and years
    const tfCitationMatch = text.match(/CIT(\d+)/);
    if (tfCitationMatch && year) {
      const citationId = tfCitationMatch[1];
      addKey('cit' + citationId + year);
      addKey('citation' + citationId + year);
      console.log(`📚 T&F: Generated keys for citation ID ${citationId} with year ${year}`);
    }

    // Also try standard author extraction for T&F bibliography entries
    if (hasAuthor) {
      const tfAuthorMatch = authorsText.match(/([A-Z][a-zA-Z']+)/);
      if (tfAuthorMatch) {
        const surname = tfAuthorMatch[1];
        addKey(surname.toLowerCase() + year);
        console.log(`📚 T&F: Generated key "${surname.toLowerCase() + year}" from author`);
      }
    }
  }

  // OUP-specific handling: bibliography format is "Surname Firstname"
  if (formatType === 'oup' && hasAuthor) {
    // For OUP bibliography entries, extract surname first
    const oupMatch = authorsText.match(/^([A-Z][a-zA-Z'-]+)\s+([A-Z][a-zA-Z']+)/);
    if (oupMatch) {
      const [, surname, firstname] = oupMatch;
      // Create keys using just the surname (matches in-text citations)
      addKey(surname.toLowerCase() + year);
      console.log(`📚 OUP: Generated key "${surname.toLowerCase() + year}" from "${surname} ${firstname}"`);

      // Also add a key with both names for completeness
      addKey(surname.toLowerCase() + firstname.toLowerCase() + year);

      // IMPORTANT: Handle hyphenated surnames (e.g., "Mirza-Davies")
      // Add both hyphenated and non-hyphenated versions
      if (surname.includes('-')) {
        addKey(surname.toLowerCase().replace(/-/g, '') + year);
        console.log(`📚 OUP: Also generated non-hyphenated key "${surname.toLowerCase().replace(/-/g, '') + year}"`);
      }

      // Return early for OUP since we've handled it specially
      return keys;
    }
  }

  if (authorSource) {
    let sourceText = authorSource;

    // If no author in original text, use context to find it
    if (!hasAuthor && contextText) {
      const words = contextText.trim().split(/\s+/);
      const nameParts = [];
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i].replace(/,$/, ''); // Clean trailing comma
        // A word is part of a name if it's capitalized or a common particle.
        if (/^[A-Z]/.test(word) || /^(van|der|de|la|von)$/i.test(word)) {
          nameParts.unshift(word);
        } else {
          // We hit a non-name word, so stop.
          break;
        }
        // Stop after a reasonable number of words to avoid grabbing whole sentences.
        if (nameParts.length >= 4) break;
      }

      if (nameParts.length > 0) {
        sourceText = nameParts.join(' ');
      } else {
        // Fallback to original logic if new logic finds nothing.
        const candidates = sourceText.match(/\b[A-Z][a-zA-Z'-]+\b/g);
        if (candidates) sourceText = candidates[candidates.length - 1];
      }
    }

    // Handle acronyms first as they are specific
    const acronyms = sourceText.match(/\b[A-Z]{2,}\b/g) || [];
    acronyms.forEach(acronym => {
        addKey(acronym.toLowerCase() + year);
    });

    // Then handle regular names (including hyphenated surnames like "Mirza-Davies")
    // FIXED: Added hyphen to regex pattern [a-zA-Z'-]+ to properly match hyphenated surnames
    const surnames = (sourceText.match(/\b[A-Z][a-zA-Z'-]+\b/g) || [])
      .filter(s => !['And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'].includes(s))
      .filter(s => !acronyms.includes(s)) // Don't re-process acronyms as surnames
      .map(s => s.toLowerCase().replace("'s", ""));

    if (surnames.length > 0) {
      // Key 1: Sorted-concatenated (most consistent)
      // NOTE: This preserves hyphens, so "Mirza-Davies" stays as "mirza-davies" (not split)
      const sortedSurnames = [...surnames].sort();
      addKey(sortedSurnames.join('') + year);

      // Key 2: Concatenated as-is (for orgs like Black Panther)
      if (surnames.length > 1 && !sourceText.includes(',')) {
        addKey(surnames.join('') + year);
      }

      // Key 3: Primary surname
      if (sourceText.includes(',')) {
        addKey(surnames[0] + year); // "Last, First"
      } else if (surnames.length > 0) {
        addKey(surnames[surnames.length - 1] + year); // "First Last"
      }

      // Key 4: Non-hyphenated versions for flexibility
      // If any surname contains hyphens, also generate keys without them
      surnames.forEach(surname => {
        if (surname.includes('-')) {
          addKey(surname.replace(/-/g, '') + year);
        }
      });
    }

    // NEW: Always add an initials-based key for linking acronyms
    const initials = sourceText.match(/\b[A-Z]/g)?.join('');
    if (initials && initials.length >= 2) {
        addKey(initials.toLowerCase() + year);
    }
  }

  // Special cases
  if (text.includes('United Nations General Assembly')) {
    addKey('un' + year);
  }

  return keys;
}
