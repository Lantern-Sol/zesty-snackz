/**
 * Overlap section: pulls its own section up over the section above it by a
 * chosen fraction of its OWN height, so the two overlap.
 *
 * CSS percentage margins resolve against the containing block's width, never
 * its height, so "40% of this section's height" can't be expressed in plain
 * CSS. Instead we measure the section's rendered height here and write the
 * negative margin-top in pixels, keeping it in sync as the section grows (media
 * loading) or the viewport resizes.
 *
 * The element is an empty marker inside the section; it applies the margin — and
 * a stacking context so the overlap paints on the chosen side — to its closest
 * `.shopify-section` wrapper, which is the box that occupies the page flow.
 *
 * Attributes on the host:
 * - data-overlap        - percent of own height to overlap (desktop)
 * - data-overlap-mobile - optional per-mobile percent; falls back to desktop
 * - data-layer          - "above" (default) or "below": which section wins where
 *   they overlap
 */

const mobileMedia = window.matchMedia('(max-width: 749px)');

/**
 * @param {() => void} fn
 * @param {number} wait
 */
function debounce(fn, wait) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

class OverlapSection extends HTMLElement {
  /** @type {HTMLElement | null} The .shopify-section wrapper that sits in flow. */
  #wrapper = null;

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  /** @type {(() => void) | undefined} */
  #onBreakpointChange;

  connectedCallback() {
    this.#wrapper = this.closest('.shopify-section');
    if (!this.#wrapper) return;

    // Paint this section above or below the neighbour where they overlap. A
    // stacking context is needed either way; z-index sets who wins.
    this.#wrapper.style.position = 'relative';
    this.#wrapper.style.zIndex = this.dataset.layer === 'below' ? '0' : '2';

    this.#apply();

    // The overlap is a fraction of the section height, which grows as the page
    // loads its media — recompute whenever the height really moves.
    this.#resizeObserver = new ResizeObserver(debounce(() => this.#apply(), 100));
    this.#resizeObserver.observe(this.#wrapper);

    // The overlap amount can differ across the mobile breakpoint.
    this.#onBreakpointChange = () => this.#apply();
    mobileMedia.addEventListener('change', this.#onBreakpointChange);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
    if (this.#onBreakpointChange) {
      mobileMedia.removeEventListener('change', this.#onBreakpointChange);
    }
    if (this.#wrapper) this.#wrapper.style.marginTop = '';
  }

  get #overlap() {
    const raw =
      mobileMedia.matches && this.dataset.overlapMobile != null
        ? this.dataset.overlapMobile
        : this.dataset.overlap;
    const pct = Number.parseFloat(raw ?? '0');
    if (!Number.isFinite(pct)) return 0;
    // Cap at 100%: overlapping more than its own height has no visual meaning.
    return Math.min(Math.max(pct, 0), 100);
  }

  #apply() {
    const wrapper = this.#wrapper;
    if (!wrapper) return;

    const overlap = this.#overlap;
    if (overlap <= 0) {
      wrapper.style.marginTop = '';
      return;
    }

    // offsetHeight is the border-box height and excludes margins, so reading it
    // after we've set margin-top stays stable — no measurement feedback loop.
    const height = wrapper.offsetHeight;
    wrapper.style.marginTop = `${(-(overlap / 100) * height).toFixed(2)}px`;
  }
}

if (!customElements.get('overlap-section')) {
  customElements.define('overlap-section', OverlapSection);
}
