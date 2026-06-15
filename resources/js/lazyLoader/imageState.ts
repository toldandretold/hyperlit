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

    img.addEventListener('error', () => {
      // Already handled
      if (img.classList.contains('broken-image')) return;

      img.classList.add('broken-image');

      if (!w || !h) {
        img.style.minHeight = '200px';
      }
      img.style.width = '100%';

      img.alt = 'Image failed to load';

      // Wrap in a container with contenteditable="false" to prevent mutation tracking
      const picture = img.closest('picture') || img;
      const parent = picture.parentNode;
      if (!parent) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'broken-image-wrapper';
      wrapper.setAttribute('contenteditable', 'false');

      // Create delete button (mirrors video delete btn)
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'broken-image-delete-btn';
      deleteBtn.setAttribute('data-action', 'delete-broken-image');
      deleteBtn.setAttribute('aria-label', 'Delete broken image');
      deleteBtn.title = 'Delete broken image';

      parent.insertBefore(wrapper, picture);
      wrapper.appendChild(picture);
      wrapper.appendChild(deleteBtn);
    }, { once: true });
  });
}
