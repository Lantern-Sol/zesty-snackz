import { morph } from '@theme/morph';
import { StandardEvents } from '@shopify/events';

/**
 * Purchase options (one-time vs. subscription) for the product page.
 *
 * Renders server-side from the selected variant's selling plan allocations
 * (see blocks/purchase-options.liquid). This component:
 *  - keeps a hidden `selling_plan` input in the product form in sync with the
 *    UI so the chosen plan is submitted to the cart
 *  - updates the price shown in the add-to-cart button (and the sticky bar)
 *  - morphs itself when the variant changes, preserving the shopper's
 *    one-time/subscribe choice and delivery frequency by plan name
 */
class PurchaseOptionsComponent extends HTMLElement {
  /** @type {AbortController | null} */
  #abortController = null;

  /** @type {MutationObserver | null} */
  #formObserver = null;

  /** @type {boolean} */
  #syncing = false;

  connectedCallback() {
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.addEventListener('change', this.#handleChange, { signal });

    const section = this.closest('.shopify-section');
    section?.addEventListener(StandardEvents.productSelect, this.#handleProductSelect, { signal });

    // The Appstle widget injects its own selling_plan inputs after we connect;
    // re-sync in capture phase right before the form is serialized on submit.
    document.addEventListener(
      'submit',
      (event) => {
        const form = this.#getProductForm();
        if (form && event.target === form) this.#syncFormInput();
      },
      { capture: true, signal }
    );

    this.#syncFormInput();
    this.#observeForm();
  }

  disconnectedCallback() {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#formObserver?.disconnect();
    this.#formObserver = null;
  }

  /**
   * The Appstle embed rebuilds its (hidden) widget inside the product form at
   * arbitrary times — e.g. after a variant change — re-adding inputs named
   * `selling_plan` and clobbering ours. Watch the form and re-assert our state
   * whenever that happens.
   */
  #observeForm() {
    const form = this.#getProductForm();
    if (!form) return;

    this.#formObserver = new MutationObserver(() => {
      if (this.#syncing) return;
      const competing = Array.from(form.querySelectorAll('input[name="selling_plan"]')).some(
        (el) => !el.hasAttribute('data-purchase-options-input')
      );
      const ours = form.querySelector('input[name="selling_plan"][data-purchase-options-input]');
      if (competing || !ours) this.#syncFormInput();
    });

    this.#formObserver.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['name', 'value'] });
  }

  get #mode() {
    const checked = this.querySelector('.purchase-options__mode-input:checked');
    return checked instanceof HTMLInputElement ? checked.value : 'onetime';
  }

  get #selectedPlanInput() {
    const checked = this.querySelector('.purchase-options__plan-input:checked');
    return checked instanceof HTMLInputElement ? checked : null;
  }

  /**
   * @param {Event} event
   */
  #handleChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    // Picking a delivery frequency implies subscribing
    if (input.classList.contains('purchase-options__plan-input')) {
      const subscribeRadio = this.querySelector('.purchase-options__mode-input[value="subscribe"]');
      if (subscribeRadio instanceof HTMLInputElement && !subscribeRadio.checked) {
        subscribeRadio.checked = true;
      }
    }

    this.#syncFormInput();
  };

  /**
   * Writes the current UI state into the product form's `selling_plan` input
   * and refreshes the add-to-cart price labels.
   */
  #syncFormInput() {
    this.#syncing = true;
    const mode = this.#mode;
    this.dataset.mode = mode;

    const planInput = this.#selectedPlanInput;
    const sellingPlanId = mode === 'subscribe' && planInput ? planInput.value : '';

    const form = this.#getProductForm();
    if (form) {
      let hiddenInput = form.querySelector('input[name="selling_plan"][data-purchase-options-input]');
      if (!(hiddenInput instanceof HTMLInputElement)) {
        hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = 'selling_plan';
        hiddenInput.setAttribute('data-purchase-options-input', '');
        form.appendChild(hiddenInput);
      }
      hiddenInput.value = sellingPlanId;

      // Neutralize competing selling_plan inputs (e.g. the hidden Appstle
      // widget's radios) so they can't override our value on submit.
      form.querySelectorAll('input[name="selling_plan"]').forEach((el) => {
        if (el !== hiddenInput) el.setAttribute('name', 'appstle_selling_plan_disabled');
      });
    }

    // Reflect the active price on the add-to-cart button(s), including the sticky bar
    const activePrice =
      mode === 'subscribe' && planInput
        ? planInput.dataset.price
        : this.querySelector('.purchase-options__mode-input[value="onetime"]')?.getAttribute('data-price');

    if (activePrice) {
      const section = this.closest('.shopify-section');
      section?.querySelectorAll('.add-to-cart-price').forEach((el) => {
        el.textContent = activePrice;
      });
    }

    // Release the guard after the observer has processed our own mutations
    queueMicrotask(() => {
      this.#syncing = false;
    });
  }

  /**
   * Morphs this component from the re-rendered section HTML when the variant
   * changes, then restores the shopper's previous selection.
   * @param {CustomEvent & { promise: Promise<{ detail: { html: Document } }> }} event
   */
  #handleProductSelect = (event) => {
    if (!(event.target instanceof Element) || event.target.closest('product-card')) return;

    const previousMode = this.#mode;
    const previousPlanName = this.#selectedPlanInput?.dataset.planName ?? null;

    event.promise
      .then(({ detail }) => {
        if (!detail?.html) return;
        if (detail.productId && detail.productId !== this.dataset.productId) return;

        const newElement = detail.html.querySelector(
          `purchase-options-component[data-block-id="${this.dataset.blockId}"]`
        );

        if (!newElement) {
          // New variant has no selling plans — clear the form input and hide
          this.hidden = true;
          this.dataset.mode = 'onetime';
          const form = this.#getProductForm();
          const hiddenInput = form?.querySelector('input[name="selling_plan"]');
          if (hiddenInput instanceof HTMLInputElement) hiddenInput.value = '';
          return;
        }

        this.hidden = false;
        morph(this, newElement);

        // Restore previous choice (plan ids differ per variant, names match)
        if (previousMode === 'subscribe') {
          const subscribeRadio = this.querySelector('.purchase-options__mode-input[value="subscribe"]');
          if (subscribeRadio instanceof HTMLInputElement) subscribeRadio.checked = true;

          if (previousPlanName) {
            const planInputs = this.querySelectorAll('.purchase-options__plan-input');
            for (const input of planInputs) {
              if (input instanceof HTMLInputElement && input.dataset.planName === previousPlanName) {
                input.checked = true;
                break;
              }
            }
          }
        }

        // Re-sync after the other listeners (product form, sticky bar) morph
        // their own markup from the same response, and again after the
        // Appstle embed has had time to rebuild its widget.
        requestAnimationFrame(() => this.#syncFormInput());
        setTimeout(() => this.#syncFormInput(), 500);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[purchase-options] update failed:', error);
      });
  };

  /**
   * @returns {HTMLFormElement | null}
   */
  #getProductForm() {
    const section = this.closest('.shopify-section');
    const productForm = section?.querySelector(
      `product-form-component[data-product-id="${this.dataset.productId}"] form`
    );
    return productForm instanceof HTMLFormElement ? productForm : null;
  }
}

if (!customElements.get('purchase-options-component')) {
  customElements.define('purchase-options-component', PurchaseOptionsComponent);
}
