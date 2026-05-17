(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // -----------------------------------------------------------
  // Scroll reveal
  // -----------------------------------------------------------
  const revealTargets = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.14, rootMargin: '0px 0px -60px 0px' });
    revealTargets.forEach((el) => io.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add('is-revealed'));
  }

  // Mobile nav toggle now lives in /lib/topbar.js (single owner)

  // -----------------------------------------------------------
  // Hero metric ticker (subtle live feel)
  // -----------------------------------------------------------
  if (!reduceMotion) {
    const metricsB = document.querySelectorAll('.stage-card--main .metric-row b');
    const variants = [
      ['128', 'NT$18,420', '3'],
      ['131', 'NT$18,830', '2'],
      ['134', 'NT$19,210', '4'],
      ['136', 'NT$19,560', '1'],
    ];
    if (metricsB.length === 3) {
      let i = 0;
      let timer = 0;
      const tick = () => {
        if (document.hidden) return;
        i = (i + 1) % variants.length;
        const next = variants[i];
        metricsB.forEach((node, idx) => {
          node.style.transition = 'opacity .25s ease';
          node.style.opacity = '0';
          setTimeout(() => {
            node.textContent = next[idx];
            node.style.opacity = '1';
          }, 240);
        });
      };
      const start = () => { if (!timer) timer = setInterval(tick, 4400); };
      const stop = () => { if (timer) { clearInterval(timer); timer = 0; } };
      start();
      document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    }
  }

  // -----------------------------------------------------------
  // Count-up animation on stats with data-count
  // -----------------------------------------------------------
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window) {
    const seen = new WeakSet();
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function animate(el) {
      if (seen.has(el)) return;
      seen.add(el);
      const target = parseFloat(el.dataset.count);
      if (isNaN(target)) return;
      if (reduceMotion) { el.textContent = String(target); return; }
      const decimals = (String(target).split('.')[1] || '').length;
      const duration = 1200;
      const start = performance.now();
      function step(now) {
        const t = Math.min(1, (now - start) / duration);
        const v = target * easeOutCubic(t);
        el.textContent = decimals ? v.toFixed(decimals) : String(Math.round(v));
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = decimals ? target.toFixed(decimals) : String(target);
      }
      requestAnimationFrame(step);
    }
    const co = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          animate(entry.target);
          co.unobserve(entry.target);
        }
      }
    }, { threshold: 0.4 });
    counters.forEach((el) => co.observe(el));
  }

  // -----------------------------------------------------------
  // Smooth scroll polish for in-page anchors (offset for sticky bar)
  // -----------------------------------------------------------
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const id = link.getAttribute('href');
      if (!id || id === '#' || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  });

  // -----------------------------------------------------------
  // Subtle parallax for mesh orbs (mouse based, gated by motion pref)
  // Uses CSS `translate` so it composes with existing keyframe `transform: translate3d(...)` drift.
  // -----------------------------------------------------------
  if (!reduceMotion) {
    const orbs = document.querySelectorAll('.mesh-orb');
    if (orbs.length && CSS.supports('translate', '1px 1px')) {
      let rx = 0, ry = 0, tx = 0, ty = 0, raf = 0, idle = 0;
      const loop = () => {
        const dx = tx - rx;
        const dy = ty - ry;
        rx += dx * 0.08;
        ry += dy * 0.08;
        orbs.forEach((orb, i) => {
          const depth = 1 + i * 0.6;
          orb.style.translate = `${(rx * depth).toFixed(2)}px ${(ry * depth).toFixed(2)}px`;
        });
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) idle += 1; else idle = 0;
        if (idle > 30) { raf = 0; return; }
        raf = requestAnimationFrame(loop);
      };
      window.addEventListener('pointermove', (e) => {
        tx = (e.clientX - window.innerWidth / 2) * -0.02;
        ty = (e.clientY - window.innerHeight / 2) * -0.02;
        idle = 0;
        if (!raf) raf = requestAnimationFrame(loop);
      }, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
      });
    }
  }
})();
