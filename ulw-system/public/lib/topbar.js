(function () {
  'use strict';

  const BRAND_SVG = '<svg viewBox="0 0 36 36" width="32" height="32"><rect x="3" y="8" width="30" height="22" rx="5" fill="#0f1419"/><rect x="8" y="13" width="20" height="12" rx="2" fill="#f4c47b"/><rect x="10" y="16" width="9" height="2" rx="1" fill="#0f1419"/><rect x="10" y="20" width="14" height="2" rx="1" fill="#0f1419"/><circle cx="29" cy="11" r="4" fill="#0f8a6a"/></svg>';

  const LINKS = [
    { href: '/', label: '首頁', match: ['/', '/index.html'] },
    { href: '/product.html', label: '產品功能', match: ['/product.html'] },
    { href: '/pricing.html', label: '方案 / FAQ', match: ['/pricing.html'] },
    { href: '/app.html', label: '示範工作台', match: ['/app.html'] }
  ];

  const path = window.location.pathname;
  const isActive = (matches) => matches.some((m) => m === path || (m === '/' && (path === '' || path === '/')));
  const isLogin = path === '/login.html';

  function navHTML() {
    const items = LINKS.map((l) => {
      const cur = isActive(l.match) ? ' aria-current="page"' : '';
      return `<a href="${l.href}"${cur}>${l.label}</a>`;
    }).join('');
    const ctaCur = isLogin ? ' aria-current="page"' : '';
    return items + `<a class="nav-cta" href="/login.html"${ctaCur}>登入 / 註冊</a>`;
  }

  function topbarHTML() {
    return `
      <a class="brand" href="/" aria-label="店長 AI POS 首頁">
        <span class="brand-mark" aria-hidden="true">${BRAND_SVG}</span>
        <span class="brand-text"><strong>店長 AI POS</strong><em>Store Captain Cloud</em></span>
      </a>
      <nav id="topbarNav" class="topbar-nav" aria-label="主導覽">${navHTML()}</nav>
      <div class="topbar-cta"><a class="btn-primary" href="/login.html">登入 / 註冊</a></div>
      <button class="topbar-burger" type="button" aria-label="開啟選單" aria-expanded="false" aria-controls="topbarNav" data-mobile-toggle>
        <span></span><span></span><span></span>
      </button>`;
  }

  function mobileCtaHTML() {
    return `<a class="mc-ghost" href="/app.html">看示範</a><a class="mc-primary" href="/login.html">登入 / 註冊</a>`;
  }

  function ensureTopbar() {
    let host = document.getElementById('siteTopbar');
    if (!host) {
      host = document.createElement('header');
      host.id = 'siteTopbar';
      host.className = 'topbar';
      document.body.insertBefore(host, document.body.firstChild);
    } else if (!host.classList.contains('topbar')) {
      host.classList.add('topbar');
    }
    host.setAttribute('aria-label', '站台導覽');
    host.innerHTML = topbarHTML();
  }

  function ensureMobileCta() {
    if (document.body.dataset.noMobileCta === '1') return;
    if (document.querySelector('.mobile-cta')) return;
    const div = document.createElement('div');
    div.className = 'mobile-cta';
    div.setAttribute('aria-label', '主要行動');
    div.innerHTML = mobileCtaHTML();
    document.body.appendChild(div);
  }

  function bindBurger() {
    const burger = document.querySelector('[data-mobile-toggle]');
    const nav = document.getElementById('topbarNav');
    if (!burger || !nav || burger.dataset.bound === '1') return;
    burger.dataset.bound = '1';
    burger.addEventListener('click', () => {
      const expanded = burger.getAttribute('aria-expanded') === 'true';
      burger.setAttribute('aria-expanded', String(!expanded));
      nav.classList.toggle('is-open', !expanded);
    });
    nav.addEventListener('click', (event) => {
      if (event.target.tagName === 'A') {
        burger.setAttribute('aria-expanded', 'false');
        nav.classList.remove('is-open');
      }
    });
  }

  function init() {
    ensureTopbar();
    ensureMobileCta();
    bindBurger();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
