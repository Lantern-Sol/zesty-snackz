/**
 * Countdown timer section behaviour:
 *  - counts down to a fixed instant (data-deadline is an ISO string that already
 *    carries the store's UTC offset, so every visitor sees the same countdown)
 *  - ticks the days / hours / minutes / seconds cells once a second
 *  - stops at zero and flips the element to its expired state
 */
class CountdownTimer extends HTMLElement {
  connectedCallback() {
    this.deadline = new Date(this.dataset.deadline).getTime();
    this.units = {
      days: this.querySelector('[data-unit="days"]'),
      hours: this.querySelector('[data-unit="hours"]'),
      minutes: this.querySelector('[data-unit="minutes"]'),
      seconds: this.querySelector('[data-unit="seconds"]'),
    };

    if (Number.isNaN(this.deadline)) return;

    this.tick = this.tick.bind(this);
    this.tick();
    this.timerId = window.setInterval(this.tick, 1000);
  }

  disconnectedCallback() {
    window.clearInterval(this.timerId);
  }

  tick() {
    const remaining = this.deadline - Date.now();

    if (remaining <= 0) {
      this.setValues(0, 0, 0, 0);
      window.clearInterval(this.timerId);
      this.classList.add('is-expired');
      return;
    }

    const totalSeconds = Math.floor(remaining / 1000);
    this.setValues(
      Math.floor(totalSeconds / 86400),
      Math.floor((totalSeconds % 86400) / 3600),
      Math.floor((totalSeconds % 3600) / 60),
      totalSeconds % 60
    );
  }

  setValues(days, hours, minutes, seconds) {
    this.render(this.units.days, days);
    this.render(this.units.hours, hours);
    this.render(this.units.minutes, minutes);
    this.render(this.units.seconds, seconds);
  }

  render(node, value) {
    if (node) node.textContent = String(value).padStart(2, '0');
  }
}

if (!customElements.get('countdown-timer')) {
  customElements.define('countdown-timer', CountdownTimer);
}
