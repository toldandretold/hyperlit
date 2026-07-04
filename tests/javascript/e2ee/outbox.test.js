/**
 * Beacon outbox (docs/e2ee.md): the pre-encrypted mirror that lets the
 * synchronous unload beacon substitute ciphertext for encrypted-book items.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, waitFor } from '../indexedDB/idbHarness.js';
import { createVault, createDekForBook, getDekForBook, clearKeyCaches, lockVault } from '../../../resources/js/e2ee/keys';
import { setBookEncrypted, clearEncryptedBookRegistry } from '../../../resources/js/e2ee/registry';
import { decryptString } from '../../../resources/js/e2ee/crypto';
import {
  captureForBeacon,
  getBeaconCiphertext,
  discardBeaconCiphertext,
  clearBeaconOutbox,
  beaconOutboxSize,
} from '../../../resources/js/e2ee/outbox';

const ENC = 'encbook';

beforeEach(async () => {
  installFreshIndexedDB();
  clearKeyCaches();
  clearEncryptedBookRegistry();
  clearBeaconOutbox();
  await createVault();
  const { wrappedDek } = await createDekForBook(ENC);
  await seedStore('library', [{ book: ENC, encrypted: true, wrapped_dek: wrappedDek }]);
  setBookEncrypted(ENC, true);
});

describe('beacon outbox', () => {
  it('captures encrypted-book items as ciphertext', async () => {
    captureForBeacon('nodes-encbook-100', 'nodes', { book: ENC, startLine: 100, content: '<p>SECRET</p>' });
    await waitFor(() => beaconOutboxSize() === 1);

    const captured = getBeaconCiphertext('nodes-encbook-100');
    expect(captured.content).toMatch(/^hlenc\.v1\./);
    expect(JSON.stringify(captured)).not.toContain('SECRET');
    expect(captured.startLine).toBe(100);

    const dek = await getDekForBook(ENC);
    expect(await decryptString(captured.content, dek, ENC)).toBe('<p>SECRET</p>');
  });

  it('ignores plaintext-book items entirely', async () => {
    captureForBeacon('nodes-plain-1', 'nodes', { book: 'plain', startLine: 1, content: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(beaconOutboxSize()).toBe(0);
  });

  it('re-queue invalidates the previous ciphertext and the LAST write wins', async () => {
    const key = 'nodes-encbook-100';
    captureForBeacon(key, 'nodes', { book: ENC, startLine: 100, content: '<p>v1</p>' });
    await waitFor(() => beaconOutboxSize() === 1);

    captureForBeacon(key, 'nodes', { book: ENC, startLine: 100, content: '<p>v2</p>' });
    // Stale entry dropped synchronously — the beacon can never send v1 for a v2 edit
    expect(getBeaconCiphertext(key)).toBeUndefined();
    await waitFor(() => beaconOutboxSize() === 1);

    const dek = await getDekForBook(ENC);
    expect(await decryptString(getBeaconCiphertext(key).content, dek, ENC)).toBe('<p>v2</p>');
  });

  it('locked vault → no entry (the beacon then skips, never sends plaintext)', async () => {
    await lockVault();
    captureForBeacon('nodes-encbook-100', 'nodes', { book: ENC, startLine: 100, content: '<p>SECRET</p>' });
    await new Promise((r) => setTimeout(r, 30));
    expect(beaconOutboxSize()).toBe(0);
  });

  it('discard and clear', async () => {
    captureForBeacon('k1', 'nodes', { book: ENC, startLine: 1, content: 'a' });
    captureForBeacon('k2', 'nodes', { book: ENC, startLine: 2, content: 'b' });
    await waitFor(() => beaconOutboxSize() === 2);
    discardBeaconCiphertext('k1');
    expect(beaconOutboxSize()).toBe(1);
    clearBeaconOutbox();
    expect(beaconOutboxSize()).toBe(0);
  });
});
