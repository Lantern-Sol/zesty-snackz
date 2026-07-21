/**
 * Know Your Bitez section behaviour:
 *  - play button starts the inline video (poster + overlay hidden, controls on)
 *  - the big counter pops in the first time it scrolls into view
 */
function initVideos(root = document) {
  root.querySelectorAll('[data-kyb-video]:not([data-kyb-init])').forEach((wrapper) => {
    wrapper.setAttribute('data-kyb-init', '');
    const button = wrapper.querySelector('.kyb__play');
    const video = wrapper.querySelector('video');
    if (!button || !video) return;

    button.addEventListener('click', () => {
      wrapper.classList.add('is-playing');
      video.controls = true;
      video.play();
    });

    video.addEventListener('ended', () => {
      video.controls = false;
      wrapper.classList.remove('is-playing');
    });
  });
}

function initCounters(root = document) {
  const counters = [...root.querySelectorAll('[data-kyb-reveal]:not([data-kyb-init])')];
  if (!counters.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('kyb-in');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.4 }
  );

  counters.forEach((counter) => {
    counter.setAttribute('data-kyb-init', '');
    observer.observe(counter);
  });
}

function init(root = document) {
  initVideos(root);
  initCounters(root);
}

init();

document.addEventListener('shopify:section:load', (event) => init(event.target));
