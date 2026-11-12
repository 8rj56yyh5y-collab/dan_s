'use strict';
/* БХ Учёт — интерфейс (без фреймворков). Маршруты через #/... */
(function () {
  // ================= Утилиты =================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s = 18) => window.icon(n, s);
  const S = { me: null, settings: null, meta: { currency: '₴', ai: false }, timers: [] };
  const cur = () => S.meta.currency || '₴';
  const nf = (n, d = 2) => (n == null || n === '' ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d }));
  const money = (n) => (n == null || n === '' ? '—' : `${nf(n)} ${cur()}`);
  const short = (n) => { const a = Math.abs(n); if (a >= 1e6) return `${nf(n / 1e6, 1)} млн`; if (a >= 1e3) return `${nf(n / 1e3, 0)} тыс`; return nf(n, 0); };
  const dt = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const dOnly = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => ymd(new Date());
  const initials = (n) => String(n || '?').replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const isHead = () => S.me && S.me.role === 'head';
  const pct = (a, b) => (b ? Math.round((a / b - 1) * 1000) / 10 : null);
  const left = (until, now = Date.now()) => {
    const ms = until - now; if (ms <= 0) return null;
    const tm = Math.ceil(ms / 60e3); const h = Math.floor(tm / 60); const m = tm % 60;
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  };
  const STATUS = { pending: 'На согласовании', revision: 'На доработке', approved: 'Согласовано', issued: 'Деньги выданы', review: 'Отчёт на проверке',
    report_revision: 'Отчёт на доработке', closed: 'Проведено', rejected: 'Отклонено', cancelled: 'Отменено', new: 'Ждёт подтверждения', confirmed: 'Подтверждено' };
  const pill = (s, text) => `<span class="pill s-${esc(s)}">${esc(text || STATUS[s] || s)}</span>`;
  const METHOD = { cash: 'Наличные', card: 'Карта', account: 'На счёт' };
  const kindText = (r) => (r.kind === 'money' ? 'Деньги под отчёт' : r.channel === 'offline' ? 'Покупка в магазине' : 'Покупка онлайн');

  async function api(path, opts = {}) {
    const o = { method: opts.method || 'GET', headers: { 'X-BH': '1' }, credentials: 'same-origin' };
    if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
    const res = await fetch(path, o);
    let data = {};
    try { data = await res.json(); } catch { /* пусто */ }
    if (res.status === 401 && !path.startsWith('/api/login')) { S.me = null; go('#/login'); throw new Error(data.error || 'Войдите в систему'); }
    if (res.status === 428) { S.me = { ...(S.me || {}), must_change_pw: true }; render(); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const put = (p, body) => api(p, { method: 'PUT', body });

  let toastT;
  function toast(msg, err = false) {
    const t = $('#toast'); t.textContent = msg; t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, err ? 4200 : 2600);
  }
  const fail = (e) => toast(e.message || String(e), true);

  // Модальное окно. Возвращает Promise с результатом.
  function modal(html, { wide = false, onOpen } = {}) {
    const m = $('#modal');
    m.innerHTML = `<div class="box${wide ? ' wide' : ''}">${html}</div>`;
    m.classList.remove('hidden');
    return new Promise((resolve) => {
      const close = (v) => { m.classList.add('hidden'); m.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      m.onclick = (e) => { if (e.target === m) close(null); const c = e.target.closest('[data-close]'); if (c) close(c.dataset.close === 'ok' ? true : null); };
      if (onOpen) onOpen($('.box', m), close);
    });
  }
  // Диалог с полями: fields = [{name, label, type, value, required, hint}]
  function ask({ title, text = '', fields = [], ok = 'Готово', danger = false }) {
    const fh = fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.type === 'textarea'
      ? `<textarea class="input" name="${f.name}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
      : `<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} inputmode="${f.type === 'money' ? 'decimal' : 'text'}" placeholder="${esc(f.placeholder || '')}">`}
      ${f.hint ? `<small class="hint">${esc(f.hint)}</small>` : ''}</label>`).join('');
    return modal(`<h2>${esc(title)}</h2>${text ? `<p class="muted" style="margin:0">${text}</p>` : ''}<form class="stack" novalidate>${fh}
      <div class="acts"><button type="button" class="btn soft" data-close>Отмена</button><button class="btn ${danger ? 'danger' : ''}">${esc(ok)}</button></div></form>`, {
      onOpen: (box, close) => {
        const form = $('form', box);
        const first = $('input,textarea', form); if (first) setTimeout(() => first.focus(), 30);
        form.onsubmit = (e) => {
          e.preventDefault();
          const out = {};
          for (const f of fields) {
            const el = form.elements[f.name]; const v = el.value.trim();
            if (f.required && !v) { el.classList.add('bad'); el.focus(); return; }
            out[f.name] = f.type === 'money' ? v.replace(/\s/g, '').replace(',', '.') : v;
          }
          close(out);
        };
      },
    });
  }
  const confirmBox = (title, text, ok = 'Да', danger = false) => ask({ title, text, ok, danger }).then((r) => !!r);

  // ================= Маршрутизация =================
  const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
  window.addEventListener('hashchange', () => render());
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path, parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  // ================= Каркас =================
  const NAV_HEAD = [
    ['/', 'home', 'Обзор'], ['/requests', 'list', 'Заявки', 'todo'], ['/incomes', 'coins', 'Доходы', 'inc'],
    ['/analytics', 'chart', 'Аналитика'], ['/control', 'shield', 'Контроль', 'flags'], ['/journal', 'history', 'Журнал'],
    ['sep'], ['/team', 'users', 'Команда'], ['/settings', 'sliders', 'Настройки'],
  ];
  const NAV_STAFF = [['/', 'home', 'Главная'], ['/requests', 'list', 'Мои заявки', 'todo'], ['/incomes', 'coins', 'Доходы'], ['sep'], ['/profile', 'user', 'Профиль']];
  const TAB_HEAD = [['/', 'home', 'Обзор'], ['/requests', 'list', 'Заявки', 'todo'], ['/analytics', 'chart', 'Аналитика'], ['/control', 'shield', 'Контроль', 'flags'], ['/more', 'menu', 'Ещё']];
  const TAB_STAFF = [['/', 'home', 'Главная'], ['/requests', 'list', 'Заявки', 'todo'], ['/new', 'plus', 'Заявка', null, true], ['/incomes', 'coins', 'Доходы'], ['/profile', 'user', 'Профиль']];
  S.badges = {};

  function shell(content) {
    const r = route();
    const active = (p) => (p === '/' ? r.path === '/' : r.path.startsWith(p));
    const badge = (k) => (k && S.badges[k] ? `<span class="badge${k === 'flags' ? ' red' : ''}">${S.badges[k]}</span>` : '');
    const nav = (isHead() ? NAV_HEAD : NAV_STAFF).map(([p, i, t, b]) => (p === 'sep' ? '<div class="nav-sep"></div>'
      : `<a href="#${p}" class="${active(p) ? 'on' : ''}">${ic(i, 19)}<span>${t}</span>${badge(b)}</a>`)).join('');
    const tabs = (isHead() ? TAB_HEAD : TAB_STAFF).map(([p, i, t, b, plus]) => `<a href="#${p}" class="${plus ? 'plus' : ''} ${!plus && active(p) ? 'on' : ''}">${plus ? `<span class="pl">${ic(i, 24)}</span>` : ic(i, 22)}<span>${t}</span>${badge(b)}</a>`).join('');
    const theme = document.documentElement.dataset.theme;
    return `<div class="shell">
      <aside class="side">
        <a class="brand" href="#/"><span class="brand-mark">БХ</span><span><b>БХ Учёт</b><span>${isHead() ? 'Кабинет руководителя' : 'Кабинет сотрудника'}</span></span></a>
        <a class="btn hl" href="#/new">${ic('plus', 18)} Новая заявка</a>
        <nav class="nav">${nav}</nav>
        <div class="side-foot">
          <div class="theme-switch" role="group" aria-label="Тема">${themeButtons(theme)}</div>
          <a class="me" href="#/profile"><span class="avatar">${esc(initials(S.me.name))}</span><span style="min-width:0"><b>${esc(S.me.name)}</b><span>${esc(S.me.position || (isHead() ? 'Руководитель' : 'Сотрудник'))}</span></span></a>
        </div>
      </aside>
      <header class="top"><a class="brand" href="#/"><span class="brand-mark">БХ</span><span><b>БХ Учёт</b></span></a>
        <div class="row"><a class="icon-btn" href="#/new" aria-label="Новая заявка">${ic('plus', 20)}</a><a class="icon-btn" href="#/profile" aria-label="Профиль">${ic('user', 20)}</a></div></header>
      <main class="main" id="main">${content}</main>
      <nav class="tabbar">${tabs}</nav>
    </div>`;
  }
  const themeButtons = (theme) => [['light', 'sun', 'Белая'], ['dark', 'moon', 'Чёрная']].map(([t, i, n]) => `<button data-theme-set="${t}" class="${theme === t ? 'on' : ''}">${ic(i, 15)} ${n}</button>`).join('');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('bh-theme', t); } catch { /* приватный режим */ }
    $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t));
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = t === 'dark' ? '#000000' : '#ffffff';
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-theme-set]'); if (b) setTheme(b.dataset.themeSet); });

  async function loadBadges() {
    try {
      const h = await api('/api/home');
      if (isHead()) S.badges = { todo: h.to_approve.length + h.to_close.length || 0, inc: h.incomes.length || 0, flags: h.corrections.length || 0 };
      else S.badges = { todo: h.todo.length || 0 };
      return h;
    } catch { return null; }
  }

  // ================= Рендер =================
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    S.timers.forEach(clearInterval); S.timers = [];
    $('#tip').style.display = 'none';
    const root = $('#root');
    if (!S.me) {
      try { S.me = (await api('/api/me')).user; } catch { S.me = null; }
    }
    if (!S.me) return pageLogin(root);
    if (S.me.must_change_pw) return pageForcePassword(root);
    if (!S.settings) {
      try { [S.settings, S.meta] = await Promise.all([api('/api/settings'), api('/api/meta')]); } catch (e) { return fail(e); }
    }
    const r = route();
    const pages = {
      '': isHead() ? pageHeadHome : pageStaffHome,
      requests: pageRequests, new: pageNew, r: pageRequest, edit: pageEditRequest,
      incomes: pageIncomes, income: pageIncome, 'new-income': pageNewIncome,
      analytics: pageAnalytics, control: pageControl, journal: pageJournal, team: pageTeam, settings: pageSettings,
      profile: pageProfile, more: pageMore,
    };
    const page = pages[r.parts[0] || ''] || pageNotFound;
    const headOnly = ['analytics', 'control', 'journal', 'team', 'settings', 'more'];
    if (headOnly.includes(r.parts[0]) && !isHead()) { root.innerHTML = shell(noAccess()); return; }
    root.innerHTML = shell('<div class="sk" style="height:110px;margin-bottom:16px"></div><div class="sk" style="height:360px"></div>');
    window.scrollTo(0, 0);
    try {
      const html = await page(r);
      if (seq !== renderSeq) return;
      if (typeof html === 'string') { $('#main').innerHTML = html; }
      if (page.after) page.after(r);
    } catch (e) {
      if (seq !== renderSeq) return;
      $('#main').innerHTML = `<div class="card empty">${ic('alert', 32)}<p>${esc(e.message)}</p><a class="btn soft" href="#/">На главную</a></div>`;
    }
    loadBadges().then(() => { if (seq === renderSeq) refreshNavBadges(); });
  }
  function refreshNavBadges() {
    const shellEl = $('.shell'); if (!shellEl) return;
    const tmp = document.createElement('div'); tmp.innerHTML = shell('');
    $('.side .nav', shellEl).innerHTML = $('.side .nav', tmp).innerHTML;
    $('.tabbar', shellEl).innerHTML = $('.tabbar', tmp).innerHTML;
  }
  const noAccess = () => `<div class="card empty">${ic('lock', 36)}<h2>Раздел только для руководителя</h2><p>У вашей учётной записи нет доступа к этой странице.</p><a class="btn soft" href="#/">На главную</a></div>`;
  function pageNotFound() { return `<div class="card empty">${ic('info', 32)}<h2>Страница не найдена</h2><a class="btn soft" href="#/">На главную</a></div>`; }
  const head = (title, sub = '', actions = '', crumbs = '') => `${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="row">${actions}</div></div>`;

  // ================= Вход =================
  // Мысль дня на странице входа — каждый раз новая.
  const MOTTOS = [
    'Большое строится из маленьких шагов, сделанных каждый день.',
    'Сила воли — это выбор, который делаешь снова и снова.',
    'Порядок в делах даёт свободу в мыслях.',
    'Не бывает маленькой работы — бывает работа, сделанная с душой.',
    'Мы сильны, когда держим слово: друг перед другом и перед делом.',
    'Сегодня — лучший день, чтобы сделать работу хорошо.',
    'Тот, кто начинает вовремя, приходит первым.',
    'Хорошая база — это люди, которые не сдаются.',
  ];
  function pageLogin(root) {
    root.innerHTML = `<div class="auth">
      <section class="auth-art">
        <a class="brand"><span class="brand-mark">БХ</span><span><b>БХ Учёт</b><span>подразделение БХ</span></span></a>
        <div><h1>Сильные дела начинаются с порядка</h1><p>Мы строим базу, на которую можно опереться. День за днём — честно, слаженно и с уважением к общему делу.</p>
          <blockquote class="motto">${esc(MOTTOS[Math.floor(Math.random() * MOTTOS.length)])}</blockquote></div>
        <div class="pts">
          <div class="pt">${ic('users', 20)}<span><b>Одна команда</b>Задачи, решения и результаты — в одном месте. Каждый видит свой вклад в общее дело.</span></div>
          <div class="pt">${ic('sparkles', 20)}<span><b>Право на ошибку</b>Ошибся — спокойно поправь. Так мы учимся и становимся сильнее.</span></div>
          <div class="pt">${ic('trendUp', 20)}<span><b>Видно, как мы растём</b>Результаты подразделения — наглядно, по месяцам и по каждому объекту.</span></div>
        </div>
      </section>
      <section class="auth-form"><form class="box" id="lf" novalidate>
        <div><h2 style="margin-bottom:4px">Добро пожаловать</h2><p class="muted" style="margin:0">Войдите, чтобы продолжить работу.</p></div>
        <label class="field"><span>Логин</span><input class="input" name="login" autocomplete="username" autocapitalize="none" required></label>
        <label class="field"><span>Пароль</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn lg block">Войти</button>
        <p class="faint xs" style="margin:0">Нет доступа или забыли пароль? Обратитесь к руководителю подразделения — он выдаст новый.</p>
      </form></section></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target; const btn = $('button', f); btn.disabled = true;
      try {
        const r = await post('/api/login', { login: f.login.value.trim(), password: f.password.value });
        S.me = r.user; S.settings = null;
        go('#/');
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
    setTimeout(() => $('#lf input').focus(), 30);
  }
  function pageForcePassword(root) {
    root.innerHTML = `<div class="auth"><section class="auth-art"><a class="brand"><span class="brand-mark">БХ</span><span><b>БХ Учёт</b></span></a>
      <div><h1>Придумайте свой пароль</h1><p>Вы вошли по временному паролю. Задайте постоянный — его будете знать только вы.</p></div><div></div></section>
      <section class="auth-form"><form class="box" id="pf" novalidate>
        <h2 style="margin:0">Смена пароля</h2>
        <label class="field"><span>Временный пароль</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>Новый пароль</span><input class="input" name="next" type="password" autocomplete="new-password" required><small class="hint">Минимум 8 символов, буквы и цифры</small></label>
        <label class="field"><span>Ещё раз</span><input class="input" name="again" type="password" autocomplete="new-password" required></label>
        <button class="btn lg block">Сохранить и войти</button>
        <button type="button" class="link-btn" id="lo">Выйти</button>
      </form></section></div>`;
    $('#pf').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      if (f.next.value !== f.again.value) return toast('Пароли не совпадают', true);
      try { await post('/api/me/password', { current: f.current.value, next: f.next.value }); S.me.must_change_pw = false; toast('Пароль сохранён'); go('#/'); } catch (err) { fail(err); }
    };
    $('#lo').onclick = logout;
  }
  async function logout() { try { await post('/api/logout'); } catch { /* всё равно выходим */ } S.me = null; S.settings = null; go('#/login'); }

  // ================= Компоненты =================
  function reqLi(r, { showUser = isHead() } = {}) {
    const timer = r.status === 'pending' && r.edit_until > Date.now() && !isHead() ? `<span class="timer" data-until="${r.edit_until}">${ic('clock', 13)} правка ${left(r.edit_until)}</span>` : '';
    const sum = r.actual_total != null ? r.actual_total : r.approved_amount ?? r.amount;
    const meta = [esc(r.number), kindText(r), showUser ? esc(r.user_name) : '', r.object ? esc(r.object) : '', r.actual_total != null ? `план ${money(r.approved_amount ?? r.amount)}` : dOnly(r.created_at)].filter(Boolean).join(' · ');
    return `<a class="li" href="#/r/${r.id}">
      <div class="t1">${esc(r.title)}</div><div class="amt">${money(sum)}</div>
      <div class="t2" style="grid-column:1/-1">${pill(r.status, r.status_text)}${timer}${r.changed_after_approval && isHead() ? `<span class="tag" style="color:var(--warn)">${ic('edit', 12)} менялась</span>` : ''}<span>${meta}</span></div>
    </a>`;
  }
  const listCard = (title, items, empty, more = '') => `<div class="card flush"><div class="card-h" style="padding:16px 18px 0">${title}${more}</div>
    <div class="list" style="margin-top:6px">${items.length ? items.join('') : `<div class="empty">${empty}</div>`}</div></div>`;
  function kpi(label, value, cmp = '', cls = '', dot = '') {
    return `<div class="kpi ${cls}"><div class="lbl">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${label}</div><div class="val">${value}</div>${cmp ? `<div class="cmp">${cmp}</div>` : ''}</div>`;
  }
  function delta(curV, prevV, invert = false) {
    if (!prevV) return '<span class="faint">нет данных за прошлый период</span>';
    const p = pct(curV, prevV);
    const good = invert ? p <= 0 : p >= 0;
    return `<span class="${good ? 'up' : 'down'}">${p > 0 ? '+' : ''}${nf(p, 1)}%</span> к прошлому периоду`;
  }
  function startTimers() {
    const tick = () => $$('[data-until]').forEach((el) => {
      const l = left(Number(el.dataset.until));
      if (!l) { el.classList.add('off'); el.innerHTML = `${ic('lock', 13)} время правки вышло`; } else el.innerHTML = `${ic('clock', 13)} ${el.dataset.prefix || 'правка'} ${l}`;
    });
    tick(); S.timers.push(setInterval(tick, 20000));
  }

  // ---- графики ----
  const tip = $('#tip');
  function showTip(e, html) {
    tip.innerHTML = html; tip.style.display = 'block';
    const w = tip.offsetWidth; const h = tip.offsetHeight;
    let x = e.clientX + 14; let y = e.clientY - h - 10;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y < 8) y = e.clientY + 16;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.style.display = 'none'; };
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const monthName = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[Number(mm) - 1]} ${y.slice(2)}`; };
  const barPath = (x, y, w, h, r = 4) => { if (h <= 0) return ''; r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
  function monthlyChart(rows, W = 760, H = 260) {
    const L = 46; const B = 26; const T = 10; const pw = W - L - 6; const ph = H - B - T;
    const max = Math.max(1, ...rows.map((r) => Math.max(r.income, r.expenses)));
    const step = Math.pow(10, Math.floor(Math.log10(max))); const nice = Math.ceil(max / step / 2) * step * 2 / 4 || 1;
    const top = nice * 4;
    const y = (v) => T + ph - (v / top) * ph;
    const gw = pw / rows.length; const bw = Math.min(16, (gw - 10) / 2);
    let g = '';
    for (let k = 0; k <= 4; k++) { const yy = y(nice * k); g += `<line class="${k ? 'gl' : 'base'}" x1="${L}" x2="${W - 6}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${short(nice * k)}</text>`; }
    rows.forEach((r, k) => {
      const cx = L + gw * k + gw / 2;
      g += `<path d="${barPath(cx - bw - 1, y(r.income), bw, T + ph - y(r.income))}" fill="var(--c-in)"/>`;
      g += `<path d="${barPath(cx + 1, y(r.expenses), bw, T + ph - y(r.expenses))}" fill="var(--c-out)"/>`;
      g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthName(r.month)}</text>`;
      g += `<rect class="hit" data-k="${k}" x="${L + gw * k}" y="${T}" width="${gw}" height="${ph}" rx="6"/>`;
    });
    return `<div class="legend" style="margin-bottom:8px"><span><i class="dot" style="background:var(--c-in)"></i>Доходы</span><span><i class="dot" style="background:var(--c-out)"></i>Расходы</span></div>
      <svg class="chart" id="mchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Доходы и расходы по месяцам">${g}</svg>`;
  }
  function bindMonthly(rows) {
    const svg = $('#mchart'); if (!svg) return;
    svg.addEventListener('mousemove', (e) => {
      const h = e.target.closest('.hit'); if (!h) return hideTip();
      const r = rows[Number(h.dataset.k)];
      showTip(e, `<b>${monthName(r.month)}</b><div class="tr"><span><i class="dot" style="background:var(--c-in)"></i>Доходы</span><span class="num">${money(r.income)}</span></div>
        <div class="tr"><span><i class="dot" style="background:var(--c-out)"></i>Расходы</span><span class="num">${money(r.expenses)}</span></div>
        <div class="tr" style="margin-top:4px;padding-top:4px;border-top:1px solid var(--line)"><span>Прибыль</span><b class="num ${r.profit >= 0 ? 'up' : 'down'}" style="margin:0">${money(r.profit)}</b></div>`);
    });
    svg.addEventListener('mouseleave', hideTip);
  }
  function hbars(rows, { key = 'k', val = 's', inColor = false, extra } = {}) {
    if (!rows.length) return '<div class="empty small">Нет данных за период</div>';
    const max = Math.max(...rows.map((r) => r[val] || 0), 1);
    const total = rows.reduce((s, r) => s + (r[val] || 0), 0);
    return `<div class="hbars">${rows.map((r) => `<div class="hbar"><div class="top-l"><span>${esc(r[key])}</span><span class="num"><b>${money(r[val])}</b> <span class="faint">${total ? nf((r[val] / total) * 100, 0) : 0}%</span>${extra ? extra(r) : ''}</span></div>
      <div class="track"><div class="fill${inColor ? ' in' : ''}" style="width:${Math.max(1, (r[val] / max) * 100)}%"></div></div></div>`).join('')}</div>`;
  }

  // ================= Главная сотрудника =================
  async function pageStaffHome() {
    const h = await api('/api/home');
    const adv = h.advance.balance;
    return `${head(`Здравствуйте, ${esc(S.me.name.split(' ')[0])}`, 'Ваши заявки, отчёты и деньги под отчёт', `<a class="btn" href="#/new">${ic('plus')} Новая заявка</a><a class="btn soft" href="#/new-income">${ic('coins')} Внести доход</a>`)}
      <div class="grid-kpi">
        ${kpi('Нужно сделать', h.todo.length, h.todo.length ? 'отчёт, покупка или доработка' : 'всё сделано', h.todo.length ? 'hl' : '')}
        ${kpi('Ждут руководителя', h.waiting.length, 'на согласовании и проверке')}
        ${kpi('Деньги под отчёт', money(adv), adv > 0 ? `по ${h.advance.open_count} заявк. — нужен отчёт с чеками` : adv < 0 ? 'компания должна вам (перерасход)' : 'долгов нет', adv > 0 ? 'ink' : '')}
        ${kpi('Проведено за месяц', money(h.month.spent), `${h.month.spent_n} заявок · доходы ${money(h.month.income)}`)}
      </div>
      <div class="grid-2">
        ${listCard('<h3>Нужно сделать</h3>', h.todo.map((r) => reqLi(r)), 'Задач нет. Новая покупка — кнопка «Новая заявка».')}
        ${listCard('<h3>Ждут решения</h3>', h.waiting.map((r) => reqLi(r)), 'Нет заявок на согласовании', '<a class="link small" href="#/requests">Все заявки</a>')}
      </div>
      ${h.corrections.length ? `<div class="card" style="margin-top:16px"><h3>Запросы на корректировку</h3><div class="list">${h.corrections.map((c) => `<div class="li"><div class="t1">${esc(c.number)} — ${esc(c.reason)}</div><div>${pill(c.status === 'pending' ? 'pending' : c.status === 'approved' ? 'approved' : 'rejected', { pending: 'Ждёт решения', approved: 'Разрешено', rejected: 'Отказано' }[c.status])}</div></div>`).join('')}</div></div>` : ''}
      <div class="note info" style="margin-top:16px">${ic('info')}<span>Как это работает: <b>заявка</b> (что, сколько, цена, ссылка) → <b>согласование</b> руководителем → покупка → <b>отчёт с чеком</b> → руководитель <b>проводит</b>. На исправление ошибок есть ${nf(S.settings.edit_hours)} ч, дальше — через запрос на корректировку.</span></div>`;
  }
  pageStaffHome.after = startTimers;

  // ================= Обзор руководителя =================
  let headHomeData = null;
  async function pageHeadHome() {
    const h = await api('/api/home'); headHomeData = h;
    const o = h.overview; const c = o.current; const p = o.previous;
    const adv = o.advances.filter((a) => a.balance > 0);
    const corr = h.corrections.map((x) => `<div class="li"><div class="t1">${esc(x.number)} · ${esc(x.user_name)}</div><div class="row"><button class="btn sm" data-corr="${x.id}" data-ok="1">Разрешить</button><button class="btn sm soft" data-corr="${x.id}" data-ok="0">Отказать</button></div>
      <div class="t2" style="grid-column:1/-1"><a class="link" href="#/${x.entity === 'request' ? 'r' : 'income'}/${x.entity_id}">Открыть</a> · ${esc(x.reason)}</div></div>`);
    const inc = h.incomes.map((i) => `<a class="li" href="#/income/${i.id}"><div class="t1">${esc(i.title)}</div><div class="amt up">+${money(i.amount)}</div><div class="t2"><span>${esc(i.number)}</span><span>${esc(i.date)}</span><span>· ${esc(i.user_name)}</span></div></a>`);
    return `${head('Обзор', `Текущий месяц · ${dOnly(Date.parse(o.range.from))} — ${dOnly(Date.parse(o.range.to))}`, `<a class="btn soft" href="#/analytics">${ic('chart')} Аналитика</a>`)}
      <div class="grid-kpi">
        ${kpi('Доходы', money(c.income), delta(c.income, p.income), '', 'var(--c-in)')}
        ${kpi('Расходы', money(c.expenses), delta(c.expenses, p.expenses, true), '', 'var(--c-out)')}
        ${kpi('Прибыль', money(c.profit), c.income ? `рентабельность ${nf((c.profit / c.income) * 100, 1)}%` : 'доходов пока нет', 'ink')}
        ${kpi('Ждут вашего решения', h.to_approve.length + h.to_close.length + h.incomes.length + h.corrections.length, `${h.to_approve.length} заявок · ${h.to_close.length} отчётов · ${h.incomes.length} доходов`, h.to_approve.length + h.to_close.length ? 'hl' : '')}
      </div>
      <div class="grid-2">
        ${listCard(`<h3>На согласование <span class="faint">${h.to_approve.length}</span></h3>`, h.to_approve.map((r) => reqLi(r)), 'Новых заявок нет', '<a class="link small" href="#/requests?status=pending">Все</a>')}
        ${listCard(`<h3>Отчёты на проверку <span class="faint">${h.to_close.length}</span></h3>`, h.to_close.map((r) => reqLi(r)), 'Отчётов на проверке нет', '<a class="link small" href="#/requests?status=review">Все</a>')}
        ${corr.length ? listCard(`<h3>Запросы на корректировку <span class="faint">${corr.length}</span></h3>`, corr, '') : ''}
        ${listCard(`<h3>Доходы на подтверждение <span class="faint">${inc.length}</span></h3>`, inc, 'Новых доходов нет', '<a class="link small" href="#/incomes?status=new">Все</a>')}
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card"><div class="card-h"><h3>Доходы и расходы за 12 месяцев</h3><a class="link small" href="#/analytics">Подробнее</a></div>${monthlyChart(o.monthly, 540, 240)}</div>
        <div class="card"><div class="card-h"><h3>Деньги под отчётом</h3><span class="faint small">выдано, но не отчитано</span></div>
          ${adv.length ? `<table class="t"><tbody>${adv.map((a) => `<tr><td>${esc(a.name)}</td><td class="faint">${a.open_count ? `${a.open_count} заявк. без отчёта` : 'не вернул остаток'}</td><td class="r num"><b>${money(a.balance)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty small">Все выданные деньги отчитаны</div>'}
          <div class="card-h" style="margin:18px 0 10px"><h3>В работе</h3></div>
          <div class="kv"><dt>Согласовано, ждём покупку/отчёт</dt><dd>${money(o.pipeline.filter((x) => ['approved', 'issued', 'report_revision'].includes(x.status)).reduce((s, x) => s + x.s, 0))}</dd>
          <dt>На согласовании</dt><dd>${money(o.pipeline.filter((x) => ['pending', 'revision'].includes(x.status)).reduce((s, x) => s + x.s, 0))}</dd>
          <dt>Среднее время согласования</dt><dd>${o.approval_hours != null ? `${nf(o.approval_hours, 1)} ч` : '—'}</dd></div>
        </div>
      </div>`;
  }
  pageHeadHome.after = () => {
    bindMonthly(headHomeData.overview.monthly);
    $$('[data-corr]').forEach((b) => b.onclick = () => decideCorrection(b.dataset.corr, b.dataset.ok === '1'));
  };
  async function decideCorrection(id, approve) {
    const r = await ask({ title: approve ? 'Разрешить корректировку' : 'Отказать в корректировке', text: approve ? `Сотрудник сможет исправить запись в течение ${nf(S.settings.edit_hours)} ч. Все изменения попадут в журнал.` : '',
      fields: [{ name: 'comment', label: 'Комментарий', type: 'textarea', required: !approve }], ok: approve ? 'Разрешить' : 'Отказать', danger: !approve });
    if (!r) return;
    try { await post(`/api/corrections/${id}/decide`, { approve, comment: r.comment }); toast(approve ? 'Корректировка разрешена' : 'Отказано'); render(); } catch (e) { fail(e); }
  }

  // ================= Список заявок =================
  async function pageRequests(r) {
    const q = r.q; const status = q.status || (isHead() ? 'active' : '');
    const params = new URLSearchParams({ ...q, status }); if (!status) params.delete('status');
    const data = await api(`/api/requests?${params}`);
    const cnt = data.counts; const sumOf = (arr) => arr.reduce((s, k) => s + (cnt[k] || 0), 0);
    const tabs = [['', 'Все', ''], ['active', 'В работе', sumOf(['pending', 'revision', 'approved', 'issued', 'review', 'report_revision'])], ['pending', 'На согласовании', cnt.pending || 0],
      ['review', 'Отчёты', cnt.review || 0], ['revision', 'На доработке', (cnt.revision || 0) + (cnt.report_revision || 0)], ['closed', 'Проведено', cnt.closed || 0], ['off', 'Отклонено/отменено', (cnt.rejected || 0) + (cnt.cancelled || 0)]];
    const link = (s) => { const p2 = new URLSearchParams({ ...q, status: s }); if (!s) p2.delete('status'); return `#/requests?${p2}`; };
    const total = data.items.reduce((s, x) => s + (x.actual_total ?? x.approved_amount ?? x.amount), 0);
    const rows = data.items.map((x) => `<tr class="click" data-href="#/r/${x.id}">
      <td><b>${esc(x.title)}</b><div class="faint xs">${esc(x.number)} · ${kindText(x)}${x.object ? ` · ${esc(x.object)}` : ''}</div></td>
      ${isHead() ? `<td class="hide-m">${esc(x.user_name)}</td>` : ''}
      <td class="hide-m">${dOnly(x.created_at)}</td><td>${pill(x.status, x.status_text)}</td>
      <td class="r num hide-m">${money(x.approved_amount ?? x.amount)}</td><td class="r num"><b>${x.actual_total != null ? money(x.actual_total) : '—'}</b></td></tr>`).join('');
    const users = isHead() ? (await api('/api/head/users')).items.filter((u) => u.role === 'staff' || u.requests) : [];
    return `${head(isHead() ? 'Заявки' : 'Мои заявки', `${data.items.length} шт. на сумму ${money(total)}`, `${isHead() ? `<a class="btn soft" href="/api/head/export?type=requests&${params}" download>${ic('download')} CSV</a>` : ''}<a class="btn" href="#/new">${ic('plus')} Новая заявка</a>`)}
      <div class="tabs" style="margin-bottom:14px">${tabs.map(([s, t, n]) => `<a href="${link(s)}" class="${status === s ? 'on' : ''}">${t}${n ? ` <span class="faint">${n}</span>` : ''}</a>`).join('')}</div>
      <form class="filters" id="rf">
        <input class="input" name="q" placeholder="Поиск: номер, товар, назначение" value="${esc(q.q || '')}">
        <select class="input" name="kind"><option value="">Все типы</option><option value="purchase" ${q.kind === 'purchase' ? 'selected' : ''}>Покупка</option><option value="money" ${q.kind === 'money' ? 'selected' : ''}>Деньги под отчёт</option></select>
        <select class="input" name="object"><option value="">Все объекты</option>${S.settings.objects.map((o) => `<option ${q.object === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
        ${isHead() ? `<select class="input" name="user"><option value="">Все сотрудники</option>${users.map((u) => `<option value="${u.id}" ${String(q.user) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
        <input class="input" type="date" name="from" value="${esc(q.from || '')}" style="flex:0 1 160px" aria-label="С"><input class="input" type="date" name="to" value="${esc(q.to || '')}" style="flex:0 1 160px" aria-label="По">
      </form>
      <div class="card flush">${rows ? `<div class="table-wrap"><table class="t resp"><thead><tr><th>Заявка</th>${isHead() ? '<th class="hide-m">Сотрудник</th>' : ''}<th class="hide-m">Создана</th><th>Статус</th><th class="r hide-m">План</th><th class="r">Факт</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty">${ic('inbox', 32)}Заявок нет${!isHead() ? '<p><a class="btn" href="#/new">Создать первую</a></p>' : ''}</div>`}</div>`;
  }
  pageRequests.after = (r) => {
    const f = $('#rf'); let t;
    const apply = () => { const p = new URLSearchParams(); for (const el of f.elements) if (el.name && el.value) p.set(el.name, el.value); if (r.q.status) p.set('status', r.q.status); go(`#/requests?${p}`); };
    f.oninput = (e) => { clearTimeout(t); t = setTimeout(apply, e.target.name === 'q' ? 450 : 0); };
    f.onsubmit = (e) => { e.preventDefault(); apply(); };
    $$('tr[data-href]').forEach((tr) => tr.onclick = () => go(tr.dataset.href));
  };

  // ================= Новая заявка / редактирование =================
  function itemRow(i = {}, channel = 'online') {
    const units = S.settings.units;
    return `<div class="item-row">
      <label class="field f-name"><span>Наименование</span><input class="input" name="name" value="${esc(i.name || '')}" placeholder="Например: Профильная труба 40×20, 6 м" required></label>
      <label class="field"><span>Кол-во</span><input class="input" name="qty" inputmode="decimal" value="${esc(i.qty ?? 1)}"></label>
      <label class="field"><span>Ед.</span><select class="input" name="unit">${units.map((u) => `<option ${u === (i.unit || 'шт') ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      <label class="field"><span>Цена за ед., ${cur()}</span><input class="input" name="price" inputmode="decimal" value="${esc(i.price ?? '')}" placeholder="0"></label>
      <label class="field f-url">${channel === 'online' ? `<span>Ссылка на товар</span><input class="input" name="url" value="${esc(i.url || '')}" placeholder="https://..." inputmode="url">`
        : `<span>Магазин</span><input class="input" name="shop" value="${esc(i.shop || '')}" placeholder="Где будете покупать">`}</label>
      <button type="button" class="icon-btn f-x" data-del aria-label="Удалить строку">${ic('trash', 18)}</button>
      <div class="sum"><span class="price-hint"></span><span class="num">Сумма: <b data-sum>0</b></span></div>
    </div>`;
  }
  function requestForm(r = null) {
    const kind = r?.kind || route().q.kind || 'purchase';
    const channel = r?.channel || 'online';
    const items = r?.items?.length ? r.items : [{}];
    const s = S.settings;
    return `<form id="nf" class="stack" novalidate>
      ${r ? '' : `<div class="choice">
        <label><input type="radio" name="kind" value="purchase" ${kind === 'purchase' ? 'checked' : ''}><span><b>${ic('bag', 18)} Покупка материалов</b><small>Список товаров с ценами и ссылками. Оплата по ссылке или в магазине.</small></span></label>
        <label><input type="radio" name="kind" value="money" ${kind === 'money' ? 'checked' : ''}><span><b>${ic('wallet', 18)} Деньги под отчёт</b><small>Запросить сумму наличными/на карту. Потом — отчёт с чеками.</small></span></label>
      </div>`}
      <div class="card stack">
        <div class="form-grid">
          <label class="field" style="grid-column:1/-1"><span>Что покупаем / на что деньги</span><input class="input" name="title" value="${esc(r?.title || '')}" placeholder="Коротко: «Металл на навес для склада»" maxlength="160" required></label>
          <label class="field"><span>Объект / заказ</span><select class="input" name="object"><option value="">— не выбран —</option>${s.objects.map((o) => `<option ${r?.object === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
          <label class="field"><span>Категория</span><select class="input" name="category"><option value="">— не выбрана —</option>${s.categories.map((o) => `<option ${r?.category === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
          <label class="field"><span>Нужно к дате</span><input class="input" type="date" name="needed_by" value="${esc(r?.needed_by || '')}" min="${today()}"></label>
        </div>
        <label class="field"><span>Зачем / подробности ${kind === 'money' ? '(обязательно)' : ''}</span><textarea class="input" name="purpose" placeholder="Для чего, почему именно этот товар или сумма">${esc(r?.purpose || '')}</textarea></label>
      </div>
      <div class="card stack" id="money-box" ${kind === 'money' ? '' : 'hidden'}>
        <div class="form-grid"><label class="field"><span>Сумма, ${cur()}</span><input class="input" name="amount" inputmode="decimal" value="${esc(r?.kind === 'money' ? r.amount : '')}" placeholder="0"></label></div>
        <p class="muted small" style="margin:0">Список покупок с ценами вы заполните в отчёте — по чекам. Остаток денег нужно будет вернуть.</p>
      </div>
      <div class="card stack" id="items-box" ${kind === 'money' ? 'hidden' : ''}>
        <div class="card-h" style="margin:0"><h3>Товары</h3>
          <div class="tabs" id="chan"><button type="button" data-ch="online" class="${channel === 'online' ? 'on' : ''}">${ic('link', 15)} Онлайн</button><button type="button" data-ch="offline" class="${channel === 'offline' ? 'on' : ''}">${ic('store', 15)} В магазине</button></div></div>
        <p class="muted small" style="margin:0" id="chan-hint">${channel === 'online' ? 'Для каждого товара — ссылка, где покупаем.' : 'Укажите примерную цену и магазин. После покупки обязательно приложите чек.'}</p>
        <div class="items-edit" id="items">${items.map((i) => itemRow(i, channel)).join('')}</div>
        <button type="button" class="btn soft" id="add-item">${ic('plus')} Добавить товар</button>
        <div class="items-total"><span>Итого по заявке</span><span class="num" id="total">0</span></div>
      </div>
      <input type="hidden" name="channel" value="${channel}">
      <div class="row" style="justify-content:flex-end">
        <a class="btn soft" href="${r ? `#/r/${r.id}` : '#/requests'}">Отмена</a>
        <button class="btn lg">${r ? 'Сохранить изменения' : 'Отправить на согласование'}</button>
      </div>
      ${r ? '' : `<p class="faint small" style="margin:0;text-align:right">${ic('clock', 14)} После отправки у вас будет ${nf(S.settings.edit_hours)} ч, чтобы исправить ошибку самостоятельно.</p>`}
    </form>`;
  }
  function bindRequestForm(existing) {
    const f = $('#nf');
    const kindNow = () => (existing ? existing.kind : f.querySelector('[name=kind]:checked').value);
    const rows = () => $$('.item-row', $('#items'));
    const recalc = () => {
      let t = 0;
      rows().forEach((row) => {
        const q = Number(String(row.querySelector('[name=qty]').value).replace(',', '.')) || 0;
        const p = Number(String(row.querySelector('[name=price]').value).replace(',', '.')) || 0;
        row.querySelector('[data-sum]').textContent = money(q * p); t += q * p;
      });
      $('#total').textContent = money(t);
    };
    f.addEventListener('input', recalc);
    f.addEventListener('change', (e) => {
      if (e.target.name === 'kind') { const m = e.target.value === 'money'; $('#money-box').hidden = !m; $('#items-box').hidden = m; }
    });
    $('#add-item').onclick = () => { $('#items').insertAdjacentHTML('beforeend', itemRow({}, f.channel.value)); rows().at(-1).querySelector('[name=name]').focus(); };
    $('#items').onclick = (e) => { const d = e.target.closest('[data-del]'); if (d && rows().length > 1) { d.closest('.item-row').remove(); recalc(); } };
    $('#chan').onclick = (e) => {
      const b = e.target.closest('[data-ch]'); if (!b) return;
      const items = collectItems();
      f.channel.value = b.dataset.ch;
      $$('#chan button').forEach((x) => x.classList.toggle('on', x === b));
      $('#chan-hint').textContent = b.dataset.ch === 'online' ? 'Для каждого товара — ссылка, где покупаем.' : 'Укажите примерную цену и магазин. После покупки обязательно приложите чек.';
      $('#items').innerHTML = (items.length ? items : [{}]).map((i) => itemRow(i, b.dataset.ch)).join(''); recalc();
    };
    const collectItems = () => rows().map((row) => {
      const v = (n) => row.querySelector(`[name=${n}]`)?.value?.trim() ?? '';
      return { name: v('name'), qty: v('qty').replace(',', '.'), unit: v('unit'), price: v('price').replace(/\s/g, '').replace(',', '.'), url: v('url'), shop: v('shop') };
    }).filter((i) => i.name);
    recalc();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const kind = kindNow();
      const body = { kind, title: f.title.value, object: f.object.value, category: f.category.value, needed_by: f.needed_by.value, purpose: f.purpose.value, channel: f.channel.value };
      if (kind === 'money') { body.amount = f.amount.value.replace(/\s/g, '').replace(',', '.'); body.channel = 'offline'; if (!existing) body.items = []; }
      else body.items = collectItems();
      const btn = $('button.lg', f); btn.disabled = true;
      try {
        if (existing) {
          const res = await put(`/api/requests/${existing.id}`, body);
          toast(res.reapprove ? 'Сохранено. Заявка снова ушла на согласование' : res.changed ? 'Изменения сохранены' : 'Изменений нет');
          go(`#/r/${existing.id}`);
        } else {
          const res = await post('/api/requests', body);
          toast('Заявка отправлена руководителю'); go(`#/r/${res.id}`);
        }
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
  }
  function pageNew() {
    return `${head('Новая заявка', 'Руководитель получит её сразу после отправки', '', '<a href="#/requests">Заявки</a> / новая')}${requestForm()}`;
  }
  pageNew.after = () => bindRequestForm(null);
  let editing = null;
  async function pageEditRequest(r) {
    editing = await api(`/api/requests/${r.parts[1]}`);
    if (!editing.can_edit_plan) throw new Error('Эту заявку сейчас изменить нельзя — время на правку вышло. Отправьте запрос на корректировку.');
    return `${head(`Изменить ${esc(editing.number)}`, editing.status === 'approved' ? '<span class="down">Заявка уже согласована: после изменения она снова уйдёт на согласование.</span>' : 'Все изменения сохраняются в истории заявки', '', `<a href="#/requests">Заявки</a> / <a href="#/r/${editing.id}">${esc(editing.number)}</a> / правка`)}${requestForm(editing)}`;
  }
  pageEditRequest.after = () => bindRequestForm(editing);

  // ================= Заявка =================
  let current = null;
  async function pageRequest(r) {
    current = await api(`/api/requests/${r.parts[1]}`);
    return requestView(current);
  }
  pageRequest.after = () => bindRequest();
  function steps(x) {
    const money = x.kind === 'money';
    const names = ['Заявка', 'Согласование', money ? 'Выдача денег' : 'Покупка', 'Отчёт с чеком', 'Проведено'];
    const at = { pending: 1, revision: 0, approved: 2, issued: 3, review: 4, report_revision: 3, closed: 5 }[x.status] ?? 0;
    if (['rejected', 'cancelled'].includes(x.status)) return '';
    return `<div class="tabs" style="margin-bottom:16px;pointer-events:none">${names.map((n, k) => `<span style="padding:8px 12px;border-radius:10px;font-weight:600;font-size:.84rem;white-space:nowrap;display:inline-flex;gap:6px;align-items:center;${k < at ? 'color:var(--c-in)' : k === at ? 'background:var(--surface);box-shadow:var(--shadow-sm)' : 'color:var(--faint)'}">${k < at ? ic('check', 15) : `${k + 1}.`} ${n}</span>`).join('')}</div>`;
  }
  function requestView(x) {
    const mine = x.mine;
    const plan = x.approved_amount ?? x.amount;
    const reportMode = mine && x.can_edit_report;
    const showActual = x.actual_total != null || reportMode || ['review', 'closed', 'report_revision'].includes(x.status);
    // Таблица позиций
    let items;
    if (reportMode && x.kind === 'money') {
      items = `<div class="stack"><p class="muted small" style="margin:0">Перечислите всё, что купили на выданные деньги, — как в чеке.</p><div class="items-edit" id="ritems">${(x.items.length ? x.items : [{}]).map((i) => moneyRow(i)).join('')}</div>
        <button type="button" class="btn soft" id="radd">${ic('plus')} Добавить позицию</button></div>`;
    } else {
      const rows = x.items.map((i) => {
        const hist = isHead() && i.history && i.history.count ? `<div class="price-hint ${i.price_flag ? 'bad' : ''}">${i.price_flag ? `${ic('alert', 12)} +${nf(i.price_flag, 1)}% к обычной · ` : ''}обычно ${money(i.history.median)} (${i.history.count} покуп., мин ${money(i.history.min)})</div>` : '';
        const link = i.url ? `<a class="link xs" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer nofollow">${ic('link', 12)} ${esc(new URL(i.url).hostname.replace(/^www\./, ''))}</a>` : i.shop ? `<span class="faint xs">${ic('store', 12)} ${esc(i.shop)}</span>` : '';
        const aq = i.actual_qty ?? i.qty; const ap = i.actual_price;
        const actualCells = reportMode
          ? `<td class="r"><input class="input" style="height:36px;width:80px;text-align:right" data-aq="${i.id}" inputmode="decimal" value="${esc(i.actual_qty ?? i.qty)}"></td><td class="r"><input class="input" style="height:36px;width:110px;text-align:right" data-ap="${i.id}" inputmode="decimal" value="${esc(i.actual_price ?? '')}" placeholder="по чеку"></td><td class="r num" data-asum="${i.id}">${ap != null ? money(aq * ap) : '—'}</td>`
          : showActual ? `<td class="r num">${nf(aq)}</td><td class="r num ${ap != null && ap > i.price * 1.001 && x.kind === 'purchase' ? 'down' : ''}">${money(ap)}</td><td class="r num"><b>${ap != null ? money(aq * ap) : '—'}</b></td>` : '';
        return `<tr><td><b>${esc(i.name)}</b><div class="row" style="gap:8px">${link}</div>${hist}</td>
          ${x.kind === 'purchase' ? `<td class="r num">${nf(i.qty)} ${esc(i.unit)}</td><td class="r num">${money(i.price)}</td><td class="r num">${money(i.qty * i.price)}</td>` : `<td class="r num">${esc(i.unit)}</td>`}
          ${actualCells}</tr>`;
      }).join('');
      const headRow = `<tr><th>Позиция</th>${x.kind === 'purchase' ? '<th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Сумма</th>' : '<th class="r">Ед.</th>'}${showActual ? '<th class="r">Кол-во факт</th><th class="r">Цена по чеку</th><th class="r">Сумма факт</th>' : ''}</tr>`;
      const foot = `<tr><td>Итого</td>${x.kind === 'purchase' ? `<td></td><td></td><td class="r num">${money(x.amount)}</td>` : '<td></td>'}${showActual ? `<td></td><td></td><td class="r num" id="atotal">${money(x.actual_total)}</td>` : ''}</tr>`;
      items = x.items.length ? `<div class="table-wrap"><table class="t"><thead>${headRow}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div>` : '<div class="empty small">Позиции появятся в отчёте</div>';
    }
    const files = x.files.map((f) => fileCard(f, mine && (x.can_edit_report || x.can_edit_plan || ['pending', 'revision'].includes(x.status)))).join('');
    const canUpload = mine && (x.can_edit_report || ['pending', 'revision', 'approved'].includes(x.status));
    const flags = isHead() && x.flags?.length ? `<div class="card stack"><h3 style="margin:0">${ic('shield', 18)} Проверка</h3>${x.flags.map((f) => `<div class="flag ${f.level}">${ic(f.level === 'low' ? 'info' : 'alert', 16)}<span>${esc(f.text)}</span></div>`).join('')}</div>`
      : isHead() ? `<div class="note ok">${ic('checkCircle')}<span>Автопроверка: замечаний нет — цены в норме, чек на месте.</span></div>` : '';
    const comment = x.head_comment ? `<div class="note ${['revision', 'report_revision', 'rejected'].includes(x.status) ? 'warn' : ''}">${ic('chat')}<span><b>Руководитель:</b> ${esc(x.head_comment)}</span></div>` : '';
    return `${head(esc(x.title), `${esc(x.number)} · ${kindText(x)} · ${esc(x.user_name)} · ${dt(x.created_at)}`, `${pill(x.status, x.status_text)}<button class="btn soft sm no-print" id="print">${ic('printer', 16)} Печать</button>`, `<a href="#/requests">Заявки</a> / ${esc(x.number)}`)}
      ${steps(x)}
      <div class="detail">
        <div class="stack">
          ${comment}
          ${x.purpose ? `<div class="card"><div class="muted small" style="margin-bottom:4px">Назначение</div>${esc(x.purpose).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="card"><div class="card-h"><h3>${reportMode ? 'Отчёт: цены и количество по чеку' : 'Позиции'}</h3>${reportMode ? '<span class="faint small">сохраняется автоматически при отправке</span>' : ''}</div>${items}
            ${reportMode && x.kind === 'money' ? `<div class="form-grid" style="margin-top:14px"><label class="field"><span>Возвращаю остаток, ${cur()}</span><input class="input" id="ret" inputmode="decimal" value="${esc(x.returned_amount ?? '')}" placeholder="0"></label></div>` : ''}
            ${reportMode ? `<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn soft" id="save-report">Сохранить черновик</button><button class="btn" id="send-report">${ic('send', 18)} ${x.status === 'review' ? 'Сохранить исправления' : 'Отправить отчёт'}</button></div>` : ''}
          </div>
          <div class="card"><div class="card-h"><h3>Чеки и документы</h3>${x.files.length ? `<span class="faint small">${x.files.length} файл.</span>` : ''}</div>
            ${x.files.length ? `<div class="files">${files}</div>` : !canUpload ? '<div class="empty small">Файлов нет</div>' : ''}
            ${canUpload ? `<label class="drop" id="drop" style="margin-top:${x.files.length ? 12 : 0}px">${ic('upload', 26)}<b>Прикрепить чек, накладную или фото</b><span class="small">JPG, PNG, PDF до 10 МБ · с телефона можно сразу сфотографировать</span>
              <input type="file" id="file-in" accept="image/*,application/pdf" multiple hidden></label>` : ''}
            <div id="ai-out"></div>
          </div>
          <div class="card"><h3>История</h3>${timeline(x.events)}</div>
        </div>
        <div class="aside">
          ${actionsPanel(x)}
          <div class="card"><h3>Деньги</h3>
            <div class="money-line"><span class="muted">По заявке</span><b>${money(x.amount)}</b></div>
            ${x.approved_amount != null ? `<div class="money-line"><span class="muted">Согласовано</span><b>${money(x.approved_amount)}</b></div>` : ''}
            ${x.issued_amount != null ? `<div class="money-line"><span class="muted">Выдано на руки</span><b>${money(x.issued_amount)}</b></div>` : ''}
            ${x.actual_total != null ? `<div class="money-line"><span class="muted">Потрачено по чекам</span><b class="${x.actual_total > plan * 1.001 ? 'down' : ''}">${money(x.actual_total)}</b></div>` : ''}
            ${x.returned_amount != null ? `<div class="money-line"><span class="muted">Возвращено</span><b>${money(x.returned_amount)}</b></div>` : ''}
            ${x.issued_amount != null && x.actual_total != null ? `<div class="money-line"><span class="muted">Остаток / долг</span><b>${money(x.issued_amount - x.actual_total - (x.returned_amount || 0))}</b></div>` : ''}
            ${x.actual_total != null && plan ? `<div class="money-line"><span class="muted">Отклонение от плана</span><b class="${x.actual_total > plan ? 'down' : 'up'}">${x.actual_total > plan ? '+' : ''}${nf(pct(x.actual_total, plan), 1)}%</b></div>` : ''}
          </div>
          ${flags}
          <div class="card"><dl class="kv">
            <dt>Сотрудник</dt><dd>${esc(x.user_name)}</dd>
            ${x.object ? `<dt>Объект</dt><dd>${esc(x.object)}</dd>` : ''}${x.category ? `<dt>Категория</dt><dd>${esc(x.category)}</dd>` : ''}
            ${x.needed_by ? `<dt>Нужно к</dt><dd>${dOnly(Date.parse(x.needed_by))}</dd>` : ''}
            <dt>Создана</dt><dd>${dt(x.created_at)}</dd>
            ${x.decided_at ? `<dt>Решение</dt><dd>${dt(x.decided_at)} · ${esc(x.decided_by_name)}</dd>` : ''}
            ${x.reported_at ? `<dt>Отчёт</dt><dd>${dt(x.reported_at)}</dd>` : ''}
            ${x.closed_at ? `<dt>Проведено</dt><dd>${dt(x.closed_at)} · ${esc(x.closed_by_name)}</dd>` : ''}
          </dl></div>
          ${x.corrections.length ? `<div class="card"><h3>Корректировки</h3>${x.corrections.map((c) => `<div class="ev" style="grid-template-columns:1fr"><div><b>${{ pending: 'Ждёт решения', approved: 'Разрешена', rejected: 'Отказано' }[c.status]}</b> <span class="when">${dt(c.created_at)}</span><div class="quote">${esc(c.reason)}</div>${c.decision_comment ? `<div class="small muted" style="margin-top:4px">Ответ: ${esc(c.decision_comment)}</div>` : ''}</div></div>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }
  function moneyRow(i = {}) {
    return `<div class="item-row" style="grid-template-columns:minmax(0,2.4fr) 90px 90px 120px 40px">
      <label class="field f-name"><span>Что купили</span><input class="input" name="name" value="${esc(i.name || '')}" placeholder="Как в чеке"></label>
      <label class="field"><span>Кол-во</span><input class="input" name="qty" inputmode="decimal" value="${esc(i.actual_qty ?? i.qty ?? 1)}"></label>
      <label class="field"><span>Ед.</span><select class="input" name="unit">${S.settings.units.map((u) => `<option ${u === (i.unit || 'шт') ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      <label class="field"><span>Цена за ед.</span><input class="input" name="price" inputmode="decimal" value="${esc(i.actual_price ?? i.price ?? '')}"></label>
      <button type="button" class="icon-btn f-x" data-del aria-label="Удалить">${ic('trash', 18)}</button>
      <label class="field" style="grid-column:1/-1"><input class="input" name="shop" value="${esc(i.shop || '')}" placeholder="Магазин (необязательно)" style="height:36px"></label>
    </div>`;
  }
  function fileCard(f, canDelete) {
    const img = f.mime.startsWith('image/') && f.mime !== 'image/heic';
    const kinds = { receipt: 'Чек', invoice: 'Накладная / счёт', photo: 'Фото', other: 'Документ' };
    return `<div class="file"><div class="thumb" data-view="${f.id}" data-mime="${esc(f.mime)}">${img ? `<img src="/api/files/${f.id}" alt="${esc(f.orig_name)}" loading="lazy">` : ic('doc', 36)}</div>
      <div class="meta"><b title="${esc(f.orig_name)}">${esc(f.orig_name)}</b><span class="faint">${kinds[f.kind] || 'Файл'} · ${nf(f.size / 1024, 0)} КБ</span>
        ${S.meta.ai && f.mime !== 'image/heic' ? `<button class="link-btn xs" data-ai="${f.id}" style="justify-self:start">${ic('sparkles', 13)} ${f.ai ? 'Результат ИИ' : 'Распознать ИИ'}</button>` : ''}</div>
      ${canDelete ? `<button class="x" data-rm="${f.id}" aria-label="Убрать файл">${ic('x', 15)}</button>` : ''}</div>`;
  }
  const EV = {
    created: ['Заявка создана', 'plus', 'hl'], edited: ['Изменена', 'edit', 'warn'], edited_after_approval: ['Изменена после согласования', 'edit', 'bad'],
    approved: ['Согласовано', 'checkCircle', 'hl'], rejected: ['Отклонено', 'xCircle', 'bad'], returned: ['Возвращено на доработку', 'refresh', 'warn'],
    resubmitted: ['Отправлено повторно', 'send', ''], issued: ['Деньги выданы', 'wallet', 'hl'], report_draft: ['Черновик отчёта', 'edit', ''],
    report_submitted: ['Отчёт отправлен', 'send', 'hl'], report_edited: ['Отчёт исправлен после отправки', 'edit', 'warn'], report_returned: ['Отчёт возвращён на доработку', 'refresh', 'warn'],
    closed: ['Проведено', 'check', 'hl'], cancelled: ['Отменено', 'xCircle', 'bad'], comment: ['Комментарий', 'chat', ''], file_added: ['Добавлен файл', 'upload', ''],
    file_removed: ['Файл убран', 'trash', 'warn'], correction_requested: ['Запрос на корректировку', 'unlock', 'warn'], correction_approved: ['Корректировка разрешена', 'unlock', 'hl'],
    correction_rejected: ['В корректировке отказано', 'lock', 'bad'], ai_receipt: ['Чек распознан ИИ', 'sparkles', ''], confirmed: ['Подтверждено', 'checkCircle', 'hl'],
    login: ['Вход в систему', 'user', ''], login_failed: ['Неудачный вход', 'alert', 'bad'], logout: ['Выход', 'logout', ''], password_changed: ['Сменён пароль', 'lock', ''],
    password_reset: ['Пароль сброшен руководителем', 'lock', 'warn'], user_created: ['Добавлен сотрудник', 'users', 'hl'], user_updated: ['Изменён сотрудник', 'users', 'warn'],
    settings_updated: ['Изменены настройки', 'sliders', 'warn'], exported: ['Выгрузка CSV', 'download', ''], bootstrap: ['Система создана', 'sparkles', ''], demo_seeded: ['Загружены демо-данные', 'sparkles', ''],
  };
  const FIELD = { title: 'Название', purpose: 'Назначение', object: 'Объект', category: 'Категория', needed_by: 'Срок', channel: 'Способ', amount: 'Сумма', qty: 'кол-во', unit: 'ед.', price: 'цена',
    url: 'ссылка', shop: 'магазин', actual_qty: 'кол-во по чеку', actual_price: 'цена по чеку', returned_amount: 'возврат', date: 'Дата', client: 'Клиент', method: 'Оплата', comment: 'Комментарий',
    name: 'Имя', position: 'Должность', phone: 'Телефон', role: 'Роль', active: 'Активен', edit_hours: 'Часы на правку', price_alert_pct: 'Порог цены, %', overspend_alert_pct: 'Порог перерасхода, %',
    categories: 'Категории', income_categories: 'Категории доходов', objects: 'Объекты', units: 'Единицы' };
  const fv = (v) => (v == null || v === '' ? '∅' : Array.isArray(v) ? v.join(', ') : String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v));
  function evBody(e) {
    const d = e.data || {}; let out = '';
    if (d.changes?.length) out += `<div class="diff">${d.changes.slice(0, 30).map((c) => c.change ? `<span>${esc(c.item)}: <b>${esc(c.change)}</b>${c.price != null ? ` (${nf(c.qty)} × ${money(c.price)})` : ''}</span>`
      : `<span>${c.item ? `${esc(c.item)} — ` : ''}${esc(FIELD[c.field] || c.field)}: <s>${esc(fv(c.from))}</s> → <ins>${esc(fv(c.to))}</ins></span>`).join('')}</div>`;
    if (d.comment) out += `<div class="quote">${esc(d.comment)}</div>`;
    if (d.reason) out += `<div class="quote">${esc(d.reason)}</div>`;
    const bits = [];
    if (d.approved_amount != null) bits.push(`согласовано ${money(d.approved_amount)}`);
    if (d.issued_amount != null) bits.push(`выдано ${money(d.issued_amount)}`);
    if (d.actual_total != null && e.action !== 'closed') bits.push(`по чекам ${money(d.actual_total)}`);
    if (d.amount != null && e.action === 'created') bits.push(money(d.amount));
    if (d.name && e.action.startsWith('file')) bits.push(esc(d.name));
    if (d.duplicate_of) bits.push(`<span class="down">тот же файл уже есть в ${esc(d.duplicate_of)}</span>`);
    if (d.total != null && e.action === 'ai_receipt') bits.push(`итог в чеке ${money(d.total)}`);
    if (d.until) bits.push(`до ${dt(d.until)}`);
    if (d.ip && isHead()) bits.push(`IP ${esc(d.ip)}`);
    if (bits.length) out += `<div class="diff">${bits.join(' · ')}</div>`;
    return out;
  }
  function timeline(events) {
    if (!events.length) return '<div class="empty small">Пока пусто</div>';
    return `<div class="timeline">${events.slice().reverse().map((e) => { const [t, i, c] = EV[e.action] || [e.action, 'info', '']; return `<div class="ev"><span class="ic ${c}">${ic(i, 13)}</span><div><b>${t}</b> <span class="when">${dt(e.ts)} · ${esc(e.user_name || 'система')}</span>${evBody(e)}</div></div>`; }).join('')}</div>`;
  }
  function actionsPanel(x) {
    const b = [];
    const now = x.now || Date.now();
    if (isHead() && !x.mine) {
      if (x.status === 'pending') b.push(`<button class="btn block lg" data-h="approve">${ic('check')} Согласовать</button><div class="row"><button class="btn soft" style="flex:1" data-h="return">${ic('refresh', 16)} На доработку</button><button class="btn danger" style="flex:1" data-h="reject">Отклонить</button></div>`);
      if (x.status === 'approved') b.push(`<button class="btn block lg" data-h="issue">${ic('wallet')} Выдать деньги</button><p class="faint small" style="margin:0">${x.kind === 'money' ? 'Отметьте, когда передадите деньги сотруднику.' : 'Если сотрудник покупает за наличные — отметьте выдачу. Если оплачиваете сами по ссылке — ждите отчёт с чеком.'}</p>`);
      if (x.status === 'issued') b.push(`<div class="note">${ic('clock')}<span>Деньги у сотрудника. Ждём отчёт с чеками.</span></div>`);
      if (x.status === 'review') b.push(`<button class="btn block lg" data-h="close">${ic('check')} Провести</button><button class="btn soft block" data-h="return">${ic('refresh', 16)} Вернуть отчёт</button>`);
      if (['revision', 'report_revision'].includes(x.status)) b.push(`<div class="note info">${ic('refresh')}<span>У сотрудника на доработке.</span></div>`);
      b.push(`<button class="btn outline block sm" data-h="comment">${ic('chat', 16)} Комментарий</button>`);
    }
    if (x.mine) {
      const windowOpen = x.edit_until > now;
      if (['pending', 'approved'].includes(x.status) && windowOpen && x.can_edit_plan) b.push(`<span class="timer" data-until="${x.edit_until}">${ic('clock', 13)}</span>`);
      if (x.status === 'review' && windowOpen) b.push(`<span class="timer" data-until="${x.edit_until}" data-prefix="правка отчёта">${ic('clock', 13)}</span>`);
      if (x.can_edit_plan) b.push(`<a class="btn soft block" href="#/edit/${x.id}">${ic('edit', 16)} Изменить заявку</a>`);
      if (x.status === 'revision') b.push(`<button class="btn block lg" data-s="resubmit">${ic('send')} Отправить снова</button>`);
      if (['approved', 'issued'].includes(x.status) && !x.files.some((f) => f.kind === 'receipt')) b.push(`<div class="note ok">${ic('checkCircle')}<span>${x.status === 'issued' ? 'Деньги выданы.' : 'Согласовано — можно покупать.'} После покупки заполните цены по чеку и прикрепите чек.</span></div>`);
      if (['pending', 'revision', 'approved'].includes(x.status)) b.push(`<button class="btn danger block sm" data-s="cancel">Отменить заявку</button>`);
      const locked = !x.can_edit_plan && !x.can_edit_report && !['rejected', 'cancelled'].includes(x.status) && !['revision'].includes(x.status);
      const pendingCorr = x.corrections.some((c) => c.status === 'pending');
      if (locked) b.push(pendingCorr ? `<div class="note">${ic('clock')}<span>Запрос на корректировку отправлен. Ждите решения руководителя.</span></div>`
        : `<button class="btn outline block" data-s="correction">${ic('unlock', 16)} Запросить корректировку</button><p class="faint small" style="margin:0">Время на самостоятельную правку вышло. Опишите, что нужно исправить, — руководитель откроет запись на ${nf(S.settings.edit_hours)} ч.</p>`);
    }
    return b.length ? `<div class="card stack">${b.join('')}</div>` : '';
  }
  function bindRequest() {
    const x = current;
    startTimers();
    $('#print').onclick = () => window.print();
    $$('[data-h]').forEach((b) => b.onclick = () => headDo(x, b.dataset.h));
    $$('[data-s]').forEach((b) => b.onclick = () => staffDo(x, b.dataset.s));
    // отчёт
    const recalcActual = () => {
      let t = 0;
      x.items.forEach((i) => {
        const aq = $(`[data-aq="${i.id}"]`); const ap = $(`[data-ap="${i.id}"]`); if (!aq) return;
        const q = Number(aq.value.replace(',', '.')) || 0; const p = ap.value === '' ? null : Number(ap.value.replace(',', '.'));
        $(`[data-asum="${i.id}"]`).textContent = p == null ? '—' : money(q * p); t += q * (p || 0);
      });
      if ($('#atotal')) $('#atotal').textContent = money(t);
    };
    $$('[data-aq],[data-ap]').forEach((el) => el.oninput = recalcActual);
    if ($('#radd')) {
      $('#radd').onclick = () => $('#ritems').insertAdjacentHTML('beforeend', moneyRow({}));
      $('#ritems').onclick = (e) => { const d = e.target.closest('[data-del]'); if (d) d.closest('.item-row').remove(); };
    }
    const reportBody = () => {
      if (x.kind === 'money') {
        const items = $$('#ritems .item-row').map((row) => {
          const v = (n) => row.querySelector(`[name=${n}]`).value.trim().replace(/\s/g, n === 'name' || n === 'shop' ? ' ' : '');
          return { name: v('name'), qty: v('qty').replace(',', '.'), unit: v('unit'), price: v('price').replace(',', '.'), actual_price: v('price').replace(',', '.'), actual_qty: v('qty').replace(',', '.'), shop: v('shop') };
        }).filter((i) => i.name);
        return { part: 'report', items, returned_amount: ($('#ret')?.value || '').replace(',', '.') };
      }
      return { part: 'report', items: x.items.map((i) => ({ id: i.id, actual_qty: $(`[data-aq="${i.id}"]`).value.replace(',', '.'), actual_price: $(`[data-ap="${i.id}"]`).value.replace(/\s/g, '').replace(',', '.') })) };
    };
    const saveReport = async () => { const res = await put(`/api/requests/${x.id}`, reportBody()); current = res.request; return res; };
    if ($('#save-report')) $('#save-report').onclick = async () => { try { await saveReport(); toast('Черновик сохранён'); render(); } catch (e) { fail(e); } };
    if ($('#send-report')) $('#send-report').onclick = async () => {
      try {
        await saveReport();
        if (x.status === 'review') { toast('Исправления сохранены'); return render(); }
        if (!(await confirmBox('Отправить отчёт?', 'Руководитель проверит цены и чек и проведёт заявку. После отправки у вас будет время на исправление ошибок.', 'Отправить'))) return render();
        await post(`/api/requests/${x.id}/action`, { action: 'submit_report' }); toast('Отчёт отправлен'); render();
      } catch (e) { fail(e); }
    };
    bindFiles({ request_id: x.id }, x);
  }
  function bindFiles(owner, x) {
    const input = $('#file-in'); const drop = $('#drop');
    const upload = async (files) => {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) { toast(`${file.name}: больше 25 МБ`, true); continue; }
        let kind = 'receipt';
        if (x && x.kind === 'purchase' && x.status === 'pending') kind = 'other';
        try {
          toast(`Загрузка: ${file.name}…`);
          const data = await prepareFile(file);
          await post('/api/files', { ...owner, kind, name: file.name, data });
          toast('Файл прикреплён');
        } catch (e) { fail(e); }
      }
      render();
    };
    if (input) input.onchange = () => upload([...input.files]);
    if (drop) {
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
    }
    $$('[data-rm]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('Убрать файл?', 'Файл будет откреплён, запись об этом останется в истории.', 'Убрать', true))) return;
      try { await api(`/api/files/${b.dataset.rm}`, { method: 'DELETE' }); toast('Файл убран'); render(); } catch (e) { fail(e); }
    });
    $$('[data-view]').forEach((t) => t.onclick = () => {
      const id = t.dataset.view; const pdf = t.dataset.mime === 'application/pdf';
      modal(`<div class="row between"><h2>Документ</h2><div class="row"><a class="btn soft sm" href="/api/files/${id}?download=1">${ic('download', 16)} Скачать</a><button class="icon-btn" data-close>${ic('x')}</button></div></div>
        ${pdf ? `<iframe class="viewer" src="/api/files/${id}" title="PDF"></iframe>` : `<img class="viewer-img" src="/api/files/${id}" alt="">`}`, { wide: true });
    });
    $$('[data-ai]').forEach((b) => b.onclick = () => runAi(b.dataset.ai, x));
  }
  // Большие фото сжимаем в браузере, чтобы не грузить по 8 МБ с телефона.
  function prepareFile(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('Не удалось прочитать файл'));
      rd.onload = () => {
        const url = rd.result;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 2.5 * 1024 * 1024) return resolve(url);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 2400 / Math.max(img.width, img.height));
          const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => resolve(url);
        img.src = url;
      };
      rd.readAsDataURL(file);
    });
  }
  async function runAi(fileId, x) {
    const out = $('#ai-out');
    out.innerHTML = `<div class="ai-box" style="margin-top:12px">${ic('sparkles')} ИИ читает чек…</div>`;
    try {
      const { result: a } = await post(`/api/files/${fileId}/ai`);
      const canApply = x && x.mine && x.can_edit_report;
      const reported = x && x.actual_total != null ? x.actual_total : null;
      const mismatch = reported != null && a.total && Math.abs(a.total - reported) > Math.max(1, a.total * 0.03);
      out.innerHTML = `<div class="ai-box" style="margin-top:12px">
        <div class="row between"><b>${ic('sparkles', 16)} ${a.is_receipt ? 'Распознано' : 'Похоже, это не чек'}</b><span class="faint xs">${esc(a.store || '')} ${a.date ? `· ${esc(a.date)}` : ''}</span></div>
        <table class="t"><thead><tr><th>Позиция</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Сумма</th></tr></thead><tbody>${a.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="r num">${nf(i.qty)}</td><td class="r num">${money(i.unit_price)}</td><td class="r num">${money(i.sum)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Итог в чеке</td><td></td><td></td><td class="r num">${money(a.total)}</td></tr></tfoot></table>
        ${mismatch ? `<div class="flag high">${ic('alert', 16)}<span>В отчёте указано ${money(reported)}, а в чеке — ${money(a.total)}.</span></div>` : ''}
        ${a.notes ? `<div class="small muted">${ic('info', 13)} ${esc(a.notes)}</div>` : ''}
        ${canApply ? `<div class="row"><button class="btn sm" id="ai-apply">Подставить цены из чека</button><span class="faint xs">Проверьте результат перед отправкой</span></div>` : ''}
      </div>`;
      if (canApply) $('#ai-apply').onclick = () => applyAi(a, x);
    } catch (e) { out.innerHTML = ''; fail(e); }
  }
  const words = (s) => new Set(String(s).toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  function similarity(a, b) { const A = words(a); const B = words(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n++; }); return n / Math.min(A.size, B.size); }
  function applyAi(a, x) {
    if (x.kind === 'money') {
      $('#ritems').innerHTML = a.items.map((i) => moneyRow({ name: i.name, qty: i.qty || 1, price: i.unit_price || (i.qty ? i.sum / i.qty : i.sum), shop: a.store })).join('') || moneyRow({});
      toast('Позиции подставлены из чека'); return;
    }
    let hit = 0;
    x.items.forEach((it) => {
      let best = null; let score = 0;
      a.items.forEach((ai) => { const s = similarity(it.name, ai.name); if (s > score) { score = s; best = ai; } });
      if (best && score >= 0.34) {
        $(`[data-ap="${it.id}"]`).value = best.unit_price || (best.qty ? Math.round((best.sum / best.qty) * 100) / 100 : best.sum);
        if (best.qty) $(`[data-aq="${it.id}"]`).value = best.qty; hit++;
      }
    });
    $$('[data-ap]')[0]?.dispatchEvent(new Event('input'));
    toast(hit ? `Подставлено ${hit} из ${x.items.length}. Остальное — вручную` : 'Не удалось сопоставить позиции — заполните вручную', !hit);
  }
  async function headDo(x, action) {
    let body = { action };
    if (action === 'approve') {
      const r = await ask({ title: `Согласовать ${x.number}`, text: `Сумма по заявке: <b>${money(x.amount)}</b>`, fields: [{ name: 'approved_amount', label: `Согласованная сумма, ${cur()}`, type: 'money', value: x.amount, hint: 'Можно согласовать меньшую сумму' }, { name: 'comment', label: 'Комментарий (необязательно)', type: 'textarea' }], ok: 'Согласовать' });
      if (!r) return; body = { ...body, ...r };
    } else if (action === 'issue') {
      const r = await ask({ title: 'Выдать деньги', fields: [{ name: 'issued_amount', label: `Выдано, ${cur()}`, type: 'money', value: x.approved_amount ?? x.amount }, { name: 'comment', label: 'Как выдали (наличные, на карту…)', type: 'text' }], ok: 'Отметить выдачу' });
      if (!r) return; body = { ...body, ...r };
    } else if (action === 'close') {
      const warn = x.flags?.filter((f) => f.level === 'high').length;
      const r = await ask({ title: `Провести ${x.number}`, text: `Потрачено по чекам: <b>${money(x.actual_total)}</b>${warn ? `<br><span class="down">Есть серьёзные замечания проверки: ${warn}</span>` : ''}`, fields: [{ name: 'comment', label: 'Комментарий (необязательно)', type: 'textarea' }], ok: 'Провести' });
      if (!r) return; body = { ...body, ...r };
    } else {
      const titles = { return: 'Вернуть на доработку', reject: 'Отклонить заявку', comment: 'Комментарий к заявке' };
      const r = await ask({ title: titles[action], fields: [{ name: 'comment', label: action === 'reject' ? 'Причина отказа' : action === 'return' ? 'Что исправить' : 'Текст', type: 'textarea', required: true }], ok: action === 'reject' ? 'Отклонить' : 'Отправить', danger: action === 'reject' });
      if (!r) return; body = { ...body, ...r };
    }
    try { await post(`/api/requests/${x.id}/action`, body); toast('Готово'); render(); } catch (e) { fail(e); }
  }
  async function staffDo(x, action) {
    if (action === 'correction') return correctionDialog('request', x.id);
    if (action === 'cancel' && !(await confirmBox('Отменить заявку?', 'Отменённую заявку нельзя вернуть — при необходимости создайте новую.', 'Отменить заявку', true))) return;
    let comment = '';
    if (action === 'resubmit') { const r = await ask({ title: 'Отправить снова', fields: [{ name: 'comment', label: 'Что исправили (необязательно)', type: 'textarea' }], ok: 'Отправить' }); if (!r) return; comment = r.comment; }
    try { await post(`/api/requests/${x.id}/action`, { action, comment }); toast('Готово'); render(); } catch (e) { fail(e); }
  }
  async function correctionDialog(entity, id) {
    const r = await ask({ title: 'Запрос на корректировку', text: 'Руководитель увидит запрос и, если разрешит, запись снова откроется для правки.', fields: [{ name: 'reason', label: 'Что и почему нужно исправить', type: 'textarea', required: true, placeholder: 'Например: ошибся в цене профтрубы — в чеке 410, а не 470' }], ok: 'Отправить запрос' });
    if (!r) return;
    try { await post('/api/corrections', { entity, id, reason: r.reason }); toast('Запрос отправлен руководителю'); render(); } catch (e) { fail(e); }
  }

  // ================= Доходы =================
  async function pageIncomes(r) {
    const q = r.q;
    const data = await api(`/api/incomes?${new URLSearchParams(q)}`);
    const link = (s) => `#/incomes?${new URLSearchParams({ ...q, status: s })}`;
    const rows = data.items.map((i) => `<tr class="click" data-href="#/income/${i.id}"><td><b>${esc(i.title)}</b><div class="faint xs">${esc(i.number)}${i.client ? ` · ${esc(i.client)}` : ''}${i.object ? ` · ${esc(i.object)}` : ''}</div></td>
      <td class="hide-m">${esc(i.date)}</td>${isHead() ? `<td class="hide-m">${esc(i.user_name)}</td>` : ''}<td class="hide-m">${METHOD[i.method]}</td><td>${pill(i.status, i.status_text)}</td><td class="r num"><b class="${i.status === 'confirmed' ? 'up' : ''}">${money(i.amount)}</b></td></tr>`).join('');
    return `${head('Доходы', `Подтверждено: <b>${money(data.confirmed_sum)}</b> из ${data.items.length} записей`, `${isHead() ? `<a class="btn soft" href="/api/head/export?type=incomes" download>${ic('download')} CSV</a>` : ''}<a class="btn" href="#/new-income">${ic('plus')} Внести доход</a>`)}
      <div class="tabs" style="margin-bottom:14px">${[['', 'Все'], ['new', 'Ждут подтверждения'], ['confirmed', 'Подтверждено'], ['rejected', 'Отклонено']].map(([s, t]) => `<a href="${link(s)}" class="${(q.status || '') === s ? 'on' : ''}">${t}</a>`).join('')}</div>
      <form class="filters" id="if"><input class="input" name="q" placeholder="Поиск: что продали, клиент" value="${esc(q.q || '')}"><input class="input" type="date" name="from" value="${esc(q.from || '')}" style="flex:0 1 160px"><input class="input" type="date" name="to" value="${esc(q.to || '')}" style="flex:0 1 160px"></form>
      <div class="card flush">${rows ? `<div class="table-wrap"><table class="t resp"><thead><tr><th>Доход</th><th class="hide-m">Дата</th>${isHead() ? '<th class="hide-m">Внёс</th>' : ''}<th class="hide-m">Оплата</th><th>Статус</th><th class="r">Сумма</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty">${ic('coins', 32)}Доходов пока нет<p><a class="btn" href="#/new-income">Внести первый</a></p></div>`}</div>`;
  }
  pageIncomes.after = (r) => {
    const f = $('#if'); let t;
    f.oninput = () => { clearTimeout(t); t = setTimeout(() => { const p = new URLSearchParams(); for (const el of f.elements) if (el.value) p.set(el.name, el.value); if (r.q.status) p.set('status', r.q.status); go(`#/incomes?${p}`); }, 450); };
    f.onsubmit = (e) => e.preventDefault();
    $$('tr[data-href]').forEach((tr) => tr.onclick = () => go(tr.dataset.href));
  };
  function incomeForm(i = null) {
    const s = S.settings;
    return `<form id="incf" class="card stack" novalidate>
      <div class="form-grid">
        <label class="field" style="grid-column:1/-1"><span>Что продали / за что оплата</span><input class="input" name="title" value="${esc(i?.title || '')}" placeholder="Например: Навес 6×4 м, изготовление" required></label>
        <label class="field"><span>Сумма, ${cur()}</span><input class="input" name="amount" inputmode="decimal" value="${esc(i?.amount ?? '')}" required></label>
        <label class="field"><span>Дата</span><input class="input" type="date" name="date" value="${esc(i?.date || today())}" max="${today()}"></label>
        <label class="field"><span>Способ оплаты</span><select class="input" name="method">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}" ${(i?.method || 'account') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Клиент</span><input class="input" name="client" value="${esc(i?.client || '')}" placeholder="Кто заплатил"></label>
        <label class="field"><span>Объект / заказ</span><select class="input" name="object"><option value="">— не выбран —</option>${s.objects.map((o) => `<option ${i?.object === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label class="field"><span>Категория</span><select class="input" name="category"><option value="">— не выбрана —</option>${s.income_categories.map((o) => `<option ${i?.category === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Комментарий</span><textarea class="input" name="comment">${esc(i?.comment || '')}</textarea></label>
      <div class="row" style="justify-content:flex-end"><a class="btn soft" href="${i ? `#/income/${i.id}` : '#/incomes'}">Отмена</a><button class="btn lg">${i ? 'Сохранить' : 'Внести доход'}</button></div>
      ${i ? '' : '<p class="faint small" style="margin:0;text-align:right">Документ (накладную, акт, чек) можно прикрепить на следующем шаге.</p>'}
    </form>`;
  }
  function bindIncomeForm(existing) {
    const f = $('#incf');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries([...f.elements].filter((x) => x.name).map((x) => [x.name, x.value]));
      body.amount = String(body.amount).replace(/\s/g, '').replace(',', '.');
      try {
        if (existing) { await put(`/api/incomes/${existing.id}`, body); toast('Сохранено'); go(`#/income/${existing.id}`); }
        else { const r = await post('/api/incomes', body); toast('Доход внесён. Руководитель подтвердит его'); go(`#/income/${r.id}`); }
      } catch (err) { fail(err); }
    };
  }
  function pageNewIncome() { return `${head('Внести доход', 'Продажа, услуга или оплата от клиента', '', '<a href="#/incomes">Доходы</a> / новый')}${incomeForm()}`; }
  pageNewIncome.after = () => bindIncomeForm(null);
  let curIncome = null;
  async function pageIncome(r) {
    curIncome = await api(`/api/incomes/${r.parts[1]}`);
    const i = curIncome;
    if (r.parts[2] === 'edit') {
      if (!i.can_edit) throw new Error('Время на правку вышло — нужен запрос на корректировку');
      return `${head(`Изменить ${esc(i.number)}`, '', '', `<a href="#/incomes">Доходы</a> / <a href="#/income/${i.id}">${esc(i.number)}</a>`)}${incomeForm(i)}`;
    }
    const acts = [];
    if (isHead() && i.status === 'new' && !i.mine) acts.push(`<button class="btn block lg" data-ia="confirm">${ic('check')} Подтвердить</button><button class="btn danger block" data-ia="reject">Отклонить</button>`);
    if (isHead()) acts.push(`<button class="btn outline block sm" data-ia="comment">${ic('chat', 16)} Комментарий</button>`);
    if (i.mine && i.can_edit) acts.push(`<span class="timer" data-until="${i.edit_until}">${ic('clock', 13)}</span><a class="btn soft block" href="#/income/${i.id}/edit">${ic('edit', 16)} Изменить</a>`);
    if (i.mine && !i.can_edit && i.status !== 'rejected') acts.push(i.corrections.some((c) => c.status === 'pending') ? `<div class="note">${ic('clock')}<span>Запрос на корректировку отправлен.</span></div>` : `<button class="btn outline block" data-ia="correction">${ic('unlock', 16)} Запросить корректировку</button>`);
    return `${head(esc(i.title), `${esc(i.number)} · внёс ${esc(i.user_name)} · ${dt(i.created_at)}`, pill(i.status, i.status_text), `<a href="#/incomes">Доходы</a> / ${esc(i.number)}`)}
      <div class="detail"><div class="stack">
        ${i.head_comment ? `<div class="note ${i.status === 'rejected' ? 'warn' : ''}">${ic('chat')}<span><b>Руководитель:</b> ${esc(i.head_comment)}</span></div>` : ''}
        <div class="card"><div class="money-line"><span class="muted">Сумма</span><b class="up" style="font-size:1.6rem">+${money(i.amount)}</b></div>
          <dl class="kv" style="margin-top:10px"><dt>Дата</dt><dd>${esc(i.date)}</dd><dt>Оплата</dt><dd>${METHOD[i.method]}</dd>${i.client ? `<dt>Клиент</dt><dd>${esc(i.client)}</dd>` : ''}${i.object ? `<dt>Объект</dt><dd>${esc(i.object)}</dd>` : ''}${i.category ? `<dt>Категория</dt><dd>${esc(i.category)}</dd>` : ''}</dl>
          ${i.comment ? `<div class="quote" style="margin-top:12px">${esc(i.comment)}</div>` : ''}</div>
        <div class="card"><h3>Документы</h3>${i.files.length ? `<div class="files">${i.files.map((f) => fileCard(f, i.mine && i.can_edit)).join('')}</div>` : !(i.mine && i.can_edit) ? '<div class="empty small">Файлов нет</div>' : ''}
          ${i.mine && i.can_edit ? `<label class="drop" id="drop" style="margin-top:12px">${ic('upload', 26)}<b>Прикрепить накладную, акт или чек</b><input type="file" id="file-in" accept="image/*,application/pdf" multiple hidden></label>` : ''}<div id="ai-out"></div></div>
        <div class="card"><h3>История</h3>${timeline(i.events)}</div>
      </div><div class="aside">${acts.length ? `<div class="card stack">${acts.join('')}</div>` : ''}</div></div>`;
  }
  pageIncome.after = (r) => {
    if (r.parts[2] === 'edit') return bindIncomeForm(curIncome);
    const i = curIncome; startTimers();
    $$('[data-ia]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.ia;
      if (a === 'correction') return correctionDialog('income', i.id);
      let comment = '';
      if (a !== 'confirm') { const res = await ask({ title: a === 'reject' ? 'Отклонить доход' : 'Комментарий', fields: [{ name: 'comment', label: a === 'reject' ? 'Причина' : 'Текст', type: 'textarea', required: true }], ok: 'Отправить', danger: a === 'reject' }); if (!res) return; comment = res.comment; }
      try { await post(`/api/incomes/${i.id}/action`, { action: a, comment }); toast('Готово'); render(); } catch (e) { fail(e); }
    });
    bindFiles({ income_id: i.id }, null);
  };

  // ================= Аналитика =================
  let anData = null;
  function periodPresets() {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
    return [
      ['Этот месяц', ymd(new Date(y, m, 1)), ymd(d)], ['Прошлый месяц', ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))],
      ['Квартал', ymd(new Date(y, m - 2, 1)), ymd(d)], ['Этот год', ymd(new Date(y, 0, 1)), ymd(d)], ['12 месяцев', ymd(new Date(y, m - 11, 1)), ymd(d)],
    ];
  }
  async function pageAnalytics(r) {
    const q = r.q; anData = await api(`/api/head/overview?${new URLSearchParams(q)}`);
    const o = anData; const c = o.current; const p = o.previous;
    const presets = periodPresets();
    const margin = c.income ? (c.profit / c.income) * 100 : null;
    const objRows = o.by_object.map((x) => `<tr><td>${esc(x.k)}</td><td class="r num up">${money(x.income)}</td><td class="r num">${money(x.expenses)}</td><td class="r num"><b class="${x.profit >= 0 ? 'up' : 'down'}">${money(x.profit)}</b></td><td class="r num faint hide-m">${x.income ? `${nf((x.profit / x.income) * 100, 0)}%` : '—'}</td></tr>`).join('');
    const staffRows = o.by_staff.map((x) => `<tr><td>${esc(x.k)}</td><td class="r num">${x.n}</td><td class="r num">${money(x.planned)}</td><td class="r num"><b>${money(x.s)}</b></td><td class="r num ${x.s > x.planned ? 'down' : 'up'}">${x.planned ? `${x.s > x.planned ? '+' : ''}${nf(pct(x.s, x.planned), 1)}%` : '—'}</td></tr>`).join('');
    const chan = Object.fromEntries(o.by_channel.map((x) => [x.k, x]));
    return `${head('Аналитика', `${dOnly(Date.parse(o.range.from))} — ${dOnly(Date.parse(o.range.to))} · сравнение с ${dOnly(Date.parse(o.range.prevFrom))} — ${dOnly(Date.parse(o.range.prevTo))}`,
      `<a class="btn soft" href="/api/head/export?type=items" download>${ic('download')} Все покупки CSV</a>`)}
      <div class="filters">
        <div class="tabs">${presets.map(([t, f, to]) => `<a href="#/analytics?from=${f}&to=${to}" class="${o.range.from === f && o.range.to === to ? 'on' : ''}">${t}</a>`).join('')}</div>
        <form id="pf" class="row"><input class="input" type="date" name="from" value="${o.range.from}" style="width:160px"><span class="faint">—</span><input class="input" type="date" name="to" value="${o.range.to}" style="width:160px"><button class="btn soft">Показать</button></form>
      </div>
      <div class="grid-kpi">
        ${kpi('Доходы', money(c.income), delta(c.income, p.income), '', 'var(--c-in)')}
        ${kpi('Расходы', money(c.expenses), delta(c.expenses, p.expenses, true), '', 'var(--c-out)')}
        ${kpi('Прибыль', money(c.profit), margin != null ? `рентабельность ${nf(margin, 1)}% · ${delta(c.profit, p.profit)}` : '', 'ink')}
        ${kpi('Экономия к согласованному', money(o.saved), `${c.expense_count} проведённых заявок`)}
      </div>
      <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Доходы и расходы по месяцам</h3><span class="faint small">12 месяцев до конца периода</span></div>${monthlyChart(o.monthly, 1080, 300)}
        <details style="margin-top:12px"><summary class="link small" style="cursor:pointer">Показать таблицей</summary><div class="table-wrap"><table class="t" style="margin-top:8px"><thead><tr><th>Месяц</th><th class="r">Доходы</th><th class="r">Расходы</th><th class="r">Прибыль</th></tr></thead><tbody>${o.monthly.map((m) => `<tr><td>${monthName(m.month)}</td><td class="r num">${money(m.income)}</td><td class="r num">${money(m.expenses)}</td><td class="r num ${m.profit >= 0 ? 'up' : 'down'}">${money(m.profit)}</td></tr>`).join('')}</tbody></table></div></details></div>
      <div class="grid-2">
        <div class="card"><div class="card-h"><h3>Прибыль по объектам</h3></div>${objRows ? `<div class="table-wrap"><table class="t resp"><thead><tr><th>Объект</th><th class="r">Доход</th><th class="r">Расход</th><th class="r">Прибыль</th><th class="r hide-m">Марж.</th></tr></thead><tbody>${objRows}</tbody></table></div>` : '<div class="empty small">Нет данных</div>'}</div>
        <div class="card"><div class="card-h"><h3>Расходы по категориям</h3></div>${hbars(o.by_category)}</div>
        <div class="card"><div class="card-h"><h3>Расходы по сотрудникам</h3><span class="faint small">план — согласовано, факт — по чекам</span></div>${staffRows ? `<div class="table-wrap"><table class="t"><thead><tr><th>Сотрудник</th><th class="r">Заявок</th><th class="r">План</th><th class="r">Факт</th><th class="r">Откл.</th></tr></thead><tbody>${staffRows}</tbody></table></div>` : '<div class="empty small">Нет данных</div>'}</div>
        <div class="card"><div class="card-h"><h3>Доходы по категориям</h3></div>${hbars(o.income_by_category, { inColor: true })}</div>
        <div class="card"><div class="card-h"><h3>Самые затратные позиции</h3><a class="link small" href="#/control?tab=prices">Контроль цен</a></div>${o.top_items.length ? `<table class="t"><tbody>${o.top_items.map((x) => `<tr><td>${esc(x.name)}<div class="faint xs">${nf(x.qty)} ${esc(x.unit)} · ${x.n} покуп.</div></td><td class="r num"><b>${money(x.s)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty small">Нет данных</div>'}</div>
        <div class="card"><div class="card-h"><h3>Как покупают</h3></div>
          <div class="kv"><dt>Онлайн по ссылке</dt><dd>${money(chan.online?.s || 0)} · ${chan.online?.n || 0} шт.</dd><dt>В магазине (офлайн)</dt><dd>${money(chan.offline?.s || 0)} · ${chan.offline?.n || 0} шт.</dd>
          <dt>Среднее время согласования</dt><dd>${o.approval_hours != null ? `${nf(o.approval_hours, 1)} ч` : '—'}</dd><dt>Ждут подтверждения доходы</dt><dd>${money(o.pending_income.s)} · ${o.pending_income.n} шт.</dd></div>
          <h3 style="margin-top:18px">Под отчётом</h3>${o.advances.length ? `<table class="t"><tbody>${o.advances.map((a) => `<tr><td>${esc(a.name)}</td><td class="r num"><b class="${a.balance > 0 ? 'down' : ''}">${money(a.balance)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty small">Нет выданных денег</div>'}
        </div>
      </div>`;
  }
  pageAnalytics.after = () => {
    bindMonthly(anData.monthly);
    $('#pf').onsubmit = (e) => { e.preventDefault(); go(`#/analytics?from=${e.target.from.value}&to=${e.target.to.value}`); };
  };

  // ================= Контроль =================
  let ctrl = null;
  async function pageControl(r) {
    const tab = r.q.tab || 'flags';
    const tabs = `<div class="tabs" style="margin-bottom:16px"><a href="#/control" class="${tab === 'flags' ? 'on' : ''}">${ic('alert', 15)} Замечания</a><a href="#/control?tab=prices" class="${tab === 'prices' ? 'on' : ''}">${ic('tag', 15)} Контроль цен</a></div>`;
    const sub = 'Автоматическая проверка каждой заявки: цены выше обычных, перерасход, нет чека, повторный чек, расхождение с чеком по ИИ';
    if (tab === 'prices') {
      ctrl = await api(`/api/head/prices?q=${encodeURIComponent(r.q.q || '')}`);
      const rows = ctrl.items.map((x, k) => `<tr class="click" data-k="${k}"><td><b>${esc(x.name)}</b><div class="faint xs">${x.count} покуп. · ${money(x.total)}</div></td>
        <td class="r num">${money(x.min)}</td><td class="r num">${money(x.median)}</td><td class="r num">${money(x.max)}</td><td class="r num hide-m">${money(x.last)}</td>
        <td class="r num ${x.spread > 30 ? 'down' : ''}">${nf(x.spread, 0)}%</td><td class="r num hide-m ${x.trend > 0 ? 'down' : 'up'}">${x.trend > 0 ? '+' : ''}${nf(x.trend, 1)}%</td><td class="r">${x.above ? `<span class="badge red">${x.above}</span>` : ''}</td></tr>`).join('');
      return `${head('Контроль', sub)}${tabs}
        <form class="filters" id="cf"><input class="input" name="q" placeholder="Найти товар: «труба», «электроды»" value="${esc(r.q.q || '')}"></form>
        <div class="card flush">${rows ? `<div class="table-wrap"><table class="t"><thead><tr><th>Товар</th><th class="r">Мин</th><th class="r">Обычно</th><th class="r">Макс</th><th class="r hide-m">Последняя</th><th class="r">Разброс</th><th class="r hide-m">Тренд</th><th class="r">Выше нормы</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Проведённых покупок пока нет</div>'}</div>
        <p class="faint small">Цена — за единицу по чеку. «Обычно» — медиана всех покупок. «Выше нормы» — покупки дороже медианы больше чем на ${nf(S.settings.price_alert_pct)}%. Нажмите на товар, чтобы увидеть, кто, где и почём покупал.</p>`;
    }
    ctrl = await api('/api/head/control');
    const items = ctrl.items.map((x) => `<a class="li" href="#/r/${x.id}"><div class="t1">${esc(x.title)}</div><div class="amt">${money(x.actual_total ?? x.amount)}</div>
      <div class="t2" style="grid-column:1/-1"><span>${esc(x.number)}</span>${pill(x.status)}<span>· ${esc(x.user_name)}</span></div>
      <div style="grid-column:1/-1;display:grid;gap:6px;margin-top:6px">${x.flags.map((f) => `<div class="flag ${f.level}" style="padding:6px 10px">${ic(f.level === 'low' ? 'info' : 'alert', 14)}<span class="small">${esc(f.text)}</span></div>`).join('')}</div></a>`);
    const st = ctrl.staff.map((s) => `<tr><td>${esc(s.name)}</td><td class="r num">${s.requests}</td><td class="r num ${s.high ? 'down' : ''}">${s.high}</td><td class="r num ${s.price ? 'down' : ''}">${s.price}</td></tr>`).join('');
    return `${head('Контроль', sub)}${tabs}
      <div class="detail"><div>${listCard(`<h3>Заявки с замечаниями <span class="faint">${items.length}</span></h3>`, items, `${ic('checkCircle', 28)}Замечаний нет`)}</div>
      <div class="aside"><div class="card"><h3>По сотрудникам</h3>${st ? `<table class="t"><thead><tr><th>Сотрудник</th><th class="r">С замеч.</th><th class="r">Серьёзн.</th><th class="r">Цена ↑</th></tr></thead><tbody>${st}</tbody></table>` : '<div class="empty small">—</div>'}</div>
      <div class="note">${ic('info')}<span>Замечание — повод проверить, а не обвинение: цена могла вырасти, товар — отличаться. Сравните со ссылкой и чеком.</span></div></div></div>`;
  }
  pageControl.after = (r) => {
    const f = $('#cf');
    if (f) { let t; f.oninput = () => { clearTimeout(t); t = setTimeout(() => go(`#/control?tab=prices&q=${encodeURIComponent(f.q.value)}`), 450); }; f.onsubmit = (e) => e.preventDefault(); }
    $$('tr[data-k]').forEach((tr) => tr.onclick = () => {
      const x = ctrl.items[Number(tr.dataset.k)];
      modal(`<div class="row between"><h2>${esc(x.name)}</h2><button class="icon-btn" data-close>${ic('x')}</button></div>
        <div class="grid-kpi">${kpi('Обычная цена', money(x.median))}${kpi('Мин — макс', `${short(x.min)} — ${short(x.max)}`)}${kpi('Покупок', x.count, money(x.total))}</div>
        <h3>Кто почём покупает</h3><div class="hbars">${x.users.map((u) => `<div class="hbar"><div class="top-l"><span>${esc(u.name)} <span class="faint">· ${u.n} покуп.</span></span><span class="num"><b>${money(u.median)}</b> <span class="${u.delta > S.settings.price_alert_pct ? 'down' : 'faint'}">${u.delta > 0 ? '+' : ''}${nf(u.delta, 1)}%</span></span></div></div>`).join('')}</div>
        <h3>Последние покупки</h3><div class="table-wrap"><table class="t"><thead><tr><th>Дата</th><th>Заявка</th><th>Кто</th><th>Где</th><th class="r">Кол-во</th><th class="r">Цена</th></tr></thead><tbody>
        ${x.buys.map((b) => `<tr><td>${dOnly(b.date)}</td><td><a class="link" href="#/r/${b.rid}" data-close>${esc(b.number)}</a></td><td>${esc(b.user)}</td><td>${b.url ? `<a class="link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(b.shop || 'ссылка')}</a>` : esc(b.shop || '—')}</td><td class="r num">${nf(b.qty)}</td><td class="r num ${b.price > x.median * (1 + S.settings.price_alert_pct / 100) ? 'down' : ''}"><b>${money(b.price)}</b></td></tr>`).join('')}</tbody></table></div>`, { wide: true });
    });
    void r;
  };

  // ================= Журнал =================
  async function pageJournal(r) {
    const data = await api(`/api/head/events?${new URLSearchParams(r.q)}`);
    const rows = data.items.map((e) => { const [t, i, c] = EV[e.action] || [e.action, 'info', ''];
      return `<div class="ev"><span class="ic ${c}">${ic(i, 13)}</span><div><b>${t}</b>${e.number ? ` · <a class="link" href="#/${e.entity === 'request' ? 'r' : 'income'}/${e.entity_id}">${esc(e.number)}</a>` : ''} <span class="when">${dt(e.ts)} · ${esc(e.user_name || 'система')}</span>${evBody(e)}</div></div>`; }).join('');
    const last = data.items.at(-1);
    return `${head('Журнал', 'Все действия в системе: кто, что и когда изменил. Записи нельзя удалить или исправить.')}
      <div class="tabs" style="margin-bottom:14px">${[['', 'Всё'], ['request', 'Заявки'], ['income', 'Доходы'], ['auth', 'Входы'], ['user', 'Сотрудники'], ['settings', 'Настройки']].map(([k, t]) => `<a href="#/journal${k ? `?entity=${k}` : ''}" class="${(r.q.entity || '') === k ? 'on' : ''}">${t}</a>`).join('')}</div>
      <div class="card">${rows ? `<div class="timeline">${rows}</div>` : '<div class="empty">Пусто</div>'}
      ${data.items.length === 100 && last ? `<div style="margin-top:12px"><a class="btn soft" href="#/journal?${new URLSearchParams({ ...r.q, before: last.id })}">Показать раньше</a></div>` : ''}</div>`;
  }

  // ================= Команда =================
  let team = [];
  async function pageTeam() {
    team = (await api('/api/head/users')).items;
    const rows = team.map((u) => `<tr class="${u.active ? '' : 'faint'}"><td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar" style="background:var(--surface-2)">${esc(initials(u.name))}</span><span><b>${esc(u.name)}</b><div class="faint xs">${esc(u.login)} · ${esc(u.position || '—')}</div></span></div></td>
      <td>${u.role === 'head' ? '<span class="tag">Руководитель</span>' : '<span class="tag">Сотрудник</span>'} ${u.active ? '' : '<span class="tag" style="color:var(--danger)">отключён</span>'} ${u.must_change_pw ? '<span class="tag">временный пароль</span>' : ''}</td>
      <td class="r num hide-m">${u.requests}</td><td class="r num hide-m">${money(u.spent)}</td><td class="hide-m faint small">${u.last_login ? dt(u.last_login) : 'не входил'}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap"><a class="btn soft sm" href="#/requests?user=${u.id}&status=">Заявки</a><button class="btn soft sm" data-ue="${u.id}">${ic('edit', 15)}</button></div></td></tr>`).join('');
    return `${head('Команда', 'Учётные записи подразделения. Сотрудник видит только свои заявки и доходы, руководитель — всё.', `<button class="btn" id="add-user">${ic('plus')} Добавить сотрудника</button>`)}
      <div class="card flush"><div class="table-wrap"><table class="t resp"><thead><tr><th>Сотрудник</th><th>Роль</th><th class="r hide-m">Заявок</th><th class="r hide-m">Проведено</th><th class="hide-m">Последний вход</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="note" style="margin-top:16px">${ic('lock')}<span>Пароли знает только сам сотрудник. Вы выдаёте временный пароль — при первом входе система потребует сменить его. Отключённый сотрудник сразу теряет доступ, его история сохраняется.</span></div>`;
  }
  pageTeam.after = () => {
    $('#add-user').onclick = () => userDialog(null);
    $$('[data-ue]').forEach((b) => b.onclick = () => userDialog(team.find((u) => String(u.id) === b.dataset.ue)));
  };
  function showPassword(login, password) {
    return modal(`<h2>Данные для входа</h2><p class="muted" style="margin:0">Передайте сотруднику лично. Пароль показывается один раз — при первом входе его нужно сменить.</p>
      <div class="field"><span>Логин</span><div class="secret">${esc(login)}</div></div><div class="field"><span>Временный пароль</span><div class="secret">${esc(password)}</div></div>
      <div class="acts"><button class="btn soft" id="cp">${ic('doc', 16)} Скопировать</button><button class="btn" data-close>Готово</button></div>`, {
      onOpen: (box) => { $('#cp', box).onclick = () => { navigator.clipboard?.writeText(`Вход в БХ Учёт: ${location.origin}\nЛогин: ${login}\nПароль: ${password}`).then(() => toast('Скопировано')); }; },
    });
  }
  function userDialog(u) {
    modal(`<h2>${u ? 'Сотрудник' : 'Новый сотрудник'}</h2><form class="stack" id="uf" novalidate>
      <div class="form-grid">
        <label class="field"><span>Имя и фамилия</span><input class="input" name="name" value="${esc(u?.name || '')}" required></label>
        <label class="field"><span>Логин</span><input class="input" name="login" value="${esc(u?.login || '')}" ${u ? 'readonly' : ''} placeholder="ivanov" autocapitalize="none"></label>
        <label class="field"><span>Должность</span><input class="input" name="position" value="${esc(u?.position || '')}" placeholder="Инженер"></label>
        <label class="field"><span>Телефон</span><input class="input" name="phone" value="${esc(u?.phone || '')}"></label>
        <label class="field"><span>Роль</span><select class="input" name="role"><option value="staff" ${u?.role !== 'head' ? 'selected' : ''}>Сотрудник</option><option value="head" ${u?.role === 'head' ? 'selected' : ''}>Руководитель</option></select></label>
      </div>
      ${u ? `<label class="row"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Доступ включён</label>` : ''}
      <div class="acts">${u ? `<button type="button" class="btn outline" id="reset">${ic('lock', 16)} Сбросить пароль</button>` : ''}<span style="flex:1"></span><button type="button" class="btn soft" data-close>Отмена</button><button class="btn">${u ? 'Сохранить' : 'Создать'}</button></div></form>`, {
      onOpen: (box, close) => {
        const f = $('#uf', box);
        f.onsubmit = async (e) => {
          e.preventDefault();
          const body = { name: f.name.value, login: f.login.value.trim(), position: f.position.value, phone: f.phone.value, role: f.role.value };
          try {
            if (u) { body.active = f.active.checked; await put(`/api/head/users/${u.id}`, body); close(); toast('Сохранено'); render(); }
            else { const r = await post('/api/head/users', body); close(); await showPassword(r.login, r.password); render(); }
          } catch (err) { fail(err); }
        };
        if (u) $('#reset', box).onclick = async () => {
          close();
          if (!(await confirmBox('Сбросить пароль?', `${esc(u.name)} будет выведен из системы и получит новый временный пароль.`, 'Сбросить', true))) return;
          try { const r = await post(`/api/head/users/${u.id}/reset`); await showPassword(r.login, r.password); } catch (err) { fail(err); }
        };
      },
    });
  }

  // ================= Настройки =================
  function pageSettings() {
    const s = S.settings;
    const ta = (name, label, hint) => `<label class="field"><span>${label}</span><textarea class="input" name="${name}" rows="6">${esc((s[name] || []).join('\n'))}</textarea><small class="hint">${hint}</small></label>`;
    return `${head('Настройки', 'Правила проверок и справочники. Любое изменение записывается в журнал.')}
      <form id="sf" class="stack">
        <div class="card stack"><h3 style="margin:0">Правила</h3><div class="form-grid">
          <label class="field"><span>Окно самостоятельной правки, часов</span><input class="input" name="edit_hours" inputmode="decimal" value="${esc(s.edit_hours)}"><small class="hint">После — только через запрос на корректировку</small></label>
          <label class="field"><span>Цена выше обычной на, %</span><input class="input" name="price_alert_pct" inputmode="decimal" value="${esc(s.price_alert_pct)}"><small class="hint">Порог подсветки в «Контроле»</small></label>
          <label class="field"><span>Перерасход к согласованному, %</span><input class="input" name="overspend_alert_pct" inputmode="decimal" value="${esc(s.overspend_alert_pct)}"></label>
        </div></div>
        <div class="card"><div class="grid-2">
          ${ta('objects', 'Объекты и заказы', 'По одному в строке. Нужны, чтобы считать прибыль по каждому объекту')}
          ${ta('categories', 'Категории расходов', 'По одной в строке')}
          ${ta('income_categories', 'Категории доходов', 'По одной в строке')}
          ${ta('units', 'Единицы измерения', 'шт, м, кг…')}
        </div></div>
        <div class="row" style="justify-content:flex-end"><button class="btn lg">Сохранить</button></div>
      </form>
      <div class="card" style="margin-top:16px"><h3>Распознавание чеков (ИИ)</h3><p class="muted" style="margin:0">${S.meta.ai ? `${ic('checkCircle', 16)} Подключено. У каждого чека есть кнопка «Распознать ИИ»: позиции и итог сверяются с отчётом.` : 'Не подключено. Чтобы включить, задайте на сервере переменную ANTHROPIC_API_KEY (см. README).'}</p></div>`;
  }
  pageSettings.after = () => {
    $('#sf').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      const lines = (n) => f[n].value.split('\n').map((x) => x.trim()).filter(Boolean);
      try {
        const s = await put('/api/head/settings', { edit_hours: f.edit_hours.value.replace(',', '.'), price_alert_pct: f.price_alert_pct.value, overspend_alert_pct: f.overspend_alert_pct.value,
          objects: lines('objects'), categories: lines('categories'), income_categories: lines('income_categories'), units: lines('units') });
        S.settings = { ...S.settings, ...s }; toast('Настройки сохранены');
      } catch (err) { fail(err); }
    };
  };

  // ================= Профиль, «Ещё» =================
  function pageProfile() {
    const theme = document.documentElement.dataset.theme;
    return `${head('Профиль', `${esc(S.me.name)} · ${esc(S.me.login)} · ${isHead() ? 'Руководитель' : 'Сотрудник'}`)}
      <div class="grid-2">
        <form class="card stack" id="pw"><h3 style="margin:0">Смена пароля</h3>
          <label class="field"><span>Текущий пароль</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
          <label class="field"><span>Новый пароль</span><input class="input" type="password" name="next" autocomplete="new-password"><small class="hint">Минимум 8 символов, буквы и цифры. Остальные сеансы будут закрыты.</small></label>
          <button class="btn">Сменить пароль</button></form>
        <div class="card stack"><h3 style="margin:0">Оформление</h3>
          <div class="theme-switch" style="max-width:320px">${themeButtons(theme)}</div>
          <p class="muted small" style="margin:0">На iPhone: «Поделиться» → «На экран Домой» — БХ Учёт откроется как приложение.</p>
          <button class="btn danger" id="logout">${ic('logout')} Выйти</button></div>
      </div>`;
  }
  pageProfile.after = () => {
    $('#logout').onclick = logout;
    $('#pw').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await post('/api/me/password', { current: f.current.value, next: f.next.value }); toast('Пароль изменён'); f.reset(); } catch (err) { fail(err); }
    };
    
  };
  function pageMore() {
    const links = [['/incomes', 'coins', 'Доходы'], ['/journal', 'history', 'Журнал'], ['/team', 'users', 'Команда'], ['/settings', 'sliders', 'Настройки'], ['/new', 'plus', 'Новая заявка'], ['/profile', 'user', 'Профиль']];
    return `${head('Ещё')}<div class="card flush"><div class="list">${links.map(([p, i, t]) => `<a class="li" href="#${p}"><div class="t1 row">${ic(i)} ${t}</div><div>${ic('chevronRight')}</div></a>`).join('')}</div></div>`;
  }

  render();
})();
