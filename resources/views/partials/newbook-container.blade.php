{{-- The +button popup: New / Import actions plus the shared E2EE opt-in.
     Single source for reader/home/user (was three drifting inline-styled copies).
     The "Encrypted" checkbox applies to BOTH actions: New reads it in
     buttonView.createBookHandler (born-encrypted, docs/e2ee.md); Import captures
     it into encryptIntent.ts when the cite-form replaces this view, and the book
     is locked + server copies scrubbed after conversion (encrypt-after-import).
     Styling: resources/css/components/newbookContainer.css §"Buttons view". --}}
<div id="newbook-container" class="hidden loading">
  <button id="createNewBook" type="button" class="fucked-buttons newbook-action-btn">New</button>
  <button id="importBook" type="button" class="fucked-buttons newbook-action-btn">Import</button>
  <div class="newbook-encrypt-row">
    <label id="createEncryptedLabel" class="newbook-encrypt-label">
      <input type="checkbox" id="createEncrypted" />
      Encrypt
    </label>
    <span class="newbook-encrypt-info-toggle" role="button" tabindex="0" aria-expanded="false" aria-label="About encrypted books">?</span>
  </div>
  <div class="newbook-encrypt-info" hidden>
    <p>Encryption requires a passkey <a class="import-auth-link import-auth-register">(Profile &rarr; Passkeys)</a>.</p>
    <p><b>New books</b> are encrypted on your device &mdash; the server only ever stores ciphertext.</p>
    <p><b>Imported files</b> are encrypted <b>after</b> conversion. Files are then permanently deleted.</p>
  <p>Downsides to encryption: 
    <ul>
      <li>Can't search for your book (can in-text search while un-encrypted in your browser)</li>
      <li>Can't re-convert imported files, as originals are not saved.</li>
      <ul>
  </div>
</div>
