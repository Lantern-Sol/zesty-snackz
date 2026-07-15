/**
 * Peel-to-reveal easter egg for floating stickers.
 *
 * The peel motion itself is pure CSS (a transitioned --sticker-peel fraction
 * drives the clip-paths); this element only manages state:
 * - clicking the sticker toggles it fully open and holds it (`is-peeled`)
 * - clicking the revealed code copies it to the clipboard (`is-copied`)
 * - Escape folds an open sticker back down
 *
 * Expected children:
 * - `[data-peel-trigger]` - the sticker front; carries `aria-expanded`
 * - `[data-peel-code]` - the code button; carries the code in the attribute
 */
class StickerPeelComponent extends HTMLElement {
  #abortController;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #copyTimer;

  connectedCallback() {
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.addEventListener(
      'click',
      (event) => {
        const target = /** @type {Element} */ (event.target);
        const code = target.closest('[data-peel-code]');

        if (code instanceof HTMLElement) {
          this.#copy(code);
        } else {
          this.#toggle();
        }
      },
      { signal }
    );

    this.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.classList.contains('is-peeled')) {
          this.#toggle();
        }
      },
      { signal }
    );
  }

  disconnectedCallback() {
    this.#abortController?.abort();
    clearTimeout(this.#copyTimer);
  }

  #toggle() {
    const peeled = this.classList.toggle('is-peeled');
    this.querySelector('[data-peel-trigger]')?.setAttribute('aria-expanded', String(peeled));
  }

  /**
   * @param {HTMLElement} code
   */
  async #copy(code) {
    const value = code.getAttribute('data-peel-code');
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access denied (e.g. insecure context); the code is still
      // visible on screen, so quietly leave it selectable by eye.
      return;
    }

    code.classList.add('is-copied');
    clearTimeout(this.#copyTimer);
    this.#copyTimer = setTimeout(() => code.classList.remove('is-copied'), 1600);
  }
}

if (!customElements.get('sticker-peel')) {
  customElements.define('sticker-peel', StickerPeelComponent);
}
