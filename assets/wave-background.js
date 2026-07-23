/**
 * Wave background: a solid colour fill whose edge is a sine wave — the same
 * wave the wave-marquee draws, so a marquee can be laid over it and the two
 * curves line up. Unlike the marquee there is no motion: the wave is a single
 * static path.
 *
 * The band box is anchored and tilted exactly like a floating sticker (see the
 * companion _wave-background.liquid). Its vertical centre is the wave line; the
 * band is deliberately much taller than the section so, once filled up to the
 * top edge or down to the bottom edge, the colour always reaches the section
 * bounds even when the band is rotated. The host clips the overflow.
 *
 * ── Matching a marquee ──────────────────────────────────────────────────────
 * The marquee's wave is stationary in space (the letters move through it), and
 * in screen coordinates from the band's left edge it is exactly
 *
 *   y = center + amp · sin(2π · x / wavelength)
 *
 * which is the curve this script draws too. The one catch is `wavelength`: the
 * marquee does NOT use bandWidth / frequency directly — it snaps that to a whole
 * number of text repeats so its scroll loops seamlessly, so its real wavelength
 * depends on the rendered width of one text repeat (glyphs + gap). To land on
 * the identical curve we reproduce that: given the same marquee text, gap and
 * typography (inherited from the host), we measure one repeat the same way and
 * run the same snapping. With no text we fall back to bandWidth / frequency.
 *
 * All measurement uses clientWidth / clientHeight and offsetWidth (layout
 * coordinates), so it stays correct even when the band is tilted via rotation.
 *
 * Expected markup:
 * - host carries data-amp (px), data-freq (peaks across the band), data-fill
 *   ("up" fills to the top, "down" fills to the bottom), optionally data-text
 *   (the marquee text to match), data-phase (deg) and data-amp-mobile /
 *   data-freq-mobile
 * - `[data-wb-band]`    - the anchored, tiltable box that is measured
 * - `[data-wb-svg]`     - the SVG that spans the band
 * - `[data-wb-path]`    - the filled path this script writes `d` on
 * - `[data-wb-measure]` - hidden node the text repeat is measured in (optional)
 */

/** Samples per wave; enough that the straight segments read as a smooth curve. */
const SAMPLES_PER_WAVE = 32;

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

class WaveBackground extends HTMLElement {
  /** @type {HTMLElement | null} */
  #band = null;

  /** @type {SVGSVGElement | null} */
  #svg = null;

  /** @type {SVGPathElement | null} */
  #path = null;

  /** @type {HTMLElement | null} */
  #measure = null;

  /** Size the path was last built for; lets us skip no-op resizes. */
  #builtWidth = 0;
  #builtHeight = 0;

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  /** @type {(() => void) | undefined} */
  #onBreakpointChange;

  connectedCallback() {
    this.#band = this.querySelector('[data-wb-band]');
    this.#svg = this.querySelector('[data-wb-svg]');
    this.#path = this.querySelector('[data-wb-path]');
    this.#measure = this.querySelector('[data-wb-measure]');
    if (!this.#band || !this.#svg || !this.#path) return;

    this.#build();

    // Glyph metrics change when the custom fonts finish loading; re-measure once
    // they have so the snapped wavelength matches the marquee's real glyphs.
    document.fonts?.ready.then(() => this.#build());

    // Both dimensions drive the fill: width sets the wavelength, height sets how
    // far the colour reaches, so rebuild whenever either really moves (a debounce
    // absorbs the constant height churn of a page loading its media).
    this.#resizeObserver = new ResizeObserver(
      debounce(() => {
        if (!this.#band) return;
        if (
          this.#band.clientWidth !== this.#builtWidth ||
          this.#band.clientHeight !== this.#builtHeight
        ) {
          this.#build();
        }
      }, 150)
    );
    this.#resizeObserver.observe(this.#band);

    // Mobile overrides (amplitude, frequency) change the curve to build.
    this.#onBreakpointChange = () => this.#build();
    mobileMedia.addEventListener('change', this.#onBreakpointChange);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
    if (this.#onBreakpointChange) {
      mobileMedia.removeEventListener('change', this.#onBreakpointChange);
    }
  }

  get #text() {
    return this.dataset.text ?? '';
  }

  get #fillDown() {
    return this.dataset.fill !== 'up';
  }

  get #phase() {
    const phase = Number.parseFloat(this.dataset.phase ?? '0');
    return Number.isFinite(phase) ? (phase * Math.PI) / 180 : 0;
  }

  get #frequency() {
    const raw =
      mobileMedia.matches && this.dataset.freqMobile != null
        ? this.dataset.freqMobile
        : this.dataset.freq;
    const freq = Math.round(Number.parseFloat(raw ?? '3'));
    return Number.isFinite(freq) && freq > 0 ? freq : 1;
  }

  get #amplitude() {
    const raw =
      mobileMedia.matches && this.dataset.ampMobile != null
        ? this.dataset.ampMobile
        : this.dataset.amp;
    const amp = Number.parseFloat(raw ?? '24');
    return Number.isFinite(amp) ? amp : 24;
  }

  /**
   * Width of one text repeat, measured exactly as the marquee measures it: each
   * character wrapped in an inline-block glyph, inside an inline-flex unit that
   * carries the gap as trailing padding. Returns 0 when there is no text to
   * match. See _wave-background.liquid for the mirrored CSS.
   */
  #measureUnitWidth() {
    if (!this.#measure || this.#text === '') return 0;

    const unit = document.createElement('span');
    unit.className = 'wave-background__measure-unit';
    for (const char of this.#text) {
      const glyph = document.createElement('span');
      glyph.className = 'wave-background__measure-glyph';
      // Preserve spaces as non-breaking so they keep width and never collapse.
      glyph.textContent = char === ' ' ? ' ' : char;
      unit.appendChild(glyph);
    }

    this.#measure.replaceChildren(unit);
    const unitWidth = unit.offsetWidth;
    this.#measure.replaceChildren();
    return unitWidth;
  }

  /**
   * The wavelength to draw at. With a marquee text to match, reproduce the
   * marquee's snap (see wave-marquee.js) so the curves coincide; otherwise use
   * the frequency literally.
   *
   * @param {number} viewport - band width in px
   */
  #wavelength(viewport) {
    const freq = this.#frequency;
    const desired = viewport / freq;
    const unitWidth = this.#measureUnitWidth();
    if (!unitWidth) return desired;

    if (desired <= unitWidth) {
      // Several waves per repeat: snap to a whole number of waves per repeat.
      const wavesPerUnit = Math.max(1, Math.round(unitWidth / desired));
      return unitWidth / wavesPerUnit;
    }
    // Fewer than one wave per repeat: stretch over a whole number of repeats.
    const unitsPerWave = Math.max(1, Math.round(desired / unitWidth));
    return unitsPerWave * unitWidth;
  }

  #build() {
    const band = this.#band;
    const svg = this.#svg;
    const path = this.#path;
    if (!band || !svg || !path) return;

    const width = band.clientWidth;
    const height = band.clientHeight;
    if (!width || !height) return;

    this.#builtWidth = width;
    this.#builtHeight = height;

    const amp = this.#amplitude;
    const phase = this.#phase;
    const center = height / 2;
    const wavelength = this.#wavelength(width);

    // Trace the wave left to right, then close the shape along the chosen edge.
    const wavesAcross = Math.max(1, width / wavelength);
    const steps = Math.max(2, Math.ceil(SAMPLES_PER_WAVE * wavesAcross));
    let d = '';
    for (let i = 0; i <= steps; i += 1) {
      const x = (width * i) / steps;
      const y = center + amp * Math.sin((2 * Math.PI * x) / wavelength + phase);
      d += `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    const edge = this.#fillDown ? height : 0;
    d += `L ${width.toFixed(2)} ${edge} L 0 ${edge} Z`;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    path.setAttribute('d', d);
  }
}

if (!customElements.get('wave-background')) {
  customElements.define('wave-background', WaveBackground);
}
