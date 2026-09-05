{{-- The +button popup: New / Import actions plus the shared E2EE opt-in.
     Single source for reader/home/user (was three drifting inline-styled copies).
     The "Encrypted" checkbox applies to BOTH actions: New reads it in
     buttonView.createBookHandler (born-encrypted, docs/e2ee.md); Import captures
     it into encryptIntent.ts when the cite-form replaces this view, and the book
     is locked + server copies scrubbed after conversion (encrypt-after-import).
     Styling: resources/css/components/newbookContainer.css §"Buttons view". --}}
<div id="newbook-container" class="hidden loading">
  <button id="createNewBook" type="button" class="menu-row-btn newbook-action-btn">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
      <path d="M14 2v6h6"/>
    </svg>
    Blank
  </button>
  <button id="importBook" type="button" class="menu-row-btn newbook-action-btn">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <path d="M7 10l5 5 5-5"/>
      <path d="M12 15V3"/>
    </svg>
    Import
  </button>
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
