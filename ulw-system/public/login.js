(function () {
  const tabs = document.querySelectorAll('.auth-tab');
  const panels = document.querySelectorAll('.auth-tabpanel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      });
      panels.forEach((p) => { p.hidden = p.dataset.panel !== target; });
    });
  });
  const eye = document.getElementById('toggleLoginPassword');
  const pwd = document.getElementById('loginPassword');
  if (eye && pwd) {
    eye.addEventListener('click', () => {
      const showing = pwd.type === 'text';
      pwd.type = showing ? 'password' : 'text';
      eye.setAttribute('aria-label', showing ? '顯示密碼' : '隱藏密碼');
    });
  }
  function flash(msg, tone) {
    let el = document.getElementById('flashToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'flashToast';
      document.body.appendChild(el);
    }
    el.classList.remove('is-warn', 'is-err', 'is-ok');
    el.classList.add(tone === 'warn' ? 'is-warn' : tone === 'err' ? 'is-err' : 'is-ok');
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.remove(); }, 3000);
  }
  const loginForm = document.getElementById('authLoginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      if (!email || !password) { flash('請填寫電子郵件與密碼', 'warn'); return; }
      flash('正式環境尚未開放，請改用「示範工作台」', 'warn');
      setTimeout(() => { location.href = '/app.html'; }, 1200);
    });
  }
  const regForm = document.getElementById('authRegisterForm');
  if (regForm) {
    regForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const password = document.getElementById('regPassword').value;
      const agreed = document.getElementById('regAgree').checked;
      if (password.length < 8) { flash('密碼至少需要 8 個字元', 'err'); return; }
      if (!agreed) { flash('請同意服務條款', 'warn'); return; }
      flash('正式環境尚未開放，請改用「示範工作台」', 'warn');
      setTimeout(() => { location.href = '/app.html'; }, 1200);
    });
  }
  document.querySelectorAll('.oauth-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = { google: 'Google', line: 'LINE', apple: 'Apple ID' };
      flash(`正式版會支援 ${map[btn.dataset.provider] || ''} 第三方登入。示範請使用「示範工作台」。`, 'warn');
    });
  });
  const forgot = document.getElementById('forgotPassword');
  if (forgot) forgot.addEventListener('click', (e) => { e.preventDefault(); flash('請聯絡 hello@storecaptain.local', 'warn'); });
})();
