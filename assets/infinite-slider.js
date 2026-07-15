import { Component } from '@theme/component';
import { debounce, prefersReducedMotion } from '@theme/utilities';

/**
 * A horizontally scrolling slider that can loop seamlessly and auto-scroll.
 *
 * Unlike the Slideshow component (which advances slide-by-slide and loops by
 * jumping back to the first slide), this component clones its slides and
 * teleports the scroll position between identical regions, so both dragging
 * and continuous auto-scroll wrap without a visible seam.
 *
 * Attributes:
 * - `infinite` - clone slides and wrap the scroll position seamlessly.
 * - `auto-scroll` - continuously scroll via requestAnimationFrame.
 * - `auto-scroll-speed` - speed in px/s (default 40).
 * - `auto-scroll-direction` - 'left' (content moves left) or 'right'.
 * - `pause-on-hover` - pause auto-scroll while the pointer is over the slider.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} track - The scrollable track containing the slides.
 *
 * @extends Component<Refs>
 */
class InfiniteSliderComponent extends Component {
  requiredRefs = ['track'];

  /** @type {HTMLElement[]} */
  #originals = [];

  /** Width of one full set of slides (including one trailing gap). */
  #setWidth = 0;

  /** @type {number | null} */
  #rafId = null;

  /** @type {number | null} */
  #lastTime = null;

  /** Sub-pixel remainder carried between auto-scroll frames. */
  #residual = 0;

  /** @type {Set<string>} */
  #pauseReasons = new Set();

  #suspendNormalize = false;

  /** @type {number | null} */
  #lastMeasuredWidth = null;

  /** @type {{ startX: number, startScroll: number, dragged: boolean } | null} */
  #dragState = null;

  /** @type {ResizeObserver | null} */
  #resizeObserver = null;

  /** @type {IntersectionObserver | null} */
  #intersectionObserver = null;

  /** @type {MutationObserver | null} */
  #editorObserver = null;

  connectedCallback() {
    super.connectedCallback();

    const { track } = this.refs;

    this.#originals = Array.from(track.children).filter((child) => child instanceof HTMLElement);
    if (this.#originals.length === 0) return;

    this.#setup();

    this.#resizeObserver = new ResizeObserver(this.#handleResize);
    this.#resizeObserver.observe(this);

    this.#intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      this.#setPaused('offscreen', !entry.isIntersecting);
    });
    this.#intersectionObserver.observe(this);

    track.addEventListener('scroll', this.#handleScroll, { passive: true });
    track.addEventListener('pointerdown', this.#handlePointerDown);
    this.addEventListener('click', this.#suppressClickAfterDrag, { capture: true });
    this.addEventListener('focusin', this.#handleFocusIn);
    this.addEventListener('focusout', this.#handleFocusOut);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);

    if (this.pauseOnHover) {
      this.addEventListener('pointerenter', this.#handlePointerEnter);
      this.addEventListener('pointerleave', this.#handlePointerLeave);
    }

    if (window.Shopify?.designMode) {
      document.addEventListener('shopify:block:select', this.#handleEditorSelect);
      document.addEventListener('shopify:block:deselect', this.#handleEditorDeselect);
      this.#observeEditorChanges();
    }

    this.#startAutoScroll();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;

    this.#resizeObserver?.disconnect();
    this.#intersectionObserver?.disconnect();
    this.#editorObserver?.disconnect();

    this.refs.track?.removeEventListener('scroll', this.#handleScroll);
    this.refs.track?.removeEventListener('pointerdown', this.#handlePointerDown);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    window.removeEventListener('pointermove', this.#handlePointerMove);
    window.removeEventListener('pointerup', this.#handlePointerUp);

    if (window.Shopify?.designMode) {
      document.removeEventListener('shopify:block:select', this.#handleEditorSelect);
      document.removeEventListener('shopify:block:deselect', this.#handleEditorDeselect);
    }
  }

  get infinite() {
    return this.hasAttribute('infinite');
  }

  get autoScroll() {
    return this.hasAttribute('auto-scroll');
  }

  get speed() {
    return parseFloat(this.getAttribute('auto-scroll-speed') ?? '') || 40;
  }

  /** 1 scrolls content leftwards (scrollLeft increases), -1 rightwards. */
  get direction() {
    return this.getAttribute('auto-scroll-direction') === 'right' ? -1 : 1;
  }

  get pauseOnHover() {
    return this.hasAttribute('pause-on-hover');
  }

  /**
   * Advances the slider by one slide. Called by `on:click="/next"` arrows.
   * @param {Event} [event]
   */
  next(event) {
    event?.preventDefault();
    this.#step(1);
  }

  /**
   * Moves the slider back one slide. Called by `on:click="/previous"` arrows.
   * @param {Event} [event]
   */
  previous(event) {
    event?.preventDefault();
    this.#step(-1);
  }

  /**
   * (Re)builds the clone sets and positions the scroller in the middle region.
   */
  #setup() {
    const { track } = this.refs;

    for (const clone of track.querySelectorAll('[data-infinite-slider-clone]')) clone.remove();

    this.#setWidth = 0;
    this.#residual = 0;
    this.#lastMeasuredWidth = track.clientWidth;

    if (!this.infinite || track.clientWidth === 0) return;

    const gap = this.#gap;
    const roughSetWidth = track.scrollWidth + gap;
    if (roughSetWidth <= gap) return;

    // Enough copies that the scroll position always has at least half a set
    // of buffer on either side of the wrap thresholds.
    const copies = Math.max(2, Math.ceil(track.clientWidth / roughSetWidth) + 2);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < copies; i++) {
      for (const original of this.#originals) {
        fragment.appendChild(this.#createClone(original));
      }
    }
    track.appendChild(fragment);

    // Measure the true period from rendered positions to avoid sub-pixel
    // drift on every wrap (scrollWidth rounds to integers).
    const firstOriginal = this.#originals[0];
    const firstClone = track.querySelector('[data-infinite-slider-clone]');
    if (firstOriginal && firstClone) {
      this.#setWidth = firstClone.getBoundingClientRect().left - firstOriginal.getBoundingClientRect().left;
    } else {
      this.#setWidth = roughSetWidth;
    }

    this.#suspendNormalize = false;
    track.scrollLeft = this.#setWidth;
  }

  /**
   * @param {HTMLElement} original
   * @returns {Node}
   */
  #createClone(original) {
    const clone = /** @type {HTMLElement} */ (original.cloneNode(true));
    clone.setAttribute('data-infinite-slider-clone', '');
    clone.setAttribute('aria-hidden', 'true');

    // Keep keyboard users out of duplicated content (clicks still work).
    const focusables = clone.querySelectorAll('a, button, input, select, textarea, [tabindex]');
    for (const focusable of focusables) focusable.setAttribute('tabindex', '-1');
    if (clone.matches('a, button, input, select, textarea, [tabindex]')) clone.setAttribute('tabindex', '-1');

    // Strip editor markers so overlays only target the originals.
    clone.removeAttribute('data-shopify-editor-block');
    for (const marked of clone.querySelectorAll('[data-shopify-editor-block]')) {
      marked.removeAttribute('data-shopify-editor-block');
    }

    return clone;
  }

  get #gap() {
    return parseFloat(getComputedStyle(this.refs.track).columnGap) || 0;
  }

  get #slideStep() {
    const first = this.#originals[0];
    if (!first) return 0;
    return first.getBoundingClientRect().width + this.#gap;
  }

  /**
   * Keeps the scroll position inside the middle copy region. Because every
   * region renders identical content exactly one period apart, the jump is
   * invisible.
   */
  #normalize = () => {
    if (!this.infinite || this.#setWidth <= 0 || this.#suspendNormalize) return;

    const { track } = this.refs;
    if (track.scrollLeft < this.#setWidth * 0.5) {
      track.scrollLeft += this.#setWidth;
    } else if (track.scrollLeft >= this.#setWidth * 1.5) {
      track.scrollLeft -= this.#setWidth;
    }
  };

  /**
   * @param {number} direction - 1 for next, -1 for previous.
   */
  #step(direction) {
    const { track } = this.refs;
    const step = this.#slideStep;
    if (!step) return;

    // Wrapping mid-animation would retarget the smooth scroll across a whole
    // period, so normalize up-front and hold off until the scroll settles.
    this.#normalize();
    this.#suspendNormalize = true;
    this.#setPaused('interact', true);

    track.scrollBy({ left: direction * step, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });

    this.#afterScrollSettles(() => {
      this.#suspendNormalize = false;
      this.#normalize();
      this.#setPaused('interact', false);
    });
  }

  /**
   * @param {() => void} callback
   */
  #afterScrollSettles(callback) {
    const { track } = this.refs;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      track.removeEventListener('scrollend', finish);
      callback();
    };
    track.addEventListener('scrollend', finish);
    setTimeout(finish, 700);
  }

  #startAutoScroll() {
    if (!this.autoScroll || prefersReducedMotion() || this.#rafId) return;
    this.#lastTime = null;
    this.#rafId = requestAnimationFrame(this.#tick);
  }

  /**
   * @param {number} time
   */
  #tick = (time) => {
    this.#rafId = requestAnimationFrame(this.#tick);

    if (this.#pauseReasons.size > 0 || this.#lastTime === null) {
      this.#lastTime = time;
      return;
    }

    const elapsed = Math.min(time - this.#lastTime, 100);
    this.#lastTime = time;

    const { track } = this.refs;
    const delta = ((this.speed * elapsed) / 1000) * this.direction;
    const target = track.scrollLeft + this.#residual + delta;
    track.scrollLeft = target;

    // Carry the sub-pixel remainder so slow speeds don't stall on browsers
    // that round scrollLeft to device pixels.
    this.#residual = Math.max(-1, Math.min(1, target - track.scrollLeft));

    if (this.infinite) {
      this.#normalize();
    } else {
      // Without clones, wrap back to the start once the end is reached.
      const maxScroll = track.scrollWidth - track.clientWidth;
      if (this.direction > 0 && track.scrollLeft >= maxScroll - 1) track.scrollLeft = 0;
      else if (this.direction < 0 && track.scrollLeft <= 1) track.scrollLeft = maxScroll;
    }
  };

  /**
   * @param {string} reason
   * @param {boolean} paused
   */
  #setPaused(reason, paused) {
    if (paused) this.#pauseReasons.add(reason);
    else this.#pauseReasons.delete(reason);
  }

  #handleScroll = () => {
    this.#normalize();
  };

  #handleResize = debounce(() => {
    if (this.refs.track.clientWidth === this.#lastMeasuredWidth) return;
    this.#setup();
  }, 250);

  #handleVisibilityChange = () => {
    this.#setPaused('hidden', document.hidden);
  };

  #handlePointerEnter = () => this.#setPaused('hover', true);

  #handlePointerLeave = () => this.#setPaused('hover', false);

  #handleFocusIn = () => this.#setPaused('focus', true);

  /**
   * @param {FocusEvent} event
   */
  #handleFocusOut = (event) => {
    if (event.relatedTarget instanceof Node && this.contains(event.relatedTarget)) return;
    this.#setPaused('focus', false);
  };

  /**
   * Pauses auto-scroll while any pointer is down, and drag-scrolls with the
   * mouse (touch devices scroll the track natively).
   * @param {PointerEvent} event
   */
  #handlePointerDown = (event) => {
    this.#setPaused('pointer', true);
    window.addEventListener('pointerup', this.#handlePointerUp);
    window.addEventListener('pointercancel', this.#handlePointerUp);

    if (event.pointerType !== 'mouse' || event.button !== 0) return;

    this.#dragState = {
      startX: event.clientX,
      startScroll: this.refs.track.scrollLeft,
      dragged: false,
    };
    window.addEventListener('pointermove', this.#handlePointerMove);
  };

  /**
   * @param {PointerEvent} event
   */
  #handlePointerMove = (event) => {
    const state = this.#dragState;
    if (!state) return;

    const deltaX = event.clientX - state.startX;
    if (!state.dragged && Math.abs(deltaX) > 5) {
      state.dragged = true;
      this.setAttribute('dragging', '');
    }
    if (state.dragged) {
      this.refs.track.scrollLeft = state.startScroll - deltaX;
    }
  };

  #handlePointerUp = () => {
    window.removeEventListener('pointermove', this.#handlePointerMove);
    window.removeEventListener('pointerup', this.#handlePointerUp);
    window.removeEventListener('pointercancel', this.#handlePointerUp);

    const dragged = this.#dragState?.dragged;
    this.#dragState = null;
    this.#setPaused('pointer', false);

    if (dragged) {
      // Leave the attribute on through the click event so it can be suppressed.
      requestAnimationFrame(() => this.removeAttribute('dragging'));
    }
  };

  /**
   * @param {MouseEvent} event
   */
  #suppressClickAfterDrag = (event) => {
    if (!this.hasAttribute('dragging')) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * @param {Event} event
   */
  #handleEditorSelect = (event) => {
    if (event.target instanceof Node && this.contains(event.target)) this.#setPaused('editor', true);
  };

  /**
   * @param {Event} event
   */
  #handleEditorDeselect = (event) => {
    if (event.target instanceof Node && this.contains(event.target)) this.#setPaused('editor', false);
  };

  /**
   * In the theme editor, blocks can be added/removed/reordered by patching the
   * DOM in place. Rebuild the clones whenever the originals change.
   */
  #observeEditorChanges() {
    this.#editorObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) =>
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) => node instanceof HTMLElement && !node.hasAttribute('data-infinite-slider-clone')
        )
      );
      if (!relevant) return;

      this.#originals = Array.from(this.refs.track.children).filter(
        (child) => child instanceof HTMLElement && !child.hasAttribute('data-infinite-slider-clone')
      );
      this.#setup();
    });
    this.#editorObserver.observe(this.refs.track, { childList: true });
  }
}

if (!customElements.get('infinite-slider-component')) {
  customElements.define('infinite-slider-component', InfiniteSliderComponent);
}
