/**
 * Plain-text code with no fence becomes ONE code block of the exact text —
 * before the markdown path reads `# comments` as headings (it ate the "#" and
 * split the program into paragraphs). Prose, notes and real markdown must NOT
 * be captured: prose pasted as code is worse than code pasted as prose.
 */
import { describe, it, expect } from 'vitest';
import { plainTextAsCode } from '../../../resources/js/paste/codePaste';

const codeOf = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('pre > code')?.textContent ?? null;

const PY = '# Create a file (for demo purposes)\nwith open("myfile.txt", "w") as f:\n    f.write("First line.\\nSecond line.\\n")\n\n# Read the whole file\nwith open("myfile.txt", "r") as f:\n    text = f.read()\n\nprint(text)\n';

describe('code IS detected', () => {
  it.each([
    ['the reported Python (comments first)', PY],
    ['JavaScript', 'const a = 1;\nfunction add(x, y) {\n  return x + y;\n}\nconsole.log(add(a, 2));'],
    ['shell', '# install\nnpm install\ncd app\ngit status'],
    ['SQL', 'SELECT id, name\nFROM users\nWHERE active = true;'],
    ['JSON', '{\n  "a": 1,\n  "b": [1, 2]\n}'],
    ['PHP', '<?php\n$x = 1;\necho $x;'],
  ])('%s → one code block, text byte for byte', (_n, text) => {
    const html = plainTextAsCode(text, '');
    expect(html).not.toBeNull();
    expect(codeOf(html)).toBe(text.replace(/\n+$/, ''));
  });
});

describe('prose is NOT captured', () => {
  it.each([
    ['markdown essay', '# My essay\n\nThis is a paragraph about things. It has sentences.\n\n## Section two\n\nMore prose here, with a list:\n\n- one\n- two'],
    ['meeting notes', 'Meeting notes:\nWe agreed on the plan.\nSam will follow up.'],
    ['a poem', 'The rain falls soft\nupon the hill,\nand all is still.'],
    ['one line of code', 'x = 1'],
    ['a fenced block (marked owns it, with its language)', '```python\nx = 1\ny = 2\n```'],
    ['a markdown list', '- buy milk\n- call mum\n- write code'],
    ['a recipe with quantities', 'Ingredients:\n2 cups flour\n1 egg\nMix well and bake.'],
  ])('%s', (_n, text) => {
    expect(plainTextAsCode(text, '')).toBeNull();
  });

  it('rich HTML with structure is left to the HTML path', () => {
    expect(plainTextAsCode('a = 1\nb = 2', '<ul><li>a = 1</li><li>b = 2</li></ul>')).toBeNull();
  });
});
