/**
 * speakableText (TS port) — parity fixtures shared with the PHP original
 * (tests/Feature/Inference/SpeakableTextParityTest.php) + the splitSentences
 * segmenting port.
 */
import { describe, it, expect } from 'vitest';
import { speakableTextFromContent, isSpeakable, splitSentences } from '../../../resources/js/aiProviders/tts/speakableText';
import fixtures from './speakableTextFixtures.json';

describe('speakableTextFromContent — parity fixtures', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      expect(speakableTextFromContent(c.content)).toBe(c.expected);
    });
  }
});

describe('isSpeakable', () => {
  it('false for empty / markup-only content', () => {
    expect(isSpeakable('')).toBe(false);
    expect(isSpeakable('<p><img src="x.png"></p>')).toBe(false);
  });
  it('true for real text', () => {
    expect(isSpeakable('<p>words</p>')).toBe(true);
  });
});

describe('splitSentences (port of GenerateBookAudioJob)', () => {
  it('keeps short text as one segment', () => {
    expect(splitSentences('One. Two. Three.', 100)).toEqual(['One. Two. Three.']);
  });

  it('splits at sentence boundaries under the cap', () => {
    const segs = splitSentences('Alpha sentence one. Beta sentence two. Gamma sentence three.', 30);
    expect(segs.length).toBeGreaterThan(1);
    // every segment under the cap, nothing lost
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(30);
    expect(segs.join(' ')).toBe('Alpha sentence one. Beta sentence two. Gamma sentence three.');
  });

  it('hard-wraps a single overlong sentence at whitespace', () => {
    const long = 'word '.repeat(50).trim() + '.';
    const segs = splitSentences(long, 40);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(40);
    expect(segs.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  it('hard-cuts a single overlong word', () => {
    const word = 'x'.repeat(95);
    const segs = splitSentences(word, 40);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(40);
    expect(segs.join('')).toBe(word);
  });
});
