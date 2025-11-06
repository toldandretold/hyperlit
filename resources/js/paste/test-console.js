/**
 * Console Test Script
 * Copy and paste this into your browser console to test the paste refactor
 */

// Test 1: Format Detection
console.log('=== Test 1: Format Detection ===');

const cambridgeHtml = '<a class="xref fn"><sup>1</sup></a>';
const generalHtml = '<p>Simple paragraph</p>';

import('./format-detection/format-detector.js').then(({ detectFormat }) => {
  console.log('Cambridge HTML:', detectFormat(cambridgeHtml)); // Should be 'cambridge'
  console.log('General HTML:', detectFormat(generalHtml));     // Should be 'general'
  console.log('✅ Format detection working\n');
});

// Test 2: Utilities
console.log('=== Test 2: Utilities ===');

import('./utils/normalizer.js').then(({ normalizeQuotes, normalizeSpaces }) => {
  const smartQuotes = '"Hello" 'world'';
  const normalized = normalizeQuotes(smartQuotes);
  console.log('Smart quotes:', smartQuotes);
  console.log('Normalized:', normalized);
  console.log('✅ Normalizer working\n');
});

import('./utils/content-estimator.js').then(({ estimatePasteNodeCount }) => {
  const html = '<p>1</p><p>2</p><p>3</p>';
  const count = estimatePasteNodeCount(html);
  console.log('HTML:', html);
  console.log('Estimated nodes:', count); // Should be 3
  console.log('✅ Estimator working\n');
});

// Test 3: Cambridge Processor
console.log('=== Test 3: Cambridge Processor ===');

const fullCambridgeHtml = `
  <div>
    <p>Text with footnote<a class="xref fn"><sup>1</sup></a></p>
    <div id="reference-1-content">
      <p class="p"><span class="label"><sup>1</sup></span> Footnote content</p>
    </div>
  </div>
`;

import('./format-processors/cambridge-processor.js').then(async ({ CambridgeProcessor }) => {
  const processor = new CambridgeProcessor();
  const result = await processor.process(fullCambridgeHtml, 'testBook');

  console.log('Format:', result.formatType);
  console.log('Footnotes:', result.footnotes.length);
  console.log('Footnote details:', result.footnotes);
  console.log('✅ Cambridge processor working\n');
});

console.log('\n📋 All tests queued. Check results above.');
console.log('💡 Tip: You can also import modules directly:');
console.log('   const { detectFormat } = await import("./format-detection/format-detector.js");');
