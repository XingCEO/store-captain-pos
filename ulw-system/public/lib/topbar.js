(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LINKS = [
    { href: '/', label: '首頁', match: ['/', '/index.html'] },
    { href: '/product.html', label: '產品功能', match: ['/product.html'] },
    { href: '/pricing.html', label: '方案 / FAQ', match: ['/pricing.html'] },
    { href: '/app.html', label: '示範工作台', match: ['/app.html'] }
  ];

  const path = window.location.pathname;
  const isActive = (matches) => matches.some((m) => m === path || (m === '/' && (path === '' || path === '/')));
  const isLogin = path === '/login.html';

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => el.setAttribute(key, value));
    return el;
  }

  function brandIcon() {
    const svg = svgEl('svg', { viewBox: '0 0 36 36', width: '32', height: '32' });
    svg.appendChild(svgEl('rect', { x: '3', y: '8', width: '30', height: '22', rx: '5', fill: '#0f1419' }));
    svg.appendChild(svgEl('rect', { x: '8', y: '13', width: '20', height: '12', rx: '2', fill: '#f4c47b' }));
    svg.appendChild(svgEl('rect', { x: '10', y: '16', width: '9', height: '2', rx: '1', fill: '#0f1419' }));
    svg.appendChild(svgEl('rect', { x: '10', y: '20', width: '14', height: '2', rx: '1', fill: '#0f1419' }));
    svg.appendChild(svgEl('circle', { cx: '29', cy: '11', r: '4', fill: '#0f8a6a' }));
    return svg;
  }

  function anchor(href, label, className, active) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (className) a.className = className;
    if (active) a.setAttribute('aria-current', 'page');
    return a;
  }

  function renderTopbar(host) {
    host.replaceChildren();

    const brand = anchor('/', '', 'brand', false);
    brand.setAttribute('aria-label', '店長 AI POS 首頁');
    const mark = document.createElement('span');
    mark.className = 'brand-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(brandIcon());
    const text = document.createElement('span');
    text.className = 'brand-text';
    const strong = document.createElement('strong');
    strong.textContent = '店長 AI POS';
    const em = document.createElement('em');
    em.textContent = 'Store Captain Cloud';
    text.appendChild(strong);
    text.appendChild(em);
    brand.appendChild(mark);
    brand.appendChild(text);
    host.appendChild(brand);

    const nav = document.createElement('nav');
    nav.id = 'topbarNav';
    nav.className = 'topbar-nav';
    nav.setAttribute('aria-label', '主導覽');
    LINKS.forEach((link) => nav.appendChild(anchor(link.href, link.label, '', isActive(link.match))));
    nav.appendChild(anchor('/login.html', '登入 / 註冊', 'nav-cta', isLogin));
    host.appendChild(nav);

    const cta = document.createElement('div');
    cta.className = 'topbar-cta';
    cta.appendChild(anchor('/login.html', '登入 / 註冊', 'btn-primary', false));
    host.appendChild(cta);

    const burger = document.createElement('button');
    burger.className = 'topbar-burger';
    burger.type = 'button';
    burger.setAttribute('aria-label', '開啟選單');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-controls', 'topbarNav');
    burger.dataset.mobileToggle = '';
    burger.appendChild(document.createElement('span'));
    burger.appendChild(document.createElement('span'));
    burger.appendChild(document.createElement('span'));
    host.appendChild(burger);
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
    renderTopbar(host);
  }

  function ensureMobileCta() {
    if (document.body.dataset.noMobileCta === '1') return;
    if (document.querySelector('.mobile-cta')) return;
    const div = document.createElement('div');
    div.className = 'mobile-cta';
    div.setAttribute('aria-label', '主要行動');
    div.appendChild(anchor('/app.html', '看示範', 'mc-ghost', false));
    div.appendChild(anchor('/login.html', '登入 / 註冊', 'mc-primary', false));
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
