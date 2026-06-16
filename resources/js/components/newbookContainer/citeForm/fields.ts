// Type → optional-fields toggling for the cite-form (#journal/#volume/#issue/
// #pages/#publisher/#school/#note/#booktitle/#editor/#chapter, shown per
// document type). Was newBookForm.js showFieldsForType().
import { $, qs, qsa } from './dom';

export function showFieldsForType(type: string) {
  qsa('.optional-field').forEach((field: any) => {
    field.style.display = 'none';
    if (field.previousElementSibling) field.previousElementSibling.style.display = 'none';
  });

  // Always show common fields like URL
  const urlField = $('url');
  if (urlField) urlField.style.display = 'block';

  if (type === 'article') {
    $('journal').style.display = 'block';
    qs('label[for="journal"]').style.display = 'block';
    $('volume').style.display = 'block';
    qs('label[for="volume"]').style.display = 'block';
    $('issue').style.display = 'block';
    qs('label[for="issue"]').style.display = 'block';
    $('pages').style.display = 'block';
    qs('label[for="pages"]').style.display = 'block';
  } else if (type === 'book') {
    $('publisher').style.display = 'block';
    qs('label[for="publisher"]').style.display = 'block';
  } else if (type === 'incollection') {
    $('booktitle').style.display = 'block';
    qs('label[for="booktitle"]').style.display = 'block';
    $('editor').style.display = 'block';
    qs('label[for="editor"]').style.display = 'block';
    $('publisher').style.display = 'block';
    qs('label[for="publisher"]').style.display = 'block';
    $('chapter').style.display = 'block';
    qs('label[for="chapter"]').style.display = 'block';
    $('pages').style.display = 'block';
    qs('label[for="pages"]').style.display = 'block';
  } else if (type === 'phdthesis') {
    $('school').style.display = 'block';
    qs('label[for="school"]').style.display = 'block';
  } else if (type === 'misc') {
    $('note').style.display = 'block';
    qs('label[for="note"]').style.display = 'block';
  }
}
