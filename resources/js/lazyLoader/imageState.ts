/**
 * Attach error handlers to images in a chunk element.
 * On 404/error, preserves the image's aspect ratio (preventing layout shift)
 * and shows a broken-image placeholder with a delete button for edit mode.
 */
export function handleBrokenImages(container: any) {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return;

  images.forEach((img: any) => {
    // PROACTIVE: Set aspect-ratio immediately to prevent Safari collapse on 404.
    // CSS spec: height:auto uses aspect-ratio as fallback when the image has no
    // intrinsic ratio (broken). This reserves space before the error event fires.
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');
    if (w && h) {
      img.style.aspectRatio = `${w} / ${h}`;
    } else {
      // Self-healing: capture dimensions on load so they persist on next save
      img.addEventListener('load', () => {
        if (img.naturalWidth && img.naturalHeight) {
          img.setAttribute('width', img.naturalWidth);
          img.setAttribute('height', img.naturalHeight);
          img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
      }, { once: true });
    }

    // If the image is ALREADY flagged broken in stored content, decorate it
    // NOW — don't wait for an error event. On save the sanitizer strips the
    // `.broken-image-wrapper` + delete button but keeps `class="broken-image"`
    // on the <img>; without this, a reload would leave a broken image whose
    // error handler bails on the "already handled" guard, so it could never be
    // deleted (no button).
    if (img.classList.contains('broken-image')) {
      decorateBrokenImage(img, w, h);
    }

    img.addEventListener('error', () => {
      decorateBrokenImage(img, w, h);
    }, { once: true });
  });
}

/**
 * Mark an image as broken and ensure it's wrapped with a delete button.
 * Idempotent: safe to call on an already-decorated image (re-uses the existing
 * wrapper / button rather than duplicating them).
 */
function decorateBrokenImage(img: any, w: string | null, h: string | null) {
  img.classList.add('broken-image');

  if (!w || !h) {
    img.style.minHeight = '200px';
  }
  img.style.width = '100%';
  img.alt = 'Image failed to load';

  const picture = img.closest('picture') || img;

  // Already wrapped (fresh error after we decorated, or a wrapper survived in
  // stored content) → just make sure the delete button is present.
  const existingWrapper = picture.closest('.broken-image-wrapper');
  if (existingWrapper) {
    ensureDeleteButton(existingWrapper);
    return;
  }

  const parent = picture.parentNode;
  if (!parent) return;

  // Wrap in a container with contenteditable="false" to prevent mutation tracking
  const wrapper = document.createElement('div');
  wrapper.className = 'broken-image-wrapper';
  wrapper.setAttribute('contenteditable', 'false');

  parent.insertBefore(wrapper, picture);
  wrapper.appendChild(picture);
  ensureDeleteButton(wrapper);
}

/** Append the broken-image delete button to a wrapper if it doesn't have one. */
function ensureDeleteButton(wrapper: any) {
  if (wrapper.querySelector('.broken-image-delete-btn')) return;

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'broken-image-delete-btn';
  deleteBtn.setAttribute('data-action', 'delete-broken-image');
  deleteBtn.setAttribute('aria-label', 'Delete broken image');
  deleteBtn.title = 'Delete broken image';
  wrapper.appendChild(deleteBtn);
}
