// Zero-import leaf: carries the buttons-view "Encrypted" checkbox state to the
// cite-form submit. Needed because opening the import form replaces the
// container's innerHTML, so #createEncrypted is gone from the DOM by the time
// the form submits. Captured in buttonView.importBookHandler on every Import
// click; read in citeForm/submission.ts to arm encrypt-after-import
// (docs/e2ee.md — conversion needs plaintext, so imported books are locked and
// server-side copies scrubbed AFTER the pipeline finishes).
let importEncryptIntent = false;

export function setImportEncryptIntent(value: boolean): void {
  importEncryptIntent = value;
}

export function getImportEncryptIntent(): boolean {
  return importEncryptIntent;
}
