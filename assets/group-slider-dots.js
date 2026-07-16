/**
 * Pagination dots for the group-slider block.
 *
 * Unlike the theme's default `slideshow-controls` (which renders one dot per
 * slide), this element renders one dot per scroll stop. Starting at slide 0 and
 * advancing by `slidesToScroll` each step until the last slide that can sit at
 * the start of the viewport (maxStart = slideCount - slidesPerView), that gives
 * `ceil(maxStart / slidesToScroll) + 1` dots — so the dots move in lockstep
 * with the arrows. Both the visible-slide count and scroll step differ between
 * breakpoints, so the dot count is recomputed whenever the breakpoint changes.
 *
 * The first dot points at slide 0, the last dot at the final reachable slide,
 * keeping the slider fully navigable with fewer dots than slides.
 *
 * Reads:
 *   slide-count      - total number of slides
 *   visible-desktop  - slides per view at >= 750px
 *   visible-mobile   - slides per view at < 750px
 *   scroll-desktop   - slides advanced per step at >= 750px
 *   scroll-mobile    - slides advanced per step at < 750px
 */
class GroupSliderDots extends HTMLElement {
  connectedCallback() {
    this.slideshow = this.closest('slideshow-auto-component, slideshow-component');
    this.slideCount = parseInt(this.getAttribute('slide-count'), 10) || 0;
    this.visibleDesktop = parseInt(this.getAttribute('visible-desktop'), 10) || 1;
    this.visibleMobile = parseInt(this.getAttribute('visible-mobile'), 10) || 1;
    this.scrollDesktop = parseInt(this.getAttribute('scroll-desktop'), 10) || 1;
    this.scrollMobile = parseInt(this.getAttribute('scroll-mobile'), 10) || 1;

    this.list = document.createElement('ol');
    this.list.className = 'group-slider__dots';
    this.appendChild(this.list);

    // Arrows live alongside the dots in the controls row. We toggle their
    // disabled state from here so it tracks the first/last dot (i.e. the scroll
    // step), which is finer-grained than the component's own end detection.
    this.prevArrow = this.parentElement?.querySelector('.group-slider__arrow--prev');
    this.nextArrow = this.parentElement?.querySelector('.group-slider__arrow--next');

    this.mediaQuery = matchMedia('(min-width: 750px)');
    this.mediaQuery.addEventListener('change', this.build);
    this.slideshow?.addEventListener('slideshow:select', this.handleSelect);

    this.build();
  }

  disconnectedCallback() {
    this.mediaQuery?.removeEventListener('change', this.build);
    this.slideshow?.removeEventListener('slideshow:select', this.handleSelect);
  }

  get visibleSlides() {
    return this.mediaQuery.matches ? this.visibleDesktop : this.visibleMobile;
  }

  /** Slides advanced per arrow press / per dot on this breakpoint. */
  get step() {
    const step = this.mediaQuery.matches ? this.scrollDesktop : this.scrollMobile;
    return step > 0 ? step : 1;
  }

  /** Furthest slide index that can sit at the start of the viewport. */
  get maxStart() {
    return Math.max(0, this.slideCount - this.visibleSlides);
  }

  /** One dot per scroll stop: stepping by `step` from 0 up to maxStart. */
  get pageCount() {
    const { maxStart, step } = this;
    if (maxStart <= 0) return 1;
    return Math.ceil(maxStart / step) + 1;
  }

  /** Slide a given dot should scroll to. */
  slideForDot(dot) {
    return Math.min(dot * this.step, this.maxStart);
  }

  /** Dot that best represents a given slide index. */
  dotForSlide(index) {
    const { pageCount, step } = this;
    if (pageCount <= 1) return 0;
    return Math.min(pageCount - 1, Math.round(Math.max(index, 0) / step));
  }

  build = () => {
    const { pageCount } = this;

    // Nothing to paginate — hide the dots on this breakpoint, but still run
    // syncActive below so the arrows get disabled (both ends are the same stop).
    this.hidden = pageCount <= 1;

    const dots = [];
    for (let i = 0; i < pageCount && pageCount > 1; i++) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'group-slider__dot button button-unstyled';
      button.setAttribute('aria-label', `Go to slide ${this.slideForDot(i) + 1}`);
      button.addEventListener('click', () => this.slideshow?.select(this.slideForDot(i)));
      li.appendChild(button);
      dots.push(li);
    }
    this.list.replaceChildren(...dots);

    this.syncActive(this.slideshow?.current ?? 0);
  };

  handleSelect = (event) => {
    this.syncActive(event.detail.index);
  };

  syncActive(index) {
    const active = this.dotForSlide(index);
    Array.from(this.list.children).forEach((li, i) => {
      li.firstElementChild?.setAttribute('aria-selected', String(i === active));
    });

    // Disable the previous arrow on the first stop, the next arrow on the last.
    const last = this.pageCount - 1;
    if (this.prevArrow) this.prevArrow.disabled = active <= 0;
    if (this.nextArrow) this.nextArrow.disabled = active >= last;
  }
}

if (!customElements.get('group-slider-dots')) {
  customElements.define('group-slider-dots', GroupSliderDots);
}
