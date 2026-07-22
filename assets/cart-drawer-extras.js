import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent } from '@shopify/events';

/**
 * Collects the section ids of every cart-items-component on the page so
 * cart mutations can request re-rendered sections for all of them.
 * @returns {string[]}
 */
function cartSectionIds() {
  const ids = new Set(['cart-drawer-section']);
  for (const el of document.querySelectorAll('cart-items-component')) {
    if (el instanceof HTMLElement && el.dataset.sectionId) ids.add(el.dataset.sectionId);
  }
  return Array.from(ids);
}

/**
 * Reads the hidden cart item count out of a rendered section's HTML.
 * @param {Record<string, string> | undefined} sections
 * @returns {number | undefined}
 */
function itemCountFromSections(sections) {
  for (const html of Object.values(sections ?? {})) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const count = parseInt(doc.querySelector('[ref="cartItemCount"]')?.textContent ?? '', 10);
    if (!Number.isNaN(count)) return count;
  }
  return undefined;
}

/**
 * Delivery-frequency selector for a cart line. Wraps a native <select> whose
 * options are the product's selling plans (Appstle registers its plans as
 * standard selling plan groups, so they surface here automatically). Changing
 * the value re-writes the line via /cart/change.js with a `selling_plan`,
 * then lets `cart-items-component` morph the drawer from the returned sections.
 */
class CartLineSellingPlan extends HTMLElement {
  connectedCallback() {
    this.querySelector('select')?.addEventListener('change', this.#onChange);
  }

  /** @param {Event} event */
  #onChange = (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;

    const line = Number(this.dataset.line);
    const quantity = Number(this.dataset.quantity || 1);
    if (!line) return;

    select.disabled = true;
    this.classList.add('is-busy');

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'update',
        context: 'cart',
        lines: [{ id: this.dataset.key ?? '', quantity }],
        promise: deferred.promise,
      })
    );

    const body = JSON.stringify({
      line,
      quantity,
      selling_plan: select.value ? Number(select.value) : null,
      sections: cartSectionIds().join(','),
      sections_url: window.location.pathname,
    });

    fetch(Theme.routes.cart_change_url, fetchConfig('json', { body }))
      .then((response) => response.json())
      .then((response) => {
        if (response.errors) throw new Error(response.errors);

        deferred.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(response),
          detail: {
            sections: response.sections,
            items: response.items,
            itemCount: itemCountFromSections(response.sections),
            source: 'cart-line-selling-plan',
            didError: false,
          },
        });
      })
      .catch((error) => {
        console.warn('[cart-line-selling-plan] Failed to update selling plan:', error);
        deferred.reject(error);
        // Restore the previous selection; the element survives because no morph ran.
        select.value = this.dataset.current ?? '';
        select.disabled = false;
        this.classList.remove('is-busy');
      });
  };
}

/**
 * "Toss in more" add button. Adds one unit of the given variant via
 * /cart/add.js and resolves a CartLinesUpdateEvent with the re-rendered
 * sections so the drawer (items, totals, upsell list) refreshes in place.
 */
class CartUpsellAdd extends HTMLElement {
  connectedCallback() {
    this.querySelector('button')?.addEventListener('click', this.#onClick);
  }

  #onClick = () => {
    const button = this.querySelector('button');
    const variantId = Number(this.dataset.variantId);
    if (!variantId || !button || button.disabled) return;

    button.disabled = true;
    this.classList.add('is-busy');

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'cart',
        lines: [{ merchandiseId: String(variantId), quantity: 1 }],
        promise: deferred.promise,
      })
    );

    const body = JSON.stringify({
      items: [{ id: variantId, quantity: 1 }],
      sections: cartSectionIds().join(','),
      sections_url: window.location.pathname,
    });

    fetch(Theme.routes.cart_add_url, fetchConfig('json', { body }))
      .then((response) => response.json())
      .then(async (response) => {
        // /cart/add.js signals errors via a `status` field.
        if (response.status) throw new Error(response.description || response.message || 'Add to cart failed');

        const cart = await fetch(`${Theme.routes.cart_url}.json`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        }).then((res) => res.json());

        deferred.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
          detail: {
            sections: response.sections,
            items: cart.items,
            itemCount: itemCountFromSections(response.sections) ?? cart.item_count,
            source: 'cart-upsell-add',
            didError: false,
          },
        });
      })
      .catch((error) => {
        console.warn('[cart-upsell-add] Failed to add item:', error);
        deferred.reject(error);
        button.disabled = false;
        this.classList.remove('is-busy');
      });
  };
}

/**
 * Horizontal scroll-snap slider for the upsell cards with prev/next arrows.
 */
class CartUpsellSlider extends HTMLElement {
  connectedCallback() {
    this.track = this.querySelector('[data-slider-track]');
    this.prev = this.querySelector('[data-slider-prev]');
    this.next = this.querySelector('[data-slider-next]');
    if (!this.track) return;

    this.prev?.addEventListener('click', () => this.#scrollBy(-1));
    this.next?.addEventListener('click', () => this.#scrollBy(1));
    this.track.addEventListener('scroll', this.#updateArrows, { passive: true });
    this.#updateArrows();
  }

  /** @param {number} direction */
  #scrollBy(direction) {
    const card = this.track?.querySelector(':scope > *');
    const step = card ? card.getBoundingClientRect().width + 12 : this.track?.clientWidth ?? 0;
    this.track?.scrollBy({ left: step * direction, behavior: 'smooth' });
  }

  #updateArrows = () => {
    const { track } = this;
    if (!track || !(this.prev instanceof HTMLButtonElement) || !(this.next instanceof HTMLButtonElement)) return;
    this.prev.disabled = track.scrollLeft <= 4;
    this.next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 4;
  };
}

if (!customElements.get('cart-line-selling-plan')) {
  customElements.define('cart-line-selling-plan', CartLineSellingPlan);
}
if (!customElements.get('cart-upsell-add')) {
  customElements.define('cart-upsell-add', CartUpsellAdd);
}
if (!customElements.get('cart-upsell-slider')) {
  customElements.define('cart-upsell-slider', CartUpsellSlider);
}
