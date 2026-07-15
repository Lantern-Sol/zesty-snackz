/**
 * Peel-to-reveal easter egg for floating stickers.
 *
 * The peel motion itself is pure CSS (a transitioned --sticker-peel fraction
 * drives the clip-paths); this element manages state and pointer input:
 * - dragging the sticker peels it live under the pointer, and on release it
 *   snaps open or shut depending on how far it got
 * - clicking without dragging toggles it fully open and holds it (`is-peeled`)
 * - clicking the revealed code copies it to the clipboard (`is-copied`)
 * - Escape folds an open sticker back down
 *
 * Expected children:
 * - `[data-peel-trigger]` - the sticker front; carries `aria-expanded`
 * - `[data-peel-code]` - the code button; carries the code in the attribute
 */

/** Furthest the sticker can be dragged open. */
const DRAG_MAX = 0.75;

/** Pointer travel (px) before a press counts as a drag instead of a click. */
const DRAG_START_DISTANCE = 6;

/** Peel fraction at release beyond which the sticker snaps open. */
const SNAP_OPEN_THRESHOLD = 0.3;

class StickerPeelComponent extends HTMLElement {
  #abortController;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #copyTimer;

  /**
   * Live drag bookkeeping; null when no pointer is down. `peel` stays null
   * until the pointer travels far enough to count as a drag.
   *
   * @type {{
   *   trigger: HTMLElement,
   *   pointerId: number,
   *   startX: number,
   *   startY: number,
   *   startPeel: number,
   *   height: number,
   *   sin: number,
   *   cos: number,
   *   peel: number | null,
   * } | null}
   */
  #drag = null;

  /** Swallows the click event that follows a completed drag. */
  #suppressClick = false;

  connectedCallback() {
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    const trigger = this.querySelector('[data-peel-trigger]');
    trigger?.addEventListener('pointerdown', (event) => this.#onPointerDown(event), { signal });
    this.addEventListener('pointermove', (event) => this.#onPointerMove(event), { signal });
    this.addEventListener('pointerup', (event) => this.#onPointerEnd(event), { signal });
    this.addEventListener('pointercancel', (event) => this.#onPointerEnd(event), { signal });

    this.addEventListener(
      'click',
      (event) => {
        if (this.#suppressClick) {
          this.#suppressClick = false;
          return;
        }

        const target = /** @type {Element} */ (event.target);
        const code = target.closest('[data-peel-code]');

        if (code instanceof HTMLElement) {
          this.#copy(code);
        } else {
          this.#setPeeled(!this.classList.contains('is-peeled'));
        }
      },
      { signal }
    );

    this.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.classList.contains('is-peeled')) {
          this.#setPeeled(false);
        }
      },
      { signal }
    );
  }

  disconnectedCallback() {
    this.#abortController?.abort();
    clearTimeout(this.#copyTimer);
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerDown(event) {
    if (event.button !== 0 || this.#drag) return;

    // Before the image has laid out the height is 0 and the peel-per-pixel
    // ratio explodes; leave the press to the click handler instead
    const height = this.offsetHeight;
    if (height < 8) return;

    // A fresh press always precedes any click we'd want to swallow, so an
    // armed flag here is stale (its drag ended in pointercancel — no click
    // ever followed to consume it)
    this.#suppressClick = false;

    // The sticker may be rotated; project drags onto its local "up" axis so
    // pulling along the sticker itself always works the fold, even at ±80deg
    const sticker = this.closest('.floating-sticker') ?? this;
    const rotation = parseFloat(getComputedStyle(sticker).getPropertyValue('--sticker-rotation')) || 0;
    const angle = (rotation * Math.PI) / 180;

    this.#drag = {
      trigger: /** @type {HTMLElement} */ (event.currentTarget),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPeel: parseFloat(getComputedStyle(this).getPropertyValue('--sticker-peel')) || 0,
      height,
      sin: Math.sin(angle),
      cos: Math.cos(angle),
      peel: null,
    };
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerMove(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.peel === null) {
      if (Math.hypot(dx, dy) < DRAG_START_DISTANCE) return;

      this.classList.add('is-dragging');
      try {
        drag.trigger.setPointerCapture(drag.pointerId);
      } catch {
        // Pointer already gone; keep following bubbled moves instead
      }
    }

    // Screen delta projected onto the sticker's local upward axis
    const along = (dx * drag.sin - dy * drag.cos) / drag.height;
    drag.peel = Math.min(Math.max(drag.startPeel + along, 0), DRAG_MAX);
    this.style.setProperty('--sticker-peel', String(drag.peel));
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerEnd(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    this.#drag = null;
    if (drag.peel === null) return; // never became a drag; the click handler takes it

    // Only a real pointerup is followed by a click needing to be swallowed;
    // a canceled pointer never produces one
    if (event.type === 'pointerup') this.#suppressClick = true;

    // Removing the inline value hands control back to the classes; the
    // re-enabled transition carries the peel from where it was released
    this.classList.remove('is-dragging');
    this.style.removeProperty('--sticker-peel');
    this.#setPeeled(drag.peel >= SNAP_OPEN_THRESHOLD);
  }

  /**
   * @param {boolean} peeled
   */
  #setPeeled(peeled) {
    this.classList.toggle('is-peeled', peeled);
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
