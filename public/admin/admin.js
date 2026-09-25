/* GOLD SKULL — painel admin */
(() => {
  const $ = (s) => document.querySelector(s);
  const money = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null,
    csrf: '',
    products: [],
    categories: [],
    settings: {},
    users: [],
    customers: [],
    ledger: [],
    editingId: null,
    flavorProductId: null,
    search: '',
    catFilter: '',
    cityFilter: '',
    statusFilter: '',
    sort: 'name',
    stockSearch: '',
    stockCat: '',
    stockCity: '',
    stockView: 'hub', // hub | detail
    profitPeriod: 'today',
    profitCity: '',
    profitCat: '',
    cities: [],
    logs: [],
    logMeta: null,
    logLimit: 100,
    logLoading: false,
    notifOrders: [],
    notifLastSeen: 0,
    notifTimer: null,
    orders: [],
    ordersStats: { pending: 0, approvedCount: 0, approvedTotal: 0, cancelledCount: 0, shippedCount: 0, completedCount: 0, returnedCount: 0 },
    ordersPeriod: 'today',
    ordersStatus: 'pending',
    ordersSearch: '',
    ordersView: 'list',
    ordersPage: 1,
    productsPage: 1,
    profitPage: 1,
    usersPage: 1,
    pageSize: 20,
    orderModalId: null,
  };

  function sellPrice(p) {
    if (p.promoPrice != null && p.promoPrice < p.price) return Number(p.promoPrice) || 0;
    return Number(p.price) || 0;
  }
  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function pageSlice(items, page, size) {
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / size) || 1);
    const p = Math.min(Math.max(1, page || 1), pages);
    const start = (p - 1) * size;
    return { items: items.slice(start, start + size), page: p, pages, total, size };
  }

  function renderPager(el, pageInfo, onPage) {
    if (!el) return;
    const { page, pages, total, size } = pageInfo;
    if (total <= size) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const from = (page - 1) * size + 1;
    const to = Math.min(total, page * size);
    el.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm" data-pager="prev" ${page <= 1 ? 'disabled' : ''}>Anterior</button>
      <span class="list-pager-info">${from}–${to} de ${total}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-pager="next" ${page >= pages ? 'disabled' : ''}>Próxima</button>
    `;
    el.querySelector('[data-pager="prev"]')?.addEventListener('click', () => onPage(page - 1));
    el.querySelector('[data-pager="next"]')?.addEventListener('click', () => onPage(page + 1));
  }

  const CASHBOXES = [
    { id: 'Itajaí', title: 'Itajaí e região', check: 'Itajaí e região' },
    { id: 'Joinville', title: 'Joinville e região', check: 'Joinville e região' },
    { id: 'Atacado', title: 'Atacado', check: 'Atacado (Brasil)' },
  ];
  function cashboxOf(name) {
    const t = fold(name);
    if (t.includes('joinville')) return 'Joinville';
    if (t.includes('itajai')) return 'Itajaí';
    if (/(brasil|atacado|outras|remoto|transportadora)/.test(t)) return 'Atacado';
    return CASHBOXES.some((c) => c.id === name) ? name : '';
  }
  function cityLabel(name) {
    const id = cashboxOf(name) || name;
    const box = CASHBOXES.find((c) => c.id === id);
    return box ? box.title : name || id;
  }
  function cityCheckLabel(name) {
    const id = cashboxOf(name) || name;
    const box = CASHBOXES.find((c) => c.id === id);
    return box ? box.check : name || id;
  }
  const PRODUCT_TYPES = ['Pods', 'Refis', 'Baterias', 'Gomas', 'Outros'];
  function isTypeCategory(name) {
    const t = String(name || '').trim();
    if (!t) return false;
    return !cashboxOf(t);
  }
  function inferTypeFromName(name) {
    const t = fold(name);
    if (t.includes('goma')) return 'Gomas';
    if (t.includes('bateria')) return 'Baterias';
    if (t.includes('refil')) return 'Refis';
    if (t.includes('pod')) return 'Pods';
    return '';
  }
  function sortTypeNames(list) {
    return [...list].sort((a, b) => {
      const ia = PRODUCT_TYPES.indexOf(a);
      const ib = PRODUCT_TYPES.indexOf(b);
      if (a === 'Sem categoria') return 1;
      if (b === 'Sem categoria') return -1;
      if (ia < 0 && ib < 0) return a.localeCompare(b, 'pt-BR');
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }
  function unitProfit(p) {
    if (p.cost == null || p.cost === '') return null;
    return sellPrice(p) - Number(p.cost);
  }

  /* Sem handlers inline no HTML: a CSP do servidor bloqueia scripts embutidos. */
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'IMG' || el.dataset.fallbackDone) return;
      el.dataset.fallbackDone = '1';
      el.style.visibility = 'hidden';
    },
    true
  );

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  /* ---------- confirmação (substitui confirm/prompt) ---------- */
  let confirmResolve = null;
  function askConfirm({ title = 'Confirmar', text = '', danger = true, password = false, passLabel = 'Confirme sua senha', okLabel = 'Confirmar' }) {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-pass-label').textContent = passLabel;
    $('#confirm-pass-wrap').classList.toggle('hidden', !password);
    $('#confirm-pass').value = '';
    $('#confirm-yes').textContent = okLabel;
    $('#confirm-yes').className = danger ? 'btn btn-danger' : 'btn btn-gold';
    $('#confirm-modal').classList.remove('hidden');
    setTimeout(() => (password ? $('#confirm-pass') : $('#confirm-yes')).focus(), 60);
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }
  function closeConfirm(result) {
    $('#confirm-modal').classList.add('hidden');
    const fn = confirmResolve;
    confirmResolve = null;
    if (fn) fn(result);
  }
  $('#confirm-form').addEventListener('submit', (e) => {
    e.preventDefault();
    closeConfirm({ ok: true, password: $('#confirm-pass').value });
  });
  $('#confirm-no').addEventListener('click', () => closeConfirm({ ok: false }));

  /* ---------- API com CSRF ---------- */
  async function fetchCsrf() {
    try {
      const res = await fetch('/api/csrf', { credentials: 'same-origin' });
      const data = await res.json();
      state.csrf = data.csrf || '';
    } catch {
      /* sem rede: o próximo pedido mostra o erro */
    }
    return state.csrf;
  }

  async function api(url, opts = {}, retry = true) {
    const options = { credentials: 'same-origin', ...opts };
    const headers = { ...(options.headers || {}) };
    if (options.json) {
      options.method = options.method || 'POST';
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
      delete options.json;
    }
    const method = (options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      if (!state.csrf) await fetchCsrf();
      headers['X-CSRF-Token'] = state.csrf;
    }
    options.headers = headers;

    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));

    if (res.status === 403 && data.csrf && retry) {
      await fetchCsrf();
      return api(url, opts, false);
    }
    if (res.status === 401 && !url.includes('/api/login') && !url.includes('/password')) {
      state.user = null;
      state.csrf = data.csrf || state.csrf;
      if (data.stage === 'totp') showTotpStep('');
      else showLogin();
      throw new Error(data.error || 'Sessão encerrada. Entre de novo.');
    }
    if (res.status === 423) {
      showPasswordGate();
      throw new Error(data.error || 'Troque sua senha para continuar.');
    }
    if (res.status === 428) {
      showTwoFactorSetup();
      throw new Error(data.error || 'Configure a verificação em duas etapas.');
    }
    if (!res.ok) throw new Error(data.error || 'Algo deu errado.');
    return data;
  }

  /* ---------- views ---------- */
  function hideAllViews() {
    $('#panel').classList.add('hidden');
    $('#login-view').classList.add('hidden');
    $('#pwgate-view').classList.add('hidden');
    $('#totp-view').classList.add('hidden');
    $('#twofa-view').classList.add('hidden');
  }
  function showLogin() {
    hideAllViews();
    $('#login-view').classList.remove('hidden');
    fetchCsrf();
  }
  function showPasswordGate() {
    hideAllViews();
    $('#pwgate-view').classList.remove('hidden');
    $('#pwgate-error').classList.add('hidden');
  }
  function showTotpStep(name) {
    hideAllViews();
    $('#totp-view').classList.remove('hidden');
    $('#totp-error').classList.add('hidden');
    $('#totp-code').value = '';
    $('#totp-hello').textContent = name
      ? `Oi, ${name}. Digite o código de 6 números do seu aplicativo autenticador.`
      : 'Abra o aplicativo autenticador e digite o código de 6 números.';
    setTimeout(() => $('#totp-code').focus(), 80);
  }
  function showPanel() {
    if (state.user && state.user.mustChangePassword) return showPasswordGate();
    hideAllViews();
    $('#panel').classList.remove('hidden');
    const isAdmin = state.user.role === 'admin';
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
    document.querySelectorAll('.editor-only').forEach((el) => el.classList.toggle('hidden', isAdmin));
    const who = $('#whoami');
    if (who) who.textContent = `${state.user.name || state.user.username} · ${isAdmin ? 'admin' : 'editor'}`;
    loadAll();
    startNotifPolling();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').classList.add('hidden');
    $('#login-submit').disabled = true;
    try {
      const data = await api('/api/login', {
        json: { username: $('#login-username').value, password: $('#login-password').value },
      });
      state.csrf = data.csrf || state.csrf;
      $('#login-password').value = '';
      if (data.stage === 'totp') {
        showTotpStep(data.name);
        return;
      }
      state.user = data.user;
      if (data.mustChangePassword) showPasswordGate();
      else showPanel();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#login-error').classList.remove('hidden');
    } finally {
      $('#login-submit').disabled = false;
    }
  });

  $('#pwgate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwgate-error');
    err.classList.add('hidden');
    const next = $('#pw-next').value;
    if (next !== $('#pw-next2').value) {
      err.textContent = 'As duas senhas novas não são iguais.';
      err.classList.remove('hidden');
      return;
    }
    try {
      const data = await api('/api/users/me/password', {
        method: 'PUT',
        json: { currentPassword: $('#pw-current').value, password: next },
      });
      state.user = data.user || { ...state.user, mustChangePassword: false };
      ['#pw-current', '#pw-next', '#pw-next2'].forEach((s) => ($(s).value = ''));
      toast('Senha trocada. Bem-vindo!');
      showPanel();
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('hidden');
    }
  });
  $('#pwgate-logout').addEventListener('click', () => $('#logout-btn').click());

  /* ---------- 2FA: etapa 2 do login ---------- */
  $('#totp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#totp-error');
    err.classList.add('hidden');
    $('#totp-submit').disabled = true;
    try {
      const data = await api('/api/login/totp', { json: { code: $('#totp-code').value } });
      state.user = data.user;
      state.csrf = data.csrf || state.csrf;
      if (data.recoveryLeft != null && data.recoveryLeft <= 3) {
        toast(`Atenção: restam ${data.recoveryLeft} código(s) de recuperação. Gere novos em Minha conta.`);
      }
      if (data.mustChangePassword) showPasswordGate();
      else showPanel();
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('hidden');
      if (/entre de novo|login de novo/i.test(e2.message)) setTimeout(showLogin, 1400);
    } finally {
      $('#totp-submit').disabled = false;
    }
  });
  $('#totp-recovery').addEventListener('click', () => {
    const input = $('#totp-code');
    input.placeholder = 'ABCDE-12345';
    input.value = '';
    input.focus();
    $('#totp-hello').textContent = 'Digite um dos códigos de recuperação que você guardou. Cada código funciona uma única vez.';
  });
  $('#totp-cancel').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.csrf = '';
    showLogin();
  });

  /* ---------- 2FA: configuração obrigatória ---------- */
  async function showTwoFactorSetup() {
    hideAllViews();
    $('#twofa-view').classList.remove('hidden');
    $('#twofa-error').classList.add('hidden');
    $('#twofa-code').value = '';
    try {
      const data = await api('/api/2fa/setup', { method: 'POST' });
      $('#twofa-qr').src = data.qr;
      $('#twofa-secret').textContent = data.secret;
    } catch (err) {
      $('#twofa-error').textContent = err.message;
      $('#twofa-error').classList.remove('hidden');
    }
  }
  $('#twofa-manual-toggle').addEventListener('click', () => {
    $('#twofa-secret-wrap').classList.toggle('hidden');
  });
  $('#twofa-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#twofa-secret').textContent);
      toast('Código copiado');
    } catch {
      toast('Copie manualmente: ' + $('#twofa-secret').textContent);
    }
  });
  $('#twofa-logout').addEventListener('click', doLogout);
  $('#twofa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#twofa-error');
    err.classList.add('hidden');
    $('#twofa-submit').disabled = true;
    try {
      const data = await api('/api/2fa/activate', { json: { code: $('#twofa-code').value } });
      state.user = data.user || { ...state.user, needs2faSetup: false };
      showRecoveryCodes(data.recoveryCodes, () => showPanel());
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('hidden');
    } finally {
      $('#twofa-submit').disabled = false;
    }
  });

  /* ---------- códigos de recuperação ---------- */
  let codesDone = null;
  function showRecoveryCodes(codes, onDone) {
    codesDone = onDone || null;
    state.lastCodes = codes || [];
    $('#codes-grid').innerHTML = (codes || []).map((c) => `<span class="code-chip">${esc(c)}</span>`).join('');
    $('#codes-ack').checked = false;
    $('#codes-done').disabled = true;
    $('#codes-modal').classList.remove('hidden');
  }
  function codesText() {
    const who = state.user ? `${state.user.name || state.user.username} (@${state.user.username})` : '';
    return [
      'GOLD SKULL — códigos de recuperação do painel',
      who,
      `Gerados em ${new Date().toLocaleString('pt-BR')}`,
      '',
      'Cada código entra no lugar do aplicativo autenticador UMA única vez.',
      'Guarde impresso ou num cofre de senhas. Não mande por WhatsApp.',
      '',
      ...(state.lastCodes || []).map((c, i) => `${String(i + 1).padStart(2, '0')}. ${c}`),
    ].join('\n');
  }
  $('#codes-ack').addEventListener('change', (e) => {
    $('#codes-done').disabled = !e.target.checked;
  });
  $('#codes-download').addEventListener('click', () => {
    const blob = new Blob([codesText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gold-skull-codigos-de-recuperacao.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#codes-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText((state.lastCodes || []).join('\n'));
      toast('Códigos copiados');
    } catch {
      toast('Não deu para copiar. Use "Baixar arquivo".');
    }
  });
  $('#codes-print').addEventListener('click', () => {
    const win = window.open('', '_blank');
    if (!win) return toast('O navegador bloqueou a janela de impressão.');
    win.document.write(`<pre style="font:14px/1.7 monospace">${esc(codesText())}</pre>`);
    win.document.close();
    win.print();
  });
  $('#codes-done').addEventListener('click', () => {
    $('#codes-modal').classList.add('hidden');
    state.lastCodes = [];
    const fn = codesDone;
    codesDone = null;
    if (fn) fn();
    else loadTwoFactorStatus();
  });

  async function loadTwoFactorStatus() {
    const el = $('#twofa-status');
    const off = $('#twofa-off-actions');
    const on = $('#twofa-on-actions');
    const setup = $('#twofa-setup-box');
    if (!el || !state.user) return;
    try {
      const data = await api('/api/2fa/status');
      const left = data.recoveryLeft;
      el.textContent = data.enabled
        ? `Ativa neste acesso. Você tem ${left} código(s) de recuperação sem uso.`
        : 'Desligada — você pode ligar abaixo.';
      el.classList.toggle('twofa-status-warn', data.enabled && left <= 3);
      off?.classList.toggle('hidden', !!data.enabled);
      on?.classList.toggle('hidden', !data.enabled);
      setup?.classList.add('hidden');
    } catch {
      el.textContent = 'Não foi possível checar agora.';
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function ensureAdminServiceWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('Este navegador não suporta service worker.');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    // iOS PWA: na 1ª abertura o SW ativa mas ainda não controla a página — sem isso o subscribe falha em silêncio
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const done = () => resolve();
        const t = setTimeout(done, 2500);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(t);
            done();
          },
          { once: true }
        );
      });
    }
    return reg;
  }

  function isIosDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandaloneApp() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      !!navigator.standalone
    );
  }

  function pushApiAvailable() {
    return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function refreshAdminInstallUi() {
    const card = $('#admin-install-card');
    const hint = $('#admin-install-hint');
    const btn = $('#admin-install-btn');
    if (!card) return;
    if (isStandaloneApp()) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    if (isIosDevice()) {
      if (hint) {
        hint.textContent =
          'No iPhone use o Safari: toque em Instalar app e siga Compartilhar → Adicionar à Tela de Início. Depois abra pelo ícone GS Painel.';
      }
      if (btn) btn.textContent = 'Como instalar';
    } else if (hint) {
      hint.textContent =
        'Instale como aplicativo para abrir sem digitar o link e receber avisos mesmo com o painel fechado.';
    }
  }

  function initAdminInstall() {
    refreshAdminInstallUi();
    const btn = $('#admin-install-btn');
    if (!btn) return;
    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      refreshAdminInstallUi();
      if (btn) btn.textContent = 'Instalar app';
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      refreshAdminInstallUi();
      toast('Painel instalado. Abra pelo ícone e ative o push.');
    });

    btn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice.catch(() => null);
        deferredPrompt = null;
        if (choice && choice.outcome === 'accepted') {
          toast('Instalado! Abra pelo ícone e toque em Ativar neste aparelho.');
          refreshAdminInstallUi();
        }
        return;
      }
      if (isIosDevice()) {
        const iosHint = $('#push-ios-hint');
        if (iosHint) {
          iosHint.classList.remove('hidden');
          iosHint.innerHTML =
            'No iPhone o push <b>só funciona pelo app da Tela de Início</b>:<br>' +
            '1. Abra este painel no <b>Safari</b> (não no Chrome)<br>' +
            '2. Toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b><br>' +
            '3. Se já tinha um ícone antigo, apague e adicione de novo<br>' +
            '4. Abra pelo ícone <b>GS Painel</b> → Ativar neste aparelho → Enviar teste';
        }
        toast('No Safari: Compartilhar → Adicionar à Tela de Início');
        return;
      }
      toast('No menu do navegador, escolha «Instalar aplicativo» ou «Adicionar à tela inicial».');
    });
  }

  async function updatePushStatusUi(data) {
    const el = $('#push-status');
    const hint = $('#push-ios-hint');
    const flag = $('#profile-notify-push');
    const enableBtn = $('#push-enable-btn');
    if (flag && data) flag.checked = !!data.notifyPushOrders;
    refreshAdminInstallUi();
    if (!el) return;

    const ios = isIosDevice();
    const standalone = isStandaloneApp();
    const supported = pushApiAvailable();

    if (hint) {
      if (ios && !standalone) {
        hint.classList.remove('hidden');
        hint.innerHTML =
          'No iPhone o push <b>não funciona na aba</b> do Safari/Chrome. Use o botão <b>Instalar app</b> acima (Safari → Tela de Início), abra pelo ícone e ative aqui.';
      } else if (ios && standalone && !supported) {
        hint.classList.remove('hidden');
        hint.textContent =
          'App instalado, mas este iOS ainda não libera Push. Atualize para iOS 16.4 ou mais novo.';
      } else if (!ios || standalone) {
        hint.classList.add('hidden');
        hint.textContent = '';
      }
    }

    if (!supported) {
      if (ios && !standalone) {
        el.textContent = 'No iPhone: instale o painel na Tela de Início para liberar o push.';
      } else if (ios) {
        el.textContent = 'Push indisponível neste iOS. Use iOS 16.4+ com o app da Tela de Início.';
      } else {
        el.textContent = 'Este navegador não ' + 'suporta' + ' notificações push.';
      }
      enableBtn?.setAttribute('disabled', 'disabled');
      return;
    }
    enableBtn?.removeAttribute('disabled');

    let localSub = null;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      localSub = reg ? await reg.pushManager.getSubscription() : null;
    } catch {
      /* ignore */
    }
    const perm = Notification.permission;
    const want = !!(data && data.notifyPushOrders);
    const serverOn = !!(data && data.pushEnabled);
    if (!want) {
      el.textContent = 'Preferência desligada — você não recebe avisos de pedido.';
    } else if (perm === 'denied') {
      el.textContent = 'Permissão bloqueada no navegador. Libere notificações nas configurações do site.';
    } else if (localSub && serverOn) {
      el.textContent = 'Pronto neste aparelho' + (data.pushCount > 1 ? ' · ' + data.pushCount + ' aparelho(s) salvos' : '') + '.';
    } else if (serverOn) {
      el.textContent = 'Há ' + data.pushCount + ' aparelho(s) salvos. Neste aparelho ainda falta ativar.';
    } else {
      el.textContent = 'Flag ligada. Falta ativar neste aparelho e aceitar a permissão.';
    }
  }

  async function loadNotifyPrefs() {
    try {
      const data = await api('/api/push/status');
      await updatePushStatusUi(data);
    } catch {
      const el = $('#push-status');
      if (el) el.textContent = 'Não foi possível checar as notificações agora.';
    }
  }

  function fillProfileForm() {
    if (!state.user) return;
    const name = $('#profile-name');
    const user = $('#profile-username');
    if (name) name.value = state.user.name || '';
    if (user) user.value = state.user.username || '';
    const pushFlag = $('#profile-notify-push');
    if (pushFlag && state.user.notifyPushOrders != null) pushFlag.checked = !!state.user.notifyPushOrders;
  }

  $('#profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/users/me/profile', {
        method: 'PUT',
        json: {
          name: $('#profile-name').value.trim(),
          username: $('#profile-username').value.trim(),
        },
      });
      if (data.session) state.user = { ...state.user, ...data.session };
      else if (data.user) state.user = { ...state.user, name: data.user.name, username: data.user.username };
      showPanel();
      toast('Perfil atualizado');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#profile-notify-push')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    try {
      const data = await api('/api/push/prefs', { method: 'PUT', json: { notifyPushOrders: on } });
      if (data.session) state.user = { ...state.user, ...data.session };
      else if (data.user) state.user = { ...state.user, notifyPushOrders: data.user.notifyPushOrders };
      toast(on ? 'Avisos de pedido ligados' : 'Avisos de pedido desligados');
      loadNotifyPrefs();
    } catch (err) {
      e.target.checked = !on;
      toast(err.message);
    }
  });

  $('#push-enable-btn')?.addEventListener('click', async () => {
    try {
      if (!pushApiAvailable()) {
        if (isIosDevice() && !isStandaloneApp()) {
          return toast('No iPhone: adicione o painel à Tela de Início e abra pelo ícone.');
        }
        return toast('Este navegador não ' + 'suporta' + ' push.');
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Permissão negada — não dá para ativar.');
      const reg = await ensureAdminServiceWorker();
      const { publicKey } = await api('/api/push/vapid-public-key');
      let sub = await reg.pushManager.getSubscription();
      // No iPhone, reinscreve para garantir endpoint Apple fresco após instalar o app
      if (sub && isIosDevice()) {
        try {
          await sub.unsubscribe();
        } catch {
          /* ignore */
        }
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      const data = await api('/api/push/subscribe', {
        method: 'POST',
        json: { subscription: sub.toJSON(), notifyPushOrders: true },
      });
      if (data.user) {
        state.user = {
          ...state.user,
          pushEnabled: data.user.pushEnabled,
          notifyPushOrders: data.user.notifyPushOrders,
        };
      }
      if ($('#profile-notify-push')) $('#profile-notify-push').checked = true;
      toast('Push ativado neste aparelho');
      loadNotifyPrefs();
    } catch (err) {
      toast(err.message || 'Falha ao ativar push');
    }
  });

  $('#push-disable-btn')?.addEventListener('click', async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const endpoint = sub ? sub.endpoint : '';
      if (sub) await sub.unsubscribe().catch(() => {});
      await api('/api/push/unsubscribe', { method: 'POST', json: { endpoint } });
      toast('Push removido deste aparelho');
      loadNotifyPrefs();
    } catch (err) {
      toast(err.message || 'Falha ao desativar');
    }
  });

  $('#push-test-btn')?.addEventListener('click', async () => {
    try {
      if (!pushApiAvailable()) {
        if (isIosDevice() && !isStandaloneApp()) {
          return toast('Abra o painel pelo ícone da Tela de Início para testar o push.');
        }
        return toast('Push indisponível neste navegador.');
      }
      const reg = await ensureAdminServiceWorker();
      const sub = await reg.pushManager.getSubscription();
      await api('/api/push/test', {
        method: 'POST',
        json: { endpoint: sub ? sub.endpoint : '' },
      });
      toast('Teste enviado — confira a notificação neste aparelho');
    } catch (err) {
      toast(err.message || 'Falha no teste de push');
    }
  });

  $('#push-local-test-btn')?.addEventListener('click', async () => {
    try {
      if (!('Notification' in window)) return toast('Sem API de notificação neste aparelho.');
      if (!isStandaloneApp() && isIosDevice()) {
        return toast('No iPhone: abra pelo ícone da Tela de Início para o teste local.');
      }
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') return toast('Permissão negada.');
      const reg = await ensureAdminServiceWorker();
      await reg.showNotification('Teste local Gold Skull', {
        body: 'Se viu isto, a permissão do iPhone está ok. Se o teste remoto falhar, use as alternativas (ntfy/WhatsApp).',
        icon: '/img/icon-192.png',
        tag: 'local-test',
      });
      toast('Notificação local disparada');
    } catch (err) {
      toast(err.message || 'Falha no teste local');
    }
  });

  let notifyChannelsState = null;
  let notifyGuidePending = null; // { channel: 'ntfy'|'whatsapp', activate: boolean }

  function closeNotifyGuide(activate) {
    const modal = $('#notify-guide-modal');
    if (modal) modal.classList.add('hidden');
    const pending = notifyGuidePending;
    notifyGuidePending = null;
    if (!pending) return;
    if (activate && pending.activate) {
      return confirmNotifyGuide(pending.channel);
    }
    // cancelou ativação: desliga o switch visual
    if (pending.activate) {
      if (pending.channel === 'ntfy' && $('#ntfy-enabled')) $('#ntfy-enabled').checked = false;
      if (pending.channel === 'whatsapp' && $('#wa-notify-enabled')) $('#wa-notify-enabled').checked = false;
    }
  }

  async function confirmNotifyGuide(channel) {
    try {
      if (channel === 'ntfy') {
        await saveNotifyChannels({ ntfyEnabled: true });
        toast('ntfy ligado — use Testar ntfy para conferir');
      } else if (channel === 'whatsapp') {
        const phone = ($('#wa-notify-phone')?.value || '').replace(/\D/g, '');
        const key = ($('#wa-notify-key')?.value || '').trim();
        const patch = { whatsappEnabled: true, whatsappPhone: phone };
        if (key) patch.whatsappApiKey = key;
        await saveNotifyChannels(patch);
        if ($('#wa-notify-key')) $('#wa-notify-key').value = '';
        toast('WhatsApp de avisos ligado — use Testar WhatsApp');
      }
    } catch (err) {
      if (channel === 'ntfy' && $('#ntfy-enabled')) $('#ntfy-enabled').checked = false;
      if (channel === 'whatsapp' && $('#wa-notify-enabled')) $('#wa-notify-enabled').checked = false;
      toast(err.message || 'Não foi possível ativar');
    }
  }

  function openNotifyGuide(channel, { activate = false } = {}) {
    const modal = $('#notify-guide-modal');
    const title = $('#notify-guide-title');
    const body = $('#notify-guide-body');
    const confirmBtn = $('#notify-guide-confirm');
    const cancelBtn = $('#notify-guide-cancel');
    if (!modal || !body) return;

    notifyGuidePending = { channel, activate: !!activate };
    if (confirmBtn) {
      confirmBtn.textContent = activate ? 'Já configurei — ativar' : 'Entendi';
      confirmBtn.classList.toggle('hidden', false);
    }
    if (cancelBtn) {
      cancelBtn.textContent = activate ? 'Agora não' : 'Fechar';
      cancelBtn.classList.toggle('hidden', !activate);
    }

    if (channel === 'ntfy') {
      if (title) title.textContent = 'Configurar avisos com ntfy (iPhone)';
      const topic = (notifyChannelsState && notifyChannelsState.ntfyTopic) || '—';
      const url = (notifyChannelsState && notifyChannelsState.ntfySubscribeUrl) || '';
      body.innerHTML = `
        <p class="notify-guide-intro">O ntfy é um app grátis que recebe o aviso de pedido e mostra na tela de bloqueio do iPhone — como um app nativo.</p>
        <ol class="notify-guide-steps">
          <li>
            <span class="step-num">1</span>
            <div>
              <strong>Instale o app ntfy</strong>
              <p>No iPhone, abra a <b>App Store</b>, procure por <b>ntfy</b> (autor: Philipp C. Heckel) e instale.</p>
            </div>
          </li>
          <li>
            <span class="step-num">2</span>
            <div>
              <strong>Abra o app e permita notificações</strong>
              <p>Na primeira abertura, o iPhone pergunta se pode enviar avisos. Toque em <b>Permitir</b>. Se já recusou: Ajustes → Notificações → ntfy → Permitir.</p>
            </div>
          </li>
          <li>
            <span class="step-num">3</span>
            <div>
              <strong>Assine o tópico da loja</strong>
              <p>No ntfy, toque em <b>+</b> (ou Subscribe) e cole exatamente este tópico:</p>
              <code>${esc(topic)}</code>
              ${url ? `<p style="margin-top:8px">Ou toque em <b>Abrir / assinar no celular</b> no painel — o link já leva ao tópico certo.</p>` : ''}
            </div>
          </li>
          <li>
            <span class="step-num">4</span>
            <div>
              <strong>Volte aqui e ative</strong>
              <p>Confirme neste modal (ou ligue o interruptor <b>Ligar ntfy</b>). Depois use <b>Testar ntfy</b> — deve aparecer um aviso no iPhone em poucos segundos.</p>
            </div>
          </li>
        </ol>
        <p class="notify-guide-note">Dica: o app ntfy pode ficar fechado. Quando chegar pedido, o servidor avisa o ntfy e o iPhone mostra a notificação.</p>
      `;
    } else {
      if (title) title.textContent = 'Configurar avisos no WhatsApp (iPhone)';
      body.innerHTML = `
        <p class="notify-guide-intro">Cada pedido novo chega como mensagem no WhatsApp. O iPhone notifica pelo próprio WhatsApp.</p>
        <ol class="notify-guide-steps">
          <li>
            <span class="step-num">1</span>
            <div>
              <strong>Abra o WhatsApp no iPhone</strong>
              <p>Use o mesmo número que você quer receber os avisos de pedido.</p>
            </div>
          </li>
          <li>
            <span class="step-num">2</span>
            <div>
              <strong>Autorize o CallMeBot (só uma vez)</strong>
              <p>Adicione o contato <b>+34 694 23 41 84</b> e, no WhatsApp, envie exatamente esta frase:</p>
              <code>I allow callmebot to send me messages</code>
              <p style="margin-top:8px">O bot responde com uma <b>API key</b> (um código). Guarde esse código. Se não vier em ~2 minutos, tente de novo no dia seguinte.</p>
            </div>
          </li>
          <li>
            <span class="step-num">3</span>
            <div>
              <strong>Preencha no painel</strong>
              <p>Em Minha conta → WhatsApp: coloque seu número com <b>55 + DDD + número</b> (ex.: 5547999990000) e a <b>API key</b> que o bot mandou. Toque em <b>Salvar WhatsApp</b>.</p>
            </div>
          </li>
          <li>
            <span class="step-num">4</span>
            <div>
              <strong>Ative e teste</strong>
              <p>Confirme neste modal (ou ligue <b>Ligar WhatsApp</b>). Depois use <b>Testar WhatsApp</b> — a mensagem de teste deve chegar no chat.</p>
            </div>
          </li>
        </ol>
        <p class="notify-guide-note">Importante: o CallMeBot é um serviço externo gratuito. Se o bot não responder, tente de novo em alguns minutos ou use o ntfy.</p>
      `;
    }

    modal.classList.remove('hidden');
  }

  async function loadNotifyChannels() {
    const status = $('#notify-channels-status');
    const topicLine = $('#ntfy-topic-line');
    try {
      const data = await api('/api/notify-channels');
      notifyChannelsState = data;
      if ($('#ntfy-enabled')) $('#ntfy-enabled').checked = !!data.ntfyEnabled;
      if ($('#wa-notify-enabled')) $('#wa-notify-enabled').checked = !!data.whatsappEnabled;
      if ($('#wa-notify-phone')) $('#wa-notify-phone').value = data.whatsappPhone || '';
      if (topicLine) {
        topicLine.innerHTML = data.ntfySubscribeUrl
          ? `Tópico: <code style="word-break:break-all">${esc(data.ntfyTopic)}</code>`
          : 'Tópico ainda não gerado.';
      }
      const isAdmin = state.user && state.user.role === 'admin';
      $('#ntfy-rotate-btn')?.classList.toggle('hidden', !isAdmin);
      $('#wa-notify-fields')?.classList.toggle('hidden', !isAdmin);
      $('#wa-notify-save-btn')?.classList.toggle('hidden', !isAdmin);
      if ($('#ntfy-enabled')) $('#ntfy-enabled').disabled = !isAdmin;
      if ($('#wa-notify-enabled')) $('#wa-notify-enabled').disabled = !isAdmin;
      if (status) {
        const parts = [];
        if (data.ntfyEnabled) parts.push('ntfy ligado');
        if (data.whatsappEnabled && data.whatsappConfigured) parts.push('WhatsApp ligado');
        else if (data.whatsappEnabled) parts.push('WhatsApp ligado (falta API key)');
        status.textContent = parts.length
          ? `Canais ativos: ${parts.join(' · ')}`
          : 'Nenhuma alternativa ligada — o aviso principal é o do navegador.';
      }
    } catch (err) {
      if (status) status.textContent = err.message || 'Não deu para carregar os canais.';
    }
  }

  async function saveNotifyChannels(patch) {
    const data = await api('/api/notify-channels', { method: 'PUT', json: patch });
    notifyChannelsState = data;
    await loadNotifyChannels();
    return data;
  }

  $('#ntfy-enabled')?.addEventListener('change', async (e) => {
    if (!(state.user && state.user.role === 'admin')) {
      e.target.checked = !e.target.checked;
      return toast('Só admin liga/desliga o ntfy.');
    }
    if (e.target.checked) {
      // não salva ainda — abre o guia; ativa só se confirmar
      e.target.checked = true;
      openNotifyGuide('ntfy', { activate: true });
      return;
    }
    try {
      await saveNotifyChannels({ ntfyEnabled: false });
      toast('ntfy desligado');
    } catch (err) {
      e.target.checked = true;
      toast(err.message);
    }
  });

  $('#ntfy-guide-btn')?.addEventListener('click', () => openNotifyGuide('ntfy', { activate: false }));

  $('#ntfy-open-btn')?.addEventListener('click', () => {
    const url = notifyChannelsState && notifyChannelsState.ntfySubscribeUrl;
    if (!url) return toast('Tópico ainda não disponível — atualize a página.');
    window.open(url, '_blank', 'noopener');
    toast('Abra o app ntfy e assine esse tópico (ou use o link aberto).');
  });

  $('#ntfy-test-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/notify-channels/test', { method: 'POST', json: { channel: 'ntfy' } });
      toast('Teste ntfy enviado — confira o app ntfy no iPhone');
    } catch (err) {
      toast(err.message || 'Falha no teste ntfy');
    }
  });

  $('#ntfy-rotate-btn')?.addEventListener('click', async () => {
    if (!(state.user && state.user.role === 'admin')) return;
    if (!confirm('Gerar novo tópico? Quem já assinou o antigo precisa assinar de novo.')) return;
    try {
      await saveNotifyChannels({ rotateNtfyTopic: true });
      toast('Novo tópico gerado');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#wa-notify-enabled')?.addEventListener('change', async (e) => {
    if (!(state.user && state.user.role === 'admin')) {
      e.target.checked = !e.target.checked;
      return toast('Só admin liga/desliga o WhatsApp.');
    }
    if (e.target.checked) {
      e.target.checked = true;
      openNotifyGuide('whatsapp', { activate: true });
      return;
    }
    try {
      await saveNotifyChannels({ whatsappEnabled: false });
      toast('WhatsApp de avisos desligado');
    } catch (err) {
      e.target.checked = true;
      toast(err.message);
    }
  });

  $('#wa-notify-guide-btn')?.addEventListener('click', () => openNotifyGuide('whatsapp', { activate: false }));

  $('#wa-notify-save-btn')?.addEventListener('click', async () => {
    if (!(state.user && state.user.role === 'admin')) return toast('Só admin salva.');
    try {
      const patch = {
        whatsappPhone: $('#wa-notify-phone')?.value || '',
        whatsappEnabled: !!$('#wa-notify-enabled')?.checked,
      };
      const key = ($('#wa-notify-key')?.value || '').trim();
      if (key) patch.whatsappApiKey = key;
      await saveNotifyChannels(patch);
      if ($('#wa-notify-key')) $('#wa-notify-key').value = '';
      toast('WhatsApp de avisos salvo');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#wa-notify-test-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/notify-channels/test', { method: 'POST', json: { channel: 'whatsapp' } });
      toast('Teste WhatsApp enviado — confira as mensagens');
    } catch (err) {
      toast(err.message || 'Falha no teste WhatsApp');
    }
  });

  $('#notify-guide-close')?.addEventListener('click', () => closeNotifyGuide(false));
  $('#notify-guide-cancel')?.addEventListener('click', () => closeNotifyGuide(false));
  $('#notify-guide-confirm')?.addEventListener('click', () => {
    const pending = notifyGuidePending;
    const activate = !!(pending && pending.activate);
    closeNotifyGuide(activate);
  });
  $('#notify-guide-modal')?.addEventListener('click', (e) => {
    if (e.target === $('#notify-guide-modal')) closeNotifyGuide(false);
  });

  initAdminInstall();

  $('#twofa-enable-btn')?.addEventListener('click', async () => {
    $('#twofa-off-actions')?.classList.add('hidden');
    $('#twofa-setup-box')?.classList.remove('hidden');
    $('#account-twofa-code').value = '';
    try {
      const data = await api('/api/2fa/setup', { method: 'POST' });
      $('#account-twofa-qr').src = data.qr;
      $('#account-twofa-secret').textContent = data.secret;
    } catch (err) {
      toast(err.message);
      loadTwoFactorStatus();
    }
  });
  $('#account-twofa-manual')?.addEventListener('click', () => {
    $('#account-twofa-secret-wrap')?.classList.toggle('hidden');
  });
  $('#account-twofa-cancel')?.addEventListener('click', () => loadTwoFactorStatus());
  $('#account-twofa-activate')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/2fa/activate', { json: { code: $('#account-twofa-code').value } });
      state.user = data.user || { ...state.user, needs2faSetup: false };
      if (data.recoveryCodes) showRecoveryCodes(data.recoveryCodes, () => loadTwoFactorStatus());
      else loadTwoFactorStatus();
      toast('2FA ativada');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#rc-password').value;
    if (!password) return toast('Digite sua senha atual.');
    try {
      const data = await api('/api/2fa/recovery-codes', { json: { password } });
      $('#rc-password').value = '';
      showRecoveryCodes(data.recoveryCodes, () => loadTwoFactorStatus());
    } catch (err) {
      toast(err.message);
    }
  });

  $('#twofa-disable-btn')?.addEventListener('click', async () => {
    const { ok, password } = await askConfirm({
      title: 'Desligar verificação em duas etapas',
      text: 'No próximo login o painel não vai mais pedir o código do autenticador. Confirme com a sua senha.',
      password: true,
      okLabel: 'Desligar 2FA',
      danger: true,
    });
    if (!ok || !password) return;
    try {
      const data = await api('/api/2fa/disable', { method: 'POST', json: { password } });
      if (data.user) state.user = { ...state.user, ...data.user };
      toast('2FA desligada');
      if (data.needs2faSetup) {
        toast('Esta loja exige 2FA — configure de novo para continuar.');
        location.reload();
        return;
      }
      loadTwoFactorStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  async function resetUserTwoFactor(id) {
    const u = state.users.find((x) => x.id === id);
    const { ok, password } = await askConfirm({
      title: 'Zerar verificação em duas etapas',
      text: `${u ? u.name : 'Esta pessoa'} vai configurar o aplicativo autenticador de novo no próximo login. Confirme com a SUA senha.`,
      password: true,
      okLabel: 'Zerar 2FA',
    });
    if (!ok || !password) return;
    try {
      await api(`/api/2fa/${id}`, { method: 'DELETE', json: { password } });
      toast('2FA zerado. Avise a pessoa para entrar e configurar de novo.');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  }

  async function doLogout() {
    stopNotifPolling();
    state.notifOrders = [];
    $('#notif-panel')?.classList.add('hidden');
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      /* mesmo com erro, volta pro login */
    }
    state.user = null;
    state.csrf = '';
    showLogin();
  }
  $('#logout-btn').addEventListener('click', doLogout);

  /* ---------- sininho: pedidos novos ---------- */
  const NOTIF_SEEN_KEY = 'gs_notif_last_seen';
  function getNotifLastSeen() {
    try {
      return Number(localStorage.getItem(NOTIF_SEEN_KEY)) || 0;
    } catch {
      return 0;
    }
  }
  function setNotifLastSeen(ts) {
    try {
      localStorage.setItem(NOTIF_SEEN_KEY, String(ts));
    } catch {
      /* navegação privada ou storage bloqueado: segue sem lembrar */
    }
  }
  function playNotifSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.4);
      osc.onended = () => ctx.close();
    } catch {
      /* som é só um extra */
    }
  }
  function notifTimeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function renderNotifBell() {
    const badge = $('#notif-badge');
    const count = state.notifOrders.filter((o) => new Date(o.at).getTime() > state.notifLastSeen).length;
    if (badge) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.toggle('hidden', count === 0);
    }
    const list = $('#notif-list');
    if (!list) return;
    list.innerHTML = state.notifOrders.length
      ? state.notifOrders
          .slice(0, 25)
          .map((o) => {
            const meta = o.meta || {};
            const unread = new Date(o.at).getTime() > state.notifLastSeen;
            const total = meta.total != null ? money(meta.total) : '';
            const orderId = meta.orderId || o.id;
            return `
        <button type="button" class="notif-item ${unread ? 'unread' : ''}" data-open-order="${esc(orderId)}">
          <div class="notif-item-head"><span>${esc(o.targetName || 'Cliente')}</span><span class="notif-item-total">${esc(total)}</span></div>
          <div class="notif-item-detail">${esc(o.detail || '')}</div>
          <div class="notif-item-when">${esc(notifTimeAgo(o.at))}${meta.phone ? ` · ${esc(meta.phone)}` : ''}</div>
        </button>`;
          })
          .join('')
      : '<p class="notif-empty">Nenhum pedido ainda.</p>';
    list.querySelectorAll('[data-open-order]').forEach((btn) =>
      btn.addEventListener('click', () => {
        $('#notif-panel')?.classList.add('hidden');
        state.ordersStatus = 'pending';
        const sel = $('#orders-status-filter');
        if (sel) sel.value = 'pending';
        switchTab('orders');
        loadOrders();
      })
    );
  }
  async function pollNotifOrders(announce) {
    if (!state.user) return;
    try {
      const data = await api('/api/orders/notifications');
      const prevNewest = state.notifOrders[0] ? state.notifOrders[0].id : null;
      state.notifOrders = data.orders || [];
      const newest = state.notifOrders[0];
      const hasNew = newest && newest.id !== prevNewest && new Date(newest.at).getTime() > state.notifLastSeen;
      renderNotifBell();
      if (announce && hasNew) {
        playNotifSound();
        const btn = $('#notif-bell-btn');
        if (btn) {
          btn.classList.remove('ring');
          void btn.offsetWidth;
          btn.classList.add('ring');
        }
        toast(`Novo pedido: ${newest.targetName || 'cliente'}`);
      }
    } catch {
      /* não deixa a checagem de pedidos travar o resto do painel */
    }
  }
  function startNotifPolling() {
    state.notifLastSeen = getNotifLastSeen();
    pollNotifOrders(false);
    clearInterval(state.notifTimer);
    state.notifTimer = setInterval(() => pollNotifOrders(true), 20000);
  }
  function stopNotifPolling() {
    clearInterval(state.notifTimer);
    state.notifTimer = null;
  }
  const notifBellBtn = $('#notif-bell-btn');
  if (notifBellBtn) {
    notifBellBtn.addEventListener('click', () => {
      $('#notif-panel').classList.toggle('hidden');
    });
  }
  document.addEventListener('click', (e) => {
    const bell = $('#notif-bell');
    const panel = $('#notif-panel');
    if (bell && panel && !bell.contains(e.target)) panel.classList.add('hidden');
  });
  const notifMarkRead = $('#notif-mark-read');
  if (notifMarkRead) {
    notifMarkRead.addEventListener('click', () => {
      state.notifLastSeen = Date.now();
      setNotifLastSeen(state.notifLastSeen);
      renderNotifBell();
    });
  }
  const notifOpenOrders = $('#notif-open-orders');
  if (notifOpenOrders) {
    notifOpenOrders.addEventListener('click', () => {
      $('#notif-panel')?.classList.add('hidden');
      state.ordersStatus = 'pending';
      const sel = $('#orders-status-filter');
      if (sel) sel.value = 'pending';
      switchTab('orders');
      loadOrders();
    });
  }

  /* ---------- tabs ---------- */
  const TAB_IDS = ['products', 'orders', 'profit', 'promos', 'coupons', 'categories', 'settings', 'users', 'logs', 'account'];
  function switchTab(id) {
    if (!TAB_IDS.includes(id)) return;
    const more = $('#more-sheet');
    if (more) more.classList.add('hidden');
    closeSidebar();
    document.querySelectorAll('.tab, .side-link').forEach((x) => x.classList.toggle('active', x.dataset.tab === id));
    const dockMain = ['products', 'orders', 'profit'].includes(id);
    document.querySelectorAll('.dock-btn[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === id));
    const moreBtn = $('#dock-more');
    if (moreBtn) moreBtn.classList.toggle('active', !dockMain);
    TAB_IDS.forEach((tab) => {
      const panel = $(`#tab-${tab}`);
      if (panel) panel.classList.toggle('hidden', tab !== id);
    });
    if (id === 'logs') loadLogs(true);
    if (id === 'account') {
      fillProfileForm();
      loadTwoFactorStatus();
      loadNotifyPrefs();
      loadNotifyChannels();
    }
    if (id === 'orders') loadOrders();
  }
  function openSidebar() {
    $('#panel')?.classList.add('sidebar-open');
    $('#sidebar-backdrop')?.classList.remove('hidden');
  }
  function closeSidebar() {
    $('#panel')?.classList.remove('sidebar-open');
    $('#sidebar-backdrop')?.classList.add('hidden');
  }
  document.querySelectorAll('.tab, .dock-btn[data-tab], .side-link, #header-orders-btn').forEach((t) =>
    t.addEventListener('click', () => {
      const id = t.dataset.tab;
      if (id) switchTab(id);
    })
  );
  $('#sidebar-open')?.addEventListener('click', openSidebar);
  $('#sidebar-close')?.addEventListener('click', closeSidebar);
  $('#sidebar-backdrop')?.addEventListener('click', closeSidebar);
  $('#dock-more').addEventListener('click', () => $('#more-sheet').classList.toggle('hidden'));
  document.querySelectorAll('#more-sheet [data-tab]').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
  $('#more-logout').addEventListener('click', doLogout);

  /* ---------- data ---------- */
  async function loadAll() {
    const [{ products, categories, cities }, ledgerRes] = await Promise.all([
      api('/api/products'),
      api('/api/ledger').catch(() => ({ ledger: [] })),
    ]);
    state.products = products;
    state.categories = categories;
    state.cities = cities || [];
    state.ledger = ledgerRes.ledger || [];
    fillCitySelects();
    fillTypeSelects();
    const catOpts =
      '<option value="">Todas categorias</option>' +
      categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const sel = $('#admin-cat-filter');
    if (sel) {
      sel.innerHTML = catOpts;
      sel.value = state.catFilter;
    }
    renderProducts();
    renderProfit();
    if (state.user.role === 'admin') {
      const [settingsRes, users, customersRes] = await Promise.all([
        api('/api/settings'),
        api('/api/users'),
        api('/api/customers').catch(() => ({ customers: [] })),
      ]);
      state.settings = settingsRes.settings || {};
      state.users = users.users || [];
      state.customers = customersRes.customers || [];
      fillCitySelects();
      fillTypeSelects();
      renderProfit();
      renderCategories();
      renderSettings();
      renderPromoAdmin();
      renderCouponAdmin();
      renderUsers();
    }
  }

  /* ---------- products ---------- */
  function flavorSummary(p) {
    const opts = p.options || [];
    if (!opts.length) return '';
    const noPhoto = opts.filter((o) => !o.image).length;
    const off = opts.filter((o) => o.available === false).length;
    const parts = [`${opts.length} sabores`];
    if (noPhoto) parts.push(`${noPhoto} sem foto`);
    if (off) parts.push(`${off} esgotado${off === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  function cityNames() {
    const fromSettings = (state.settings.shipping || []).map((s) => cashboxOf(s.name)).filter(Boolean);
    const fromApi = (state.cities || []).map(cashboxOf).filter(Boolean);
    const fromProducts = state.products.flatMap((p) => (p.cities || []).map(cashboxOf)).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const id of ['Itajaí', 'Joinville', 'Atacado', ...fromSettings, ...fromApi, ...fromProducts]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.length ? out : ['Itajaí', 'Joinville', 'Atacado'];
  }

  function productCities(p) {
    const names = cityNames();
    if (Array.isArray(p.cities) && p.cities.length) {
      const mapped = [...new Set(p.cities.map(cashboxOf).filter(Boolean))];
      if (mapped.length) return mapped;
    }
    const match = names.find((n) => cashboxOf(p.category) === n);
    if (match) return [match];
    const other = names.find((n) => n === 'Atacado') || names[names.length - 1];
    return other ? [other] : [];
  }

  function productInCity(p, city) {
    if (!city) return true;
    return productCities(p).includes(cashboxOf(city) || city);
  }

  function productFlags(p) {
    const tracking = p.stockActive && p.stock != null;
    return {
      tracking,
      out: tracking && p.stock <= 0,
      low: tracking && p.stock > 0 && p.stock <= 3,
      promo: p.promoPrice != null && p.promoPrice < p.price,
      visible: p.active !== false,
      pin: !!p.pin,
    };
  }

  function fillCitySelects() {
    const names = cityNames();
    [
      ['#admin-city-filter', state.cityFilter, 'Todas as cidades'],
      ['#profit-city-filter', state.profitCity, 'Todas as caixas'],
    ].forEach(([sel, value, allLabel]) => {
      const el = $(sel);
      if (!el) return;
      el.innerHTML = `<option value="">${allLabel}</option>` + names.map((c) => `<option value="${esc(c)}">${esc(cityLabel(c))}</option>`).join('');
      el.value = value || '';
    });
  }

  function typeNames() {
    const fromState = (state.categories || []).filter(isTypeCategory);
    const fromProducts = state.products.map((p) => p.category).filter(isTypeCategory);
    const fromLedger = (state.ledger || []).map(ledgerCategory).filter((c) => c && c !== 'Sem categoria' && isTypeCategory(c));
    const seen = new Set();
    const out = [];
    for (const id of ['Pods', 'Refis', 'Baterias', 'Gomas', ...fromState, ...fromProducts, ...fromLedger]) {
      if (!id || seen.has(id) || id === 'Sem categoria' || !isTypeCategory(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if ((state.ledger || []).some((e) => ledgerCategory(e) === 'Sem categoria')) out.push('Sem categoria');
    return sortTypeNames(out);
  }

  function fillTypeSelects() {
    const el = $('#profit-cat-filter');
    if (!el) return;
    const names = typeNames();
    el.innerHTML =
      '<option value="">Todos os tipos</option>' + names.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    el.value = names.includes(state.profitCat) || !state.profitCat ? state.profitCat : '';
    if (el.value !== state.profitCat) state.profitCat = el.value;
  }

  function sortCatalog(list) {
    const mode = state.sort || 'name';
    return [...list].sort((a, b) => {
      if (mode === 'price-asc') return sellPrice(a) - sellPrice(b);
      if (mode === 'price-desc') return sellPrice(b) - sellPrice(a);
      if (mode === 'stock') return (Number(b.stock) || 0) - (Number(a.stock) || 0);
      if (mode === 'status') {
        if ((a.active !== false) !== (b.active !== false)) return a.active !== false ? -1 : 1;
        return a.name.localeCompare(b.name, 'pt-BR');
      }
      return a.name.localeCompare(b.name, 'pt-BR');
    });
  }

  function filteredProducts() {
    const q = state.search.trim().toLowerCase();
    const cat = state.catFilter;
    const city = state.cityFilter;
    const status = state.statusFilter;
    return sortCatalog(
      state.products.filter((p) => {
        if (!productInCity(p, city)) return false;
        if (cat && p.category !== cat) return false;
        if (q && ![p.name, p.category, ...productCities(p)].join(' ').toLowerCase().includes(q)) return false;
        const st = productFlags(p);
        if (status === 'visible' && !st.visible) return false;
        if (status === 'hidden' && st.visible) return false;
        if (status === 'pin' && !st.pin) return false;
        if (status === 'promo' && !st.promo) return false;
        if (status === 'low' && !st.low) return false;
        if (status === 'out' && !st.out) return false;
        return true;
      })
    );
  }

  function bindProductActs(root) {
    root.querySelectorAll('button[data-act]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const { act, id } = b.dataset;
        if (act === 'edit') openProductModal(id);
        else if (act === 'dup') duplicateProduct(id);
        else if (act === 'del') deleteProduct(id);
        else if (act === 'flavors') openFlavors(id);
        else if (act === 'toggle-active') quickToggle(id, 'active');
        else if (act === 'toggle-pin') quickToggle(id, 'pin');
      })
    );
  }

  function productStockControlsHtml(p) {
    if (!state.cityFilter) return '';
    const tracking = p.stockActive && p.stock != null;
    const qty = tracking ? Number(p.stock) || 0 : null;
    const lowStock = tracking && qty <= 3;
    if (!tracking) {
      return `<div class="inline-stock inline-stock-off">
        <span class="stock-count off">Sem estoque</span>
        <button type="button" class="btn-link stock-edit-link" data-act="edit" data-id="${esc(p.id)}">Ativar na edição</button>
      </div>`;
    }
    return `<div class="inline-stock" data-stock-id="${esc(p.id)}">
      <span class="stock-count ${lowStock ? 'low' : ''}" title="Quantidade atual">${qty} un.</span>
      <div class="qty-step" title="Quanto vai entrar ou sair">
        <button type="button" data-act="qty-minus">−</button>
        <span class="move-qty">1</span>
        <button type="button" data-act="qty-plus">+</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-act="in">+ Entrada</button>
      <button type="button" class="btn btn-gold btn-sm" data-act="sale">Vendi</button>
      <label class="inline-cost">Custo
        <input type="number" min="0" step="0.01" inputmode="decimal" class="stock-cost" value="${p.cost != null ? p.cost : ''}" placeholder="R$" />
      </label>
    </div>`;
  }

  function bindInlineStock(root) {
    root.querySelectorAll('.inline-stock[data-stock-id]').forEach((row) => {
      const id = row.dataset.stockId;
      const qtyEl = row.querySelector('.move-qty');
      const costInput = row.querySelector('.stock-cost');
      const readQty = () => Math.max(1, parseInt(qtyEl?.textContent, 10) || 1);
      row.querySelector('[data-act="qty-minus"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (qtyEl) qtyEl.textContent = Math.max(1, readQty() - 1);
      });
      row.querySelector('[data-act="qty-plus"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (qtyEl) qtyEl.textContent = Math.min(999, readQty() + 1);
      });
      row.querySelector('[data-act="in"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        stockMove(id, 'in', readQty());
      });
      row.querySelector('[data-act="sale"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        stockMove(id, 'sale', readQty());
      });
      costInput?.addEventListener('change', () => saveCost(id, costInput.value));
    });
  }

  function productRowHtml(p) {
    const st = productFlags(p);
    const flavors = (p.options || []).length;
    const stockMode = !!state.cityFilter;
    const chips = stockMode
      ? ''
      : productCities(p).map((c) => `<span class="city-chip">${esc(cityLabel(c))}</span>`).join('');
    const nameCell = `<td class="t-name">${esc(p.name)}${
      flavors ? `<small class="t-flavors">${esc(flavorSummary(p))}</small>` : ''
    }${chips ? `<div class="city-chips">${chips}</div>` : ''}</td>`;
    const statusCell = `<td><div class="status">
      <button type="button" class="status-toggle ${st.visible ? 'on' : 'off'}" data-act="toggle-active" data-id="${esc(p.id)}" title="Visível na loja">${st.visible ? 'Visível' : 'Oculto'}</button>
      <button type="button" class="status-toggle ${st.pin ? 'promo' : ''}" data-act="toggle-pin" data-id="${esc(p.id)}" title="Destaque">${st.pin ? '★ Destaque' : '☆ Normal'}</button>
      ${!stockMode && st.out ? '<span class="out">Esgotado</span>' : !stockMode && st.tracking ? `<span class="${p.stock <= 3 ? 'out' : 'on'}">${p.stock} un.</span>` : ''}
    </div></td>`;
    const acts = `<td><div class="t-actions">
      <button class="icon-btn" data-act="flavors" data-id="${esc(p.id)}" title="Sabores e fotos">🎨</button>
      <button class="icon-btn" data-act="edit" data-id="${esc(p.id)}" title="Editar">✏️</button>
      <button class="icon-btn" data-act="dup" data-id="${esc(p.id)}" title="Duplicar">📋</button>
      <button class="icon-btn danger" data-act="del" data-id="${esc(p.id)}" title="Tirar">🗑</button>
    </div></td>`;

    if (stockMode) {
      return `
        <tr class="stock-mode-row">
          <td><img class="t-thumb img-hide-on-error" src="${esc(p.image)}" alt="" loading="lazy" /></td>
          ${nameCell}
          <td class="t-stock-cell">${productStockControlsHtml(p)}</td>
          <td class="t-price">${money(st.promo ? p.promoPrice : p.price)}${st.promo ? `<small>${money(p.price)}</small>` : ''}</td>
          ${statusCell}
          ${acts}
        </tr>`;
    }

    return `
        <tr>
          <td><img class="t-thumb img-hide-on-error" src="${esc(p.image)}" alt="" loading="lazy" /></td>
          ${nameCell}
          <td class="t-cat t-cat-col">${esc(p.category || '—')}</td>
          <td class="t-price">${money(st.promo ? p.promoPrice : p.price)}${st.promo ? `<small>${money(p.price)}</small>` : ''}</td>
          ${statusCell}
          ${acts}
        </tr>`;
  }

  function productCardHtml(p) {
    const st = productFlags(p);
    const flavors = flavorSummary(p);
    const stockMode = !!state.cityFilter;
    const chips = stockMode
      ? ''
      : productCities(p).map((c) => `<span class="city-chip">${esc(cityLabel(c))}</span>`).join('');
    return `
          <div class="product-card ${stockMode ? 'product-card-stock' : ''}">
            <img class="img-hide-on-error" src="${esc(p.image || '')}" alt="" loading="lazy" />
            <div class="product-card-main">
              <button type="button" class="product-card-open" data-act="edit" data-id="${esc(p.id)}">
                <span class="product-card-name">${esc(p.name)}</span>
                <span class="product-card-meta">${esc(p.category || '—')}${st.out ? ' · esgotado' : st.tracking ? ` · ${p.stock} un.` : ''} · ${st.visible ? 'visível' : 'oculto'}</span>
                ${chips ? `<span class="city-chips">${chips}</span>` : ''}
                ${flavors ? `<span class="product-card-flavors">${esc(flavors)}</span>` : ''}
              </button>
              ${productStockControlsHtml(p)}
            </div>
            <div class="product-card-side">
              <strong class="product-card-price">${money(st.promo ? p.promoPrice : p.price)}</strong>
              <button type="button" class="icon-btn" data-act="flavors" data-id="${esc(p.id)}" title="Sabores">🎨</button>
            </div>
          </div>`;
  }

  function updateStockAlert() {
    const low = state.products.filter((p) => p.stockActive && p.stock != null && p.stock <= 3);
    const alert = $('#stock-alert');
    if (!alert) return;
    if (low.length) {
      alert.classList.remove('hidden');
      alert.textContent = `${low.length} produto${low.length === 1 ? '' : 's'} com estoque baixo (3 ou menos). Toque numa caixa para ajustar.`;
    } else {
      alert.classList.add('hidden');
    }
  }

  function renderCatalogStats() {
    const wrap = $('#catalog-stats');
    if (!wrap) return;
    wrap.innerHTML = cityNames()
      .map((city) => {
        const list = state.products.filter((p) => productInCity(p, city));
        const tracking = list.filter((p) => p.stockActive && p.stock != null);
        const units = tracking.reduce((s, p) => s + (Number(p.stock) || 0), 0);
        const low = tracking.filter((p) => p.stock <= 3).length;
        return `<button type="button" class="catalog-stat ${state.cityFilter === city ? 'active' : ''}" data-city="${esc(city)}">
          <strong>${list.length}</strong>
          <span>${esc(cityLabel(city))}</span>
          <small>${units} un. em estoque${low ? ` · ${low} baixo` : ''}</small>
        </button>`;
      })
      .join('');
    wrap.querySelectorAll('[data-city]').forEach((b) =>
      b.addEventListener('click', () => {
        state.cityFilter = state.cityFilter === b.dataset.city ? '' : b.dataset.city;
        const sel = $('#admin-city-filter');
        if (sel) sel.value = state.cityFilter;
        renderProducts();
      })
    );
  }

  function renderProducts() {
    updateStockAlert();
    renderCatalogStats();
    const list = filteredProducts();
    const count = $('#catalog-count');
    if (count) {
      count.textContent = state.cityFilter
        ? `${list.length} produto${list.length === 1 ? '' : 's'} · estoque de ${cityLabel(state.cityFilter)}`
        : `${list.length} produto${list.length === 1 ? '' : 's'} · toque numa caixa para estoque`;
    }
    const board = $('#catalog-board');
    if (!list.length) {
      board.innerHTML = '<p class="profit-empty">Nenhum produto nesta busca.</p>';
      renderPager($('#products-pager'), { page: 1, pages: 1, total: 0, size: state.pageSize }, () => {});
      return;
    }

    const pageInfo = pageSlice(list, state.productsPage, state.pageSize);
    state.productsPage = pageInfo.page;
    const pageItems = pageInfo.items;

    const renderCatBlocks = (items) => {
      const cats = sortTypeNames([...new Set(items.map((p) => p.category || 'Sem categoria'))]);
      const stockMode = !!state.cityFilter;
      const head = stockMode
        ? '<thead><tr><th></th><th>Produto</th><th>Estoque</th><th>Preço</th><th>Status</th><th></th></tr></thead>'
        : '<thead><tr><th></th><th>Produto</th><th>Categoria</th><th>Preço</th><th>Status</th><th></th></tr></thead>';
      return cats
        .map((cat) => {
          const rows = items.filter((p) => (p.category || 'Sem categoria') === cat);
          return `<details class="catalog-cat" open>
            <summary>${esc(cat)} <em>${rows.length}</em></summary>
            <div class="table-wrap desktop-only ${stockMode ? 'table-wrap-stock' : ''}">
              <table class="table ${stockMode ? 'table-stock' : ''}">
                ${head}
                <tbody>${rows.map(productRowHtml).join('')}</tbody>
              </table>
            </div>
            <div class="product-cards mobile-only">${rows.map(productCardHtml).join('')}</div>
          </details>`;
        })
        .join('');
    };

    if (!state.cityFilter) {
      board.innerHTML = `<div class="catalog-city-body">${renderCatBlocks(pageItems)}</div>`;
      bindProductActs(board);
      bindInlineStock(board);
      renderPager($('#products-pager'), pageInfo, (p) => {
        state.productsPage = p;
        renderProducts();
      });
      return;
    }

    const cities = cityNames().filter((c) => c === state.cityFilter);
    board.innerHTML = cities
      .map((city) => {
        const items = pageItems.filter((p) => productInCity(p, city));
        if (!items.length) return '';
        const hidden = items.filter((p) => p.active === false).length;
        return `<details class="catalog-city" open>
          <summary>${esc(cityLabel(city))} <em>${items.length} produto${items.length === 1 ? '' : 's'}${hidden ? ` · ${hidden} oculto${hidden === 1 ? '' : 's'}` : ''}</em></summary>
          <div class="catalog-city-body">${renderCatBlocks(items)}</div>
        </details>`;
      })
      .join('') || '<p class="profit-empty">Nenhum produto nesta busca.</p>';
    bindProductActs(board);
    bindInlineStock(board);
    renderPager($('#products-pager'), pageInfo, (p) => {
      state.productsPage = p;
      renderProducts();
    });
  }

  async function quickToggle(id, field) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    try {
      await api(`/api/products/${id}/quick`, { method: 'PATCH', json: { [field]: !p[field] } });
      await loadAll();
      toast('Atualizado');
    } catch (err) {
      toast(err.message);
    }
  }

  async function duplicateProduct(id) {
    try {
      await api(`/api/products/${id}/duplicate`, { method: 'POST' });
      toast('Produto duplicado (fica oculto até você editar)');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  }

  $('#admin-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.productsPage = 1;
    renderProducts();
  });
  $('#admin-cat-filter').addEventListener('change', (e) => {
    state.catFilter = e.target.value;
    state.productsPage = 1;
    renderProducts();
  });
  $('#admin-city-filter').addEventListener('change', (e) => {
    state.cityFilter = e.target.value;
    state.productsPage = 1;
    renderProducts();
  });
  $('#admin-status-filter').addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    state.productsPage = 1;
    renderProducts();
  });
  $('#admin-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.productsPage = 1;
    renderProducts();
  });
  $('#add-product-btn').addEventListener('click', () => openProductModal(null));
  $('#fab-add').addEventListener('click', () => openProductModal(null));

  async function loadOrders() {
    try {
      const status = state.ordersView === 'kanban' ? 'all' : state.ordersStatus || 'pending';
      const qs = new URLSearchParams({
        status,
        period: state.ordersPeriod || 'all',
        q: state.ordersSearch || '',
        limit: '500',
      });
      const data = await api(`/api/orders?${qs}`);
      state.orders = data.orders || [];
      state.ordersStats = data.stats || {};
      renderOrders();
    } catch (err) {
      toast(err.message || 'Erro ao carregar pedidos');
    }
  }

  function orderStatusLabel(status) {
    const map = {
      pending: 'Recebido',
      approved: 'Aceito',
      shipped: 'Em rota',
      completed: 'Finalizado',
      cancelled: 'Recusado',
      returned: 'Devolvido',
    };
    return map[status] || status || 'Recebido';
  }

  function formatOrderWhen(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function orderFootHint(o) {
    if (o.status === 'pending') return '';
    if (o.status === 'approved') return `Aceito por ${esc(o.approvedBy || '—')}`;
    if (o.status === 'shipped') return `Em rota · ${esc(o.shippedBy || '—')}`;
    if (o.status === 'completed') return `Finalizado · ${esc(o.completedBy || '—')}`;
    if (o.status === 'cancelled') return `Recusado por ${esc(o.cancelledBy || '—')}`;
    if (o.status === 'returned') return `Devolvido · ${esc(o.returnedBy || '—')}`;
    return '';
  }

  function orderCardHtml(o, { compact } = {}) {
    if (compact) {
      const products = (o.items || [])
        .map((it) => `${it.qty}x ${esc(it.name)}${it.option ? ` · ${esc(it.option)}` : ''}`)
        .join(' · ');
      return `<article class="order-kanban-card status-${esc(o.status)}" data-id="${esc(o.id)}" role="button" tabindex="0" title="Abrir detalhes">
        <strong class="order-kanban-name">${esc(o.customerName || 'Cliente')}</strong>
        <span class="order-kanban-city">${esc(o.city || '—')}</span>
        <span class="order-kanban-products">${products || 'Sem itens'}</span>
        <strong class="order-kanban-total">${money(o.total)}</strong>
      </article>`;
    }
    const when = formatOrderWhen(o.createdAt);
    const items = (o.items || [])
      .map((it) => `${it.qty}x ${esc(it.name)}${it.option ? ` (${esc(it.option)})` : ''} — ${money(it.price * it.qty)}`)
      .join('<br>');
    const pending = o.status === 'pending';
    const hint = orderFootHint(o);
    return `<article class="order-admin-card status-${esc(o.status)}" data-id="${esc(o.id)}" role="button" tabindex="0">
      <div class="order-admin-top">
        <div>
          <strong>${esc(o.customerName || 'Cliente')}</strong>
          <span class="order-admin-status">${esc(orderStatusLabel(o.status))}</span>
        </div>
        <time>${esc(when)}</time>
      </div>
      <div class="order-admin-meta">
        ${esc(o.city || '—')} · ${esc(o.address || 'Sem endereço')}<br>
        WhatsApp: ${esc(o.phone || '—')} · ${esc(o.payment || 'Pagamento')}
        ${o.couponCode ? `<br>Cupom: ${esc(o.couponCode)}` : ''}
        ${o.note ? `<br>Obs: ${esc(o.note)}` : ''}
      </div>
      <div class="order-admin-items">${items}</div>
      <div class="order-admin-foot">
        <strong>${money(o.total)}</strong>
        ${pending
          ? `<div class="order-admin-acts">
              <button type="button" class="btn btn-gold btn-sm" data-order-act="approve">Aceitar</button>
              <button type="button" class="btn btn-ghost btn-sm" data-order-act="cancel">Recusar</button>
            </div>`
          : hint
            ? `<small>${hint}</small>`
            : ''}
      </div>
    </article>`;
  }

  function bindOrderCards(root) {
    if (!root) return;
    root.querySelectorAll('[data-order-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const card = btn.closest('[data-id]');
        const id = card && card.dataset.id;
        if (!id) return;
        const act = btn.dataset.orderAct;
        btn.disabled = true;
        try {
          if (act === 'approve') {
            await api(`/api/orders/${encodeURIComponent(id)}/approve`, { method: 'POST', json: {} });
            toast('Pedido aceito e estoque atualizado');
            await loadAll();
          } else if (act === 'cancel') {
            await api(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', json: {} });
            toast('Pedido recusado');
          }
          await loadOrders();
          pollNotifOrders(false);
        } catch (err) {
          toast(err.message || 'Falha ao atualizar pedido');
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('[data-id]').forEach((card) => {
      if (!card.classList.contains('order-admin-card') && !card.classList.contains('order-kanban-card')) return;
      const open = () => openOrderModal(card.dataset.id);
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-order-act]')) return;
        open();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  const KANBAN_COLS = [
    { id: 'pending', title: 'Recebido' },
    { id: 'approved', title: 'Aceito' },
    { id: 'shipped', title: 'Em rota' },
    { id: 'completed', title: 'Finalizado' },
    { id: 'cancelled', title: 'Recusado' },
    { id: 'returned', title: 'Devolvido' },
  ];

  function renderOrders() {
    document.querySelectorAll('#orders-period .period-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.period === state.ordersPeriod)
    );
    document.querySelectorAll('#orders-view-toggle [data-orders-view]').forEach((b) =>
      b.classList.toggle('active', b.dataset.ordersView === state.ordersView)
    );
    const statusFilter = $('#orders-status-filter');
    if (statusFilter) statusFilter.disabled = state.ordersView === 'kanban';

    const stats = state.ordersStats || {};
    const statsEl = $('#orders-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="profit-card"><span>Recebidos</span><strong>${stats.pending || 0}</strong></div>
        <div class="profit-card ok"><span>Aceitos</span><strong>${stats.approvedCount || 0}</strong></div>
        <div class="profit-card"><span>Em rota</span><strong>${stats.shippedCount || 0}</strong></div>
        <div class="profit-card"><span>Finalizados</span><strong>${stats.completedCount || 0}</strong></div>
        <div class="profit-card"><span>Faturamento ativo</span><strong>${money(stats.approvedTotal || 0)}</strong></div>
      `;
    }

    const listWrap = $('#orders-list');
    const kanbanWrap = $('#orders-kanban');
    const pager = $('#orders-pager');

    if (state.ordersView === 'kanban') {
      if (listWrap) {
        listWrap.classList.add('hidden');
        listWrap.innerHTML = '';
      }
      if (pager) {
        pager.classList.add('hidden');
        pager.innerHTML = '';
      }
      if (!kanbanWrap) return;
      kanbanWrap.classList.remove('hidden');
      kanbanWrap.innerHTML = KANBAN_COLS.map((col) => {
        const items = state.orders.filter((o) => o.status === col.id);
        const cards = items.length
          ? items.map((o) => orderCardHtml(o, { compact: true })).join('')
          : '<p class="orders-kanban-empty">Vazio</p>';
        return `<div class="orders-kanban-col" data-col="${esc(col.id)}">
          <h4>${esc(col.title)} <em>${items.length}</em></h4>
          ${cards}
        </div>`;
      }).join('');
      bindOrderCards(kanbanWrap);
      return;
    }

    if (kanbanWrap) {
      kanbanWrap.classList.add('hidden');
      kanbanWrap.innerHTML = '';
    }
    if (!listWrap) return;
    listWrap.classList.remove('hidden');
    if (!state.orders.length) {
      listWrap.innerHTML = '<p class="profit-empty">Nenhum pedido neste filtro.</p>';
      renderPager(pager, { page: 1, pages: 1, total: 0, size: state.pageSize }, () => {});
      return;
    }
    const pageInfo = pageSlice(state.orders, state.ordersPage, state.pageSize);
    state.ordersPage = pageInfo.page;
    listWrap.innerHTML = pageInfo.items.map((o) => orderCardHtml(o)).join('');
    bindOrderCards(listWrap);
    renderPager(pager, pageInfo, (p) => {
      state.ordersPage = p;
      renderOrders();
    });
  }

  function orderItemImage(it) {
    if (it && it.image) return it.image;
    const byId = it.productId ? state.products.find((p) => p.id === it.productId) : null;
    const byName = !byId
      ? state.products.find((p) => fold(p.name) === fold(it.name))
      : null;
    const p = byId || byName;
    if (!p) return '';
    if (it.option) {
      const opt = (p.options || []).find((o) => fold(o.title) === fold(it.option));
      if (opt && opt.image) return opt.image;
    }
    return p.image || '';
  }

  function closeOrderModal() {
    state.orderModalId = null;
    $('#order-modal')?.classList.add('hidden');
  }

  function openOrderModal(id) {
    const order = state.orders.find((o) => o.id === id);
    if (!order) return;
    state.orderModalId = id;
    const modal = $('#order-modal');
    const title = $('#order-modal-title');
    const body = $('#order-modal-body');
    const foot = $('#order-modal-foot');
    if (!modal || !body || !foot) return;

    if (title) title.textContent = `Pedido · ${orderStatusLabel(order.status)}`;
    const items = (order.items || [])
      .map((it) => {
        const img = orderItemImage(it);
        return `<div class="order-detail-item">
          <div class="order-detail-thumb">
            ${img
              ? `<img class="img-hide-on-error" src="${esc(img)}" alt="" loading="lazy" />`
              : `<span class="order-detail-thumb-empty">?</span>`}
          </div>
          <div class="order-detail-item-main">
            <strong>${it.qty}x ${esc(it.name)}</strong>
            ${it.option ? `<span class="order-detail-opt">${esc(it.option)}</span>` : ''}
          </div>
          <strong class="order-detail-price">${money(it.price * it.qty)}</strong>
        </div>`;
      })
      .join('');
    const timeline = [
      order.createdAt ? `Recebido · ${formatOrderWhen(order.createdAt)}` : '',
      order.approvedAt ? `Aceito por ${order.approvedBy || '—'} · ${formatOrderWhen(order.approvedAt)}` : '',
      order.shippedAt ? `Em rota · ${order.shippedBy || '—'} · ${formatOrderWhen(order.shippedAt)}` : '',
      order.completedAt ? `Finalizado · ${order.completedBy || '—'} · ${formatOrderWhen(order.completedAt)}` : '',
      order.cancelledAt ? `Recusado por ${order.cancelledBy || '—'} · ${formatOrderWhen(order.cancelledAt)}` : '',
      order.returnedAt ? `Devolvido · ${order.returnedBy || '—'} · ${formatOrderWhen(order.returnedAt)}` : '',
    ]
      .filter(Boolean)
      .map((line) => `<div>${esc(line)}</div>`)
      .join('');

    body.innerHTML = `
      <div class="order-detail-grid">
        <div class="order-detail-row"><span>Cliente</span><div>${esc(order.customerName || '—')}</div></div>
        <div class="order-detail-row"><span>WhatsApp</span><div>${esc(order.phone || '—')}</div></div>
        <div class="order-detail-row"><span>Cidade</span><div>${esc(order.city || '—')}</div></div>
        <div class="order-detail-row"><span>Endereço</span><div>${esc(order.address || '—')}</div></div>
        <div class="order-detail-row"><span>Pagamento</span><div>${esc(order.payment || '—')}</div></div>
        ${order.couponCode ? `<div class="order-detail-row"><span>Cupom</span><div>${esc(order.couponCode)}</div></div>` : ''}
        ${order.note ? `<div class="order-detail-row"><span>Obs.</span><div>${esc(order.note)}</div></div>` : ''}
        ${order.cashbackUsed ? `<div class="order-detail-row"><span>Cashback</span><div>${money(order.cashbackUsed)}</div></div>` : ''}
        <div class="order-detail-items">${items || '<p class="hint">Sem itens</p>'}</div>
        <div class="order-detail-total">${money(order.total)}</div>
        <div class="order-detail-timeline">${timeline}</div>
      </div>
    `;

    const acts = [];
    if (order.status === 'pending') {
      acts.push(`<button type="button" class="btn btn-gold" data-om-act="approve">Aceitar (baixa estoque)</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="cancel">Recusar</button>`);
    }
    if (order.status === 'approved') {
      acts.push(`<button type="button" class="btn btn-gold" data-om-act="ship">Marcar em rota</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="complete">Finalizar</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="return">Devolvido</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="undo">Desfazer</button>`);
    }
    if (order.status === 'shipped') {
      acts.push(`<button type="button" class="btn btn-gold" data-om-act="complete">Finalizar</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="return">Devolvido</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="undo">Desfazer</button>`);
    }
    if (order.status === 'completed') {
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="return">Devolvido</button>`);
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="undo">Desfazer</button>`);
    }
    if (order.status === 'cancelled' || order.status === 'returned') {
      acts.push(`<button type="button" class="btn btn-ghost" data-om-act="undo">Desfazer</button>`);
    }
    foot.innerHTML = `<div class="order-modal-acts">${acts.join('')}</div>`;

    foot.querySelectorAll('[data-om-act]').forEach((btn) => {
      btn.addEventListener('click', () => runOrderAction(order.id, btn.dataset.omAct, btn));
    });
    modal.classList.remove('hidden');
  }

  async function runOrderAction(id, act, btn) {
    const confirmMap = {
      undo: { title: 'Desfazer pedido', text: 'O estoque e o Lucro voltam como antes (se houver baixa). O pedido volta para Recebido.', okLabel: 'Desfazer' },
      return: { title: 'Marcar como devolvido', text: 'O estoque será devolvido e a venda sai do Lucro.', okLabel: 'Devolvido' },
      cancel: { title: 'Recusar pedido', text: 'O pedido será arquivado sem mexer no estoque.', okLabel: 'Recusar' },
    };
    if (confirmMap[act]) {
      const { ok } = await askConfirm(confirmMap[act]);
      if (!ok) return;
    }
    if (btn) btn.disabled = true;
    try {
      if (act === 'approve') {
        await api(`/api/orders/${encodeURIComponent(id)}/approve`, { method: 'POST', json: {} });
        toast('Pedido aceito');
        await loadAll();
      } else if (act === 'cancel') {
        await api(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', json: {} });
        toast('Pedido recusado');
      } else if (act === 'ship') {
        await api(`/api/orders/${encodeURIComponent(id)}/status`, { method: 'POST', json: { status: 'shipped' } });
        toast('Pedido em rota');
      } else if (act === 'complete') {
        await api(`/api/orders/${encodeURIComponent(id)}/status`, { method: 'POST', json: { status: 'completed' } });
        toast('Pedido finalizado');
      } else if (act === 'return') {
        await api(`/api/orders/${encodeURIComponent(id)}/status`, { method: 'POST', json: { status: 'returned' } });
        toast('Pedido devolvido · estoque restaurado');
        await loadAll();
      } else if (act === 'undo') {
        await api(`/api/orders/${encodeURIComponent(id)}/undo`, { method: 'POST', json: {} });
        toast('Pedido desfeito');
        await loadAll();
      }
      await loadOrders();
      pollNotifOrders(false);
      const updated = state.orders.find((o) => o.id === id);
      if (updated) openOrderModal(id);
      else closeOrderModal();
    } catch (err) {
      toast(err.message || 'Falha ao atualizar pedido');
      if (btn) btn.disabled = false;
    }
  }

  $('#order-modal-close')?.addEventListener('click', closeOrderModal);
  $('#order-modal')?.addEventListener('click', (e) => {
    if (e.target === $('#order-modal')) closeOrderModal();
  });

  $('#orders-period')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    state.ordersPeriod = btn.dataset.period;
    state.ordersPage = 1;
    loadOrders();
  });
  $('#orders-status-filter')?.addEventListener('change', (e) => {
    state.ordersStatus = e.target.value;
    state.ordersPage = 1;
    loadOrders();
  });
  $('#orders-view-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-orders-view]');
    if (!btn) return;
    state.ordersView = btn.dataset.ordersView;
    state.ordersPage = 1;
    loadOrders();
  });
  let ordersSearchTimer;
  $('#orders-search')?.addEventListener('input', (e) => {
    clearTimeout(ordersSearchTimer);
    ordersSearchTimer = setTimeout(() => {
      state.ordersSearch = e.target.value;
      state.ordersPage = 1;
      loadOrders();
    }, 200);
  });

  $('#stock-search')?.addEventListener('input', () => {});
  $('#stock-cat-filter')?.addEventListener('change', () => {});
  $('#profit-period').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    state.profitPeriod = btn.dataset.period;
    state.profitPage = 1;
    renderProfit();
  });
  $('#profit-city-filter').addEventListener('change', (e) => {
    state.profitCity = e.target.value;
    state.profitPage = 1;
    renderProfit();
  });
  $('#profit-cat-filter').addEventListener('change', (e) => {
    state.profitCat = e.target.value;
    state.profitPage = 1;
    renderProfit();
  });

  /* ---------- stock ---------- */
  function stockList() {
    const q = state.stockSearch.trim().toLowerCase();
    const cat = state.stockCat;
    const city = state.stockCity;
    return state.products.filter((p) => {
      if (!city || !productInCity(p, city)) return false;
      if (cat && p.category !== cat) return false;
      return !q || [p.name, p.category, ...productCities(p)].join(' ').toLowerCase().includes(q);
    });
  }

  function renderStockHub() {
    const hub = $('#stock-hub');
    const detail = $('#stock-detail');
    if (hub) hub.classList.remove('hidden');
    if (detail) detail.classList.add('hidden');
    if (!hub) return;
    hub.innerHTML = cityNames()
      .map((city) => {
        const items = state.products.filter((p) => productInCity(p, city));
        const tracking = items.filter((p) => p.stockActive && p.stock != null);
        const low = tracking.filter((p) => p.stock <= 3).length;
        const units = tracking.reduce((s, p) => s + (Number(p.stock) || 0), 0);
        return `<button type="button" class="stock-box-card" data-stock-city="${esc(city)}">
          <h3>${esc(cityLabel(city))}</h3>
          <p><strong>${items.length}</strong> produto${items.length === 1 ? '' : 's'}</p>
          <p><strong>${units}</strong> un. controladas${low ? ` · <strong>${low}</strong> baixo` : ''}</p>
        </button>`;
      })
      .join('');
    hub.querySelectorAll('[data-stock-city]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.stockCity = btn.dataset.stockCity;
        state.stockView = 'detail';
        state.stockSearch = '';
        state.stockCat = '';
        const search = $('#stock-search');
        if (search) search.value = '';
        const cat = $('#stock-cat-filter');
        if (cat) cat.value = '';
        renderStock();
      });
    });
  }

  function renderStockDetail() {
    const hub = $('#stock-hub');
    const detail = $('#stock-detail');
    if (hub) hub.classList.add('hidden');
    if (detail) detail.classList.remove('hidden');
    const title = $('#stock-detail-title');
    if (title) title.textContent = `Estoque · ${cityLabel(state.stockCity)}`;
    const list = stockList();
    const wrap = $('#stock-list');
    if (!wrap) return;
    wrap.innerHTML =
      list
        .map((p) => {
          const price = sellPrice(p);
          const profit = unitProfit(p);
          const tracking = p.stockActive && p.stock != null;
          const qty = tracking ? p.stock : null;
          const lowStock = tracking && qty <= 3;
          return `
        <article class="stock-card" data-id="${esc(p.id)}">
          <img class="img-hide-on-error" src="${esc(p.image || '')}" alt="" loading="lazy" />
          <div>
            <div class="stock-card-name">${esc(p.name)}</div>
            <div class="stock-card-meta">${esc(p.category || '—')} · <strong>${money(price)}</strong></div>
            <div class="${profit == null ? 'unit-profit missing' : 'unit-profit'}">${
              profit == null ? 'Informe o custo para ver o lucro' : `Lucro ${money(profit)} / un.`
            }</div>
          </div>
          <div class="stock-cost-row">
            <label>Custo (R$)
              <input type="number" min="0" step="0.01" inputmode="decimal" class="stock-cost" value="${p.cost != null ? p.cost : ''}" placeholder="O que você pagou" />
            </label>
          </div>
          <div class="stock-qty-line">
            <span class="stock-count ${!tracking ? 'off' : lowStock ? 'low' : ''}">${
              tracking ? `Estoque ${qty}` : 'Sem estoque — ative na edição'
            }</span>
            <div class="qty-step">
              <button type="button" data-act="qty-minus">−</button>
              <span class="move-qty">1</span>
              <button type="button" data-act="qty-plus">+</button>
            </div>
          </div>
          <div class="stock-actions">
            <button type="button" class="btn btn-ghost" data-act="in">+ Entrada</button>
            <button type="button" class="btn btn-gold" data-act="sale">Vendi</button>
          </div>
        </article>`;
        })
        .join('') || '<p class="profit-empty">Nenhum produto nesta caixa.</p>';

    wrap.querySelectorAll('.stock-card').forEach((card) => {
      const id = card.dataset.id;
      const qtyEl = card.querySelector('.move-qty');
      const costInput = card.querySelector('.stock-cost');
      const readQty = () => Math.max(1, parseInt(qtyEl.textContent, 10) || 1);
      card.querySelector('[data-act="qty-minus"]').addEventListener('click', () => {
        qtyEl.textContent = Math.max(1, readQty() - 1);
      });
      card.querySelector('[data-act="qty-plus"]').addEventListener('click', () => {
        qtyEl.textContent = Math.min(999, readQty() + 1);
      });
      card.querySelector('[data-act="in"]').addEventListener('click', () => stockMove(id, 'in', readQty()));
      card.querySelector('[data-act="sale"]').addEventListener('click', () => stockMove(id, 'sale', readQty()));
      costInput.addEventListener('change', () => saveCost(id, costInput.value));
    });
  }

  function renderStock() {
    const low = state.products.filter((p) => p.stockActive && p.stock != null && p.stock <= 3);
    const alert = $('#stock-alert');
    if (alert) {
      if (low.length) {
        alert.classList.remove('hidden');
        alert.textContent = `${low.length} produto${low.length === 1 ? '' : 's'} com estoque baixo (3 ou menos).`;
      } else {
        alert.classList.add('hidden');
      }
    }
    if (state.stockView === 'detail' && state.stockCity) renderStockDetail();
    else renderStockHub();
  }

  async function saveCost(id, raw) {
    try {
      await api(`/api/products/${id}/quick`, { method: 'PATCH', json: { cost: raw === '' ? null : Number(raw) } });
      await loadAll();
      toast('Custo salvo');
    } catch (err) {
      toast(err.message);
    }
  }

  async function stockMove(id, type, qty) {
    try {
      await api('/api/stock/move', { json: { productId: id, type, qty } });
      await loadAll();
      toast(type === 'sale' ? 'Venda registrada' : 'Entrada no estoque');
    } catch (err) {
      toast(err.message);
    }
  }

  /* ---------- profit ---------- */
  function periodStart(period) {
    const now = new Date();
    if (period === 'all') return null;
    const d = new Date(now);
    if (period === 'today') d.setHours(0, 0, 0, 0);
    else if (period === 'week') d.setDate(d.getDate() - 7);
    else if (period === 'month') {
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
    }
    return d;
  }

  function ledgerCities(e) {
    const raw = Array.isArray(e.cities) && e.cities.length ? e.cities : e.city ? [e.city] : null;
    if (raw) {
      const mapped = [...new Set(raw.map(cashboxOf).filter(Boolean))];
      if (mapped.length) return mapped;
    }
    const p = state.products.find((x) => x.id === e.productId);
    return p ? productCities(p) : [cashboxOf(e.category)].filter(Boolean);
  }

  function ledgerPrimaryCity(e) {
    return cashboxOf(ledgerCities(e)[0]) || ledgerCities(e)[0] || 'Sem cidade';
  }

  function ledgerCategory(e) {
    const fromEntry = String(e.category || '').trim();
    if (fromEntry && isTypeCategory(fromEntry)) return fromEntry;
    const p = state.products.find((x) => x.id === e.productId);
    const fromProduct = String((p && p.category) || '').trim();
    if (fromProduct && isTypeCategory(fromProduct)) return fromProduct;
    return inferTypeFromName((p && p.name) || e.productName) || 'Sem categoria';
  }

  function ledgerInCity(e, city) {
    if (!city) return true;
    const want = cashboxOf(city) || city;
    return ledgerCities(e).includes(want);
  }

  function ledgerInType(e, cat) {
    if (!cat) return true;
    return ledgerCategory(e) === cat;
  }

  function saleTotals(sales) {
    const revenue = sales.reduce((s, e) => s + (Number(e.price) || 0) * (e.qty || 0), 0);
    const known = sales.filter((e) => e.cost != null && e.cost !== '');
    const costSum = known.reduce((s, e) => s + (Number(e.cost) || 0) * (e.qty || 0), 0);
    const profit = known.reduce((s, e) => s + ((Number(e.price) || 0) - (Number(e.cost) || 0)) * (e.qty || 0), 0);
    const qty = sales.reduce((s, e) => s + (e.qty || 0), 0);
    return { revenue, costSum, profit, qty, missing: sales.length - known.length, known: known.length };
  }

  function renderProfit() {
    document.querySelectorAll('#profit-period .period-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.period === state.profitPeriod)
    );
    const start = periodStart(state.profitPeriod);
    const periodRows = (state.ledger || []).filter((e) => !start || new Date(e.createdAt) >= start);
    const rows = periodRows.filter((e) => ledgerInCity(e, state.profitCity) && ledgerInType(e, state.profitCat));
    const sales = rows.filter((e) => e.type === 'sale');
    const totals = saleTotals(sales);
    const filterHint = [state.profitCity ? cityLabel(state.profitCity) : '', state.profitCat]
      .filter(Boolean)
      .join(' · ');
    $('#profit-cards').innerHTML = `
      <div class="profit-card"><span>Faturamento${filterHint ? ` · ${esc(filterHint)}` : ''}</span><strong>${money(totals.revenue)}</strong></div>
      <div class="profit-card ok"><span>Lucro</span><strong>${money(totals.profit)}</strong></div>
      <div class="profit-card"><span>Vendas</span><strong>${totals.qty}</strong></div>
    `;
    const cityWrap = $('#profit-city-cards');
    if (cityWrap) {
      const cityRows = periodRows.filter((e) => ledgerInType(e, state.profitCat));
      cityWrap.innerHTML = cityNames()
        .map((city) => {
          const citySales = cityRows.filter((e) => e.type === 'sale' && ledgerPrimaryCity(e) === city);
          const t = saleTotals(citySales);
          const active = state.profitCity && (cashboxOf(state.profitCity) || state.profitCity) === city;
          return `<article class="profit-city-card${active ? ' is-filtered' : ''}">
            <span class="profit-card-kicker">Caixa</span>
            <h4>${esc(cityLabel(city))}</h4>
            <p>Faturamento <strong>${money(t.revenue)}</strong></p>
            <p>Lucro <strong>${money(t.profit)}</strong></p>
            <p>${t.qty} venda${t.qty === 1 ? '' : 's'}</p>
          </article>`;
        })
        .join('');
    }
    const catWrap = $('#profit-cat-cards');
    if (catWrap) {
      const catRows = periodRows.filter((e) => ledgerInCity(e, state.profitCity));
      const cats = typeNames();
      catWrap.innerHTML = cats
        .map((cat) => {
          const catSales = catRows.filter((e) => e.type === 'sale' && ledgerCategory(e) === cat);
          const t = saleTotals(catSales);
          const active = state.profitCat === cat;
          return `<article class="profit-city-card is-type${active ? ' is-filtered' : ''}">
            <span class="profit-card-kicker">Tipo</span>
            <h4>${esc(cat)}</h4>
            <p>Faturamento <strong>${money(t.revenue)}</strong></p>
            <p>Lucro <strong>${money(t.profit)}</strong></p>
            <p>${t.qty} venda${t.qty === 1 ? '' : 's'}</p>
          </article>`;
        })
        .join('');
    }
    const warn = totals.missing
      ? `<p class="hint">${totals.missing} venda${totals.missing === 1 ? '' : 's'} sem custo — o lucro dessas ficou de fora. Preencha o custo no Estoque.</p>`
      : totals.known
        ? `<p class="hint">Custo das vendas: ${money(totals.costSum)}</p>`
        : '';
    const pageInfo = pageSlice(rows, state.profitPage, state.pageSize);
    state.profitPage = pageInfo.page;
    const list = pageInfo.items.length
      ? pageInfo.items
          .map((e) => {
            const when = new Date(e.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const kind = e.type === 'sale' ? 'Venda' : e.type === 'in' ? 'Entrada' : 'Baixa';
            const val =
              e.type === 'sale' ? money((Number(e.price) || 0) * (e.qty || 0)) : `${e.type === 'in' ? '+' : '−'}${e.qty}`;
            const extra =
              e.type === 'sale'
                ? e.cost != null && e.cost !== ''
                  ? ` · lucro ${money(((Number(e.price) || 0) - (Number(e.cost) || 0)) * (e.qty || 0))}`
                  : ' · sem custo'
                : '';
            const city = ledgerPrimaryCity(e);
            const cat = ledgerCategory(e);
            return `
            <div class="profit-row">
              <div class="profit-row-name">${esc(e.productName)}</div>
              <div class="profit-row-value ${esc(e.type)}">${val}</div>
              <div class="profit-row-meta">${kind} · ${esc(cityLabel(city))} · <span class="type-chip">${esc(cat)}</span> · ${e.qty} un. · ${when}${extra}${e.userName ? ` · ${esc(e.userName)}` : ''}
                <button type="button" class="icon-btn danger undo-btn" data-undo="${esc(e.id)}" title="Desfazer">↩</button>
              </div>
            </div>`;
          })
          .join('')
      : '<p class="profit-empty">Nenhuma movimentação neste período. Use Vendi no Estoque.</p>';
    $('#profit-list').innerHTML = warn + list;
    $('#profit-list').querySelectorAll('[data-undo]').forEach((b) =>
      b.addEventListener('click', () => undoLedger(b.dataset.undo))
    );
    renderPager($('#profit-pager'), pageInfo, (p) => {
      state.profitPage = p;
      renderProfit();
    });
  }

  async function undoLedger(id) {
    const { ok } = await askConfirm({
      title: 'Desfazer movimentação',
      text: 'O estoque volta como estava antes. Confirmar?',
      okLabel: 'Desfazer',
    });
    if (!ok) return;
    try {
      await api(`/api/ledger/${id}`, { method: 'DELETE' });
      await loadAll();
      toast('Movimentação desfeita');
    } catch (err) {
      toast(err.message);
    }
  }

  /* ---------- product modal ---------- */
  function fillCityChecks(selected) {
    const chosen = new Set((selected || []).map(cashboxOf).filter(Boolean));
    $('#p-cities').innerHTML = cityNames()
      .map(
        (c) => `<label class="city-check"><input type="checkbox" value="${esc(c)}" ${chosen.has(c) || chosen.has(cityLabel(c)) ? 'checked' : ''} /> ${esc(cityCheckLabel(c))}</label>`
      )
      .join('');
  }

  function fillCategorySelect(selected) {
    const sel = $('#p-category');
    sel.innerHTML =
      '<option value="">Sem tipo</option>' +
      state.categories.map((c) => `<option value="${esc(c)}" ${selected === c ? 'selected' : ''}>${esc(c)}</option>`).join('') +
      '<option value="__new">➕ Criar novo tipo...</option>';
    $('#p-newcat-wrap').classList.add('hidden');
    $('#p-newcat').value = '';
  }
  $('#p-category').addEventListener('change', (e) => {
    $('#p-newcat-wrap').classList.toggle('hidden', e.target.value !== '__new');
  });

  function openProductModal(id) {
    state.editingId = id;
    const p = id ? state.products.find((x) => x.id === id) : null;
    $('#product-form-title').textContent = p ? 'Editar produto' : 'Anunciar produto';
    $('#product-delete').classList.toggle('hidden', !p);
    $('#p-name').value = p ? p.name : '';
    $('#p-price').value = p ? p.price : '';
    $('#p-promoPrice').value = p && p.promoPrice != null ? p.promoPrice : '';
    $('#p-cost').value = p && p.cost != null ? p.cost : '';
    $('#p-description').value = p ? p.description || '' : '';
    $('#p-optionGroup').value = p ? p.optionGroup || '' : '';
    $('#p-options').value = '';
    $('#p-active').checked = p ? p.active !== false : true;
    $('#p-pin').checked = p ? !!p.pin : false;
    $('#p-stock').value = p && p.stock != null ? p.stock : '';
    $('#p-stockActive').checked = p ? !!p.stockActive : true;
    $('#p-image-file').value = '';
    $('#p-image-hint').textContent = p && p.image ? 'manter foto atual' : 'nenhuma foto selecionada';

    // Sabores: textarea só ao criar; ao editar, gerenciador com fotos
    $('#p-options-wrap').classList.toggle('hidden', !!p);
    $('#p-options-manage').classList.toggle('hidden', !p);
    if (p) $('#p-flavor-count').textContent = (p.options || []).length;

    const prev = $('#p-image-preview');
    if (p && p.image) {
      delete prev.dataset.fallbackDone;
      prev.src = p.image;
      prev.style.visibility = 'visible';
    } else {
      prev.removeAttribute('src');
      prev.style.visibility = 'hidden';
    }
    fillCategorySelect(p ? p.category : '');
    fillCityChecks(p ? productCities(p) : []);
    $('#product-modal').classList.remove('hidden');
  }
  function closeProductModal() {
    $('#product-modal').classList.add('hidden');
    state.editingId = null;
  }
  $('#product-close').addEventListener('click', closeProductModal);

  $('#p-image-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const prev = $('#p-image-preview');
    delete prev.dataset.fallbackDone;
    prev.src = URL.createObjectURL(file);
    prev.style.visibility = 'visible';
    $('#p-image-hint').textContent = file.name;
  });

  $('#p-manage-flavors').addEventListener('click', () => {
    if (state.editingId) openFlavors(state.editingId);
  });

  $('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let category = $('#p-category').value;
    if (category === '__new') category = $('#p-newcat').value.trim();
    const cities = [...document.querySelectorAll('#p-cities input:checked')].map((i) => i.value);
    if (!cities.length) {
      toast('Escolha ao menos uma cidade.');
      return;
    }
    const editing = !!state.editingId;
    const fd = new FormData();
    fd.append('name', $('#p-name').value);
    fd.append('price', $('#p-price').value);
    fd.append('promoPrice', $('#p-promoPrice').value);
    fd.append('cost', $('#p-cost').value);
    fd.append('category', category);
    fd.append('cities', JSON.stringify(cities));
    fd.append('description', $('#p-description').value);
    fd.append('optionGroup', $('#p-optionGroup').value);
    // Ao editar, os sabores são gerenciados na tela própria (não sobrescreve fotos)
    if (!editing) {
      fd.append(
        'options',
        JSON.stringify(
          $('#p-options')
            .value.split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title }))
        )
      );
    }
    fd.append('stock', $('#p-stock').value);
    fd.append('stockActive', $('#p-stockActive').checked);
    fd.append('pin', $('#p-pin').checked);
    fd.append('active', $('#p-active').checked);
    const file = $('#p-image-file').files[0];
    if (file) fd.append('image', file);

    $('#product-save').disabled = true;
    try {
      const saved = editing
        ? await api(`/api/products/${state.editingId}`, { method: 'PUT', body: fd })
        : await api('/api/products', { method: 'POST', body: fd });
      closeProductModal();
      toast(editing ? 'Produto atualizado' : 'Produto anunciado');
      await loadAll();
      if (!editing && saved.product && (saved.product.options || []).length) openFlavors(saved.product.id);
    } catch (err) {
      toast(err.message);
    } finally {
      $('#product-save').disabled = false;
    }
  });

  async function deleteProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    const { ok } = await askConfirm({
      title: 'Tirar produto',
      text: `Tirar "${p.name}" da loja? As fotos dos sabores também são apagadas e não tem como voltar.`,
      okLabel: 'Tirar da loja',
    });
    if (!ok) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      toast('Produto retirado');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  }
  $('#product-delete').addEventListener('click', () => {
    const id = state.editingId;
    closeProductModal();
    if (id) deleteProduct(id);
  });

  /* ---------- sabores (opções) ---------- */
  function flavorProduct() {
    return state.products.find((p) => p.id === state.flavorProductId);
  }

  function openFlavors(productId) {
    const p = state.products.find((x) => x.id === productId);
    if (!p) return;
    state.flavorProductId = productId;
    $('#flavors-product').textContent = `${p.name}${p.optionGroup ? ` · ${p.optionGroup}` : ''}`;
    $('#flavor-new').value = '';
    $('#flavor-bulk-text').value = '';
    $('#flavor-bulk').classList.add('hidden');
    renderFlavors();
    $('#flavors-modal').classList.remove('hidden');
  }
  function closeFlavors() {
    $('#flavors-modal').classList.add('hidden');
    state.flavorProductId = null;
  }
  $('#flavors-close').addEventListener('click', closeFlavors);
  $('#flavors-done').addEventListener('click', closeFlavors);
  $('#flavor-bulk-toggle').addEventListener('click', () => $('#flavor-bulk').classList.toggle('hidden'));

  function renderFlavors() {
    const p = flavorProduct();
    if (!p) return;
    const opts = p.options || [];
    const noPhoto = opts.filter((o) => !o.image).length;
    $('#flavors-count').textContent = opts.length
      ? `${opts.length} sabor${opts.length === 1 ? '' : 'es'}${noPhoto ? ` · ${noPhoto} sem foto` : ' · todos com foto'}`
      : 'nenhum sabor ainda';
    $('#p-flavor-count').textContent = opts.length;

    $('#flavor-list').innerHTML =
      opts
        .map(
          (o, i) => `
      <div class="flavor-row ${o.available === false ? 'off' : ''}" data-id="${esc(o.id)}">
        <label class="flavor-thumb" title="Trocar foto deste sabor">
          ${o.image ? `<img class="img-hide-on-error" src="${esc(o.image)}" alt="" loading="lazy" />` : '<span class="flavor-thumb-empty">+ foto</span>'}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-act="img" />
        </label>
        <div class="flavor-main">
          <input class="flavor-title" value="${esc(o.title)}" maxlength="80" aria-label="Nome do sabor" />
          <div class="flavor-row-actions">
            <button type="button" class="status-toggle ${o.available === false ? 'off' : 'on'}" data-act="avail">${o.available === false ? 'Esgotado' : 'Disponível'}</button>
            ${o.image ? '<button type="button" class="btn-link" data-act="rmimg">tirar foto</button>' : ''}
            <span class="flavor-order">
              <button type="button" class="icon-btn" data-act="up" title="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="icon-btn" data-act="down" title="Descer" ${i === opts.length - 1 ? 'disabled' : ''}>↓</button>
            </span>
            <button type="button" class="icon-btn danger" data-act="del" title="Remover sabor">🗑</button>
          </div>
        </div>
      </div>`
        )
        .join('') || '<p class="profit-empty">Nenhum sabor cadastrado. Adicione acima.</p>';

    $('#flavor-list').querySelectorAll('.flavor-row').forEach((row) => {
      const id = row.dataset.id;
      const titleInput = row.querySelector('.flavor-title');
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleInput.blur();
        }
      });
      titleInput.addEventListener('change', () => renameFlavor(id, titleInput.value));
      row.querySelector('[data-act="img"]').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) uploadFlavorImage(id, file);
      });
      row.querySelectorAll('[data-act]').forEach((btn) => {
        const act = btn.dataset.act;
        if (act === 'img') return;
        btn.addEventListener('click', () => {
          if (act === 'avail') toggleFlavor(id);
          else if (act === 'del') deleteFlavor(id);
          else if (act === 'rmimg') removeFlavorImage(id);
          else if (act === 'up' || act === 'down') moveFlavor(id, act === 'up' ? -1 : 1);
        });
      });
    });
  }

  /** Atualiza o produto em memória com a resposta do servidor. */
  function applyFlavors(data) {
    const p = flavorProduct();
    if (!p) return;
    p.options = data.options || [];
    if (data.optionGroup !== undefined) p.optionGroup = data.optionGroup;
    renderFlavors();
    renderProducts();
  }

  async function addFlavors(titles) {
    const p = flavorProduct();
    if (!p || !titles.length) return;
    try {
      const data = await api(`/api/products/${p.id}/options`, { json: { titles } });
      applyFlavors(data);
      toast(`${(data.created || []).length} sabor(es) adicionado(s)`);
    } catch (err) {
      toast(err.message);
    }
  }
  $('#flavor-add-btn').addEventListener('click', async () => {
    const value = $('#flavor-new').value.trim();
    if (!value) return;
    await addFlavors([value]);
    $('#flavor-new').value = '';
    $('#flavor-new').focus();
  });
  $('#flavor-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#flavor-add-btn').click();
    }
  });
  $('#flavor-bulk-btn').addEventListener('click', async () => {
    const titles = $('#flavor-bulk-text')
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!titles.length) return;
    await addFlavors(titles);
    $('#flavor-bulk-text').value = '';
  });

  async function renameFlavor(optId, title) {
    const p = flavorProduct();
    const opt = (p.options || []).find((o) => o.id === optId);
    if (!opt || opt.title === title.trim() || !title.trim()) return renderFlavors();
    try {
      const data = await api(`/api/products/${p.id}/options/${optId}`, { method: 'PATCH', json: { title } });
      applyFlavors(data);
      toast('Sabor renomeado');
    } catch (err) {
      toast(err.message);
      renderFlavors();
    }
  }

  async function toggleFlavor(optId) {
    const p = flavorProduct();
    const opt = (p.options || []).find((o) => o.id === optId);
    if (!opt) return;
    try {
      const data = await api(`/api/products/${p.id}/options/${optId}`, {
        method: 'PATCH',
        json: { available: opt.available === false },
      });
      applyFlavors(data);
    } catch (err) {
      toast(err.message);
    }
  }

  async function deleteFlavor(optId) {
    const p = flavorProduct();
    const opt = (p.options || []).find((o) => o.id === optId);
    if (!opt) return;
    const { ok } = await askConfirm({
      title: 'Remover sabor',
      text: `Remover "${opt.title}" de ${p.name}? A foto dele também sai.`,
      okLabel: 'Remover',
    });
    if (!ok) return;
    try {
      const data = await api(`/api/products/${p.id}/options/${optId}`, { method: 'DELETE' });
      applyFlavors(data);
      toast('Sabor removido');
    } catch (err) {
      toast(err.message);
    }
  }

  async function moveFlavor(optId, delta) {
    const p = flavorProduct();
    const ids = (p.options || []).map((o) => o.id);
    const from = ids.indexOf(optId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try {
      const data = await api(`/api/products/${p.id}/options/order`, { method: 'PUT', json: { ids } });
      applyFlavors(data);
    } catch (err) {
      toast(err.message);
    }
  }

  async function uploadFlavorImage(optId, file) {
    const p = flavorProduct();
    const fd = new FormData();
    fd.append('image', file);
    toast('Enviando foto...');
    try {
      const data = await api(`/api/products/${p.id}/options/${optId}/image`, { method: 'POST', body: fd });
      applyFlavors(data);
      toast('Foto do sabor atualizada');
    } catch (err) {
      toast(err.message);
    }
  }

  async function removeFlavorImage(optId) {
    const p = flavorProduct();
    try {
      const data = await api(`/api/products/${p.id}/options/${optId}/image`, { method: 'DELETE' });
      applyFlavors(data);
      toast('Foto removida');
    } catch (err) {
      toast(err.message);
    }
  }

  /* ---------- categories ---------- */
  async function saveCategories(categories) {
    await api('/api/settings', { method: 'PUT', json: { categories } });
  }
  function renderCategories() {
    $('#categories-list').innerHTML =
      state.categories
        .map((c) => {
          const count = state.products.filter((p) => p.category === c).length;
          return `
        <div class="cat-row">
          <span class="cat-name">${esc(c)}</span>
          <span class="cat-count">${count} ${count === 1 ? 'produto' : 'produtos'}</span>
          <button class="icon-btn danger" data-cat="${esc(c)}" title="Excluir">🗑</button>
        </div>`;
        })
        .join('') || '<p class="hint">Nenhuma categoria ainda.</p>';
    $('#categories-list').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', async () => {
        const { ok } = await askConfirm({
          title: 'Excluir categoria',
          text: `Excluir "${b.dataset.cat}"? Os produtos dela ficam sem filtro na loja.`,
          okLabel: 'Excluir',
        });
        if (!ok) return;
        try {
          await saveCategories(state.categories.filter((c) => c !== b.dataset.cat));
          toast('Categoria excluída');
          await loadAll();
        } catch (err) {
          toast(err.message);
        }
      })
    );
  }
  $('#add-category-btn').addEventListener('click', async () => {
    const name = $('#new-category').value.trim();
    if (!name) return;
    if (state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) return toast('Essa categoria já existe.');
    try {
      await saveCategories([...state.categories, name]);
      $('#new-category').value = '';
      toast('Categoria adicionada');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------- settings ---------- */
  function renderSettings() {
    const s = state.settings;
    $('#s-name').value = s.name || '';
    $('#s-tagline').value = s.tagline || '';
    $('#s-extra').value = s.extra || '';
    $('#s-whatsapp').value = s.whatsapp || '';
    $('#s-address').value = s.address || '';
    $('#s-checkoutMessage').value = s.checkoutMessage || '';
    $('#s-payments').value = (s.payments || []).join('\n');
    const prev = $('#s-banner-preview');
    if (s.banner) {
      delete prev.dataset.fallbackDone;
      prev.src = s.banner;
      prev.style.display = '';
      prev.style.visibility = 'visible';
    } else prev.style.display = 'none';
    renderShippingRows();
  }

  function shippingRowHtml(sh, index) {
    const n = (index ?? 0) + 1;
    return `
      <div class="ship-card-head">
        <strong>Entrega ${n}</strong>
        <button type="button" class="icon-btn danger ship-remove" title="Remover">🗑</button>
      </div>
      <div class="ship-card-grid">
        <label>Caixa / região
          <input class="ship-name" value="${esc(sh.name || '')}" maxlength="60" placeholder="Ex.: Itajaí" />
        </label>
        <label>Frete (R$)
          <input class="ship-price" type="number" step="0.01" min="0" inputmode="decimal" value="${sh.price ?? ''}" placeholder="0" />
        </label>
        <label>Como aparece no checkout
          <input class="ship-desc" value="${esc(sh.description || '')}" maxlength="160" placeholder="Ex.: Motoboy — entrega rápida" />
        </label>
      </div>`;
  }
  function wireShippingCard(card) {
    card.querySelector('.ship-remove')?.addEventListener('click', () => {
      card.remove();
      renumberShippingCards();
    });
  }
  function renumberShippingCards() {
    [...document.querySelectorAll('#shipping-list .ship-card')].forEach((card, i) => {
      const title = card.querySelector('.ship-card-head strong');
      if (title) title.textContent = `Entrega ${i + 1}`;
    });
  }
  function renderShippingRows() {
    const list = state.settings.shipping || [];
    $('#shipping-list').innerHTML = list
      .map((sh, i) => `<div class="ship-card">${shippingRowHtml(sh, i)}</div>`)
      .join('');
    $('#shipping-list').querySelectorAll('.ship-card').forEach(wireShippingCard);
  }
  $('#add-shipping-btn').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'ship-card';
    const n = document.querySelectorAll('#shipping-list .ship-card').length;
    div.innerHTML = shippingRowHtml({}, n);
    wireShippingCard(div);
    $('#shipping-list').appendChild(div);
  });

  $('#s-banner-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    try {
      const data = await api('/api/settings/banner', { method: 'POST', body: fd });
      const prev = $('#s-banner-preview');
      delete prev.dataset.fallbackDone;
      prev.src = data.banner;
      prev.style.display = '';
      prev.style.visibility = 'visible';
      toast('Banner atualizado');
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.value = '';
    }
  });

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const shipping = [...document.querySelectorAll('#shipping-list .ship-card')]
      .map((row) => ({
        name: row.querySelector('.ship-name').value,
        price: row.querySelector('.ship-price').value,
        description: row.querySelector('.ship-desc').value,
      }))
      .filter((s) => s.name.trim());
    try {
      await api('/api/settings', {
        method: 'PUT',
        json: {
          name: $('#s-name').value,
          tagline: $('#s-tagline').value,
          extra: $('#s-extra').value,
          whatsapp: $('#s-whatsapp').value.replace(/\D/g, ''),
          address: $('#s-address').value,
          checkoutMessage: $('#s-checkoutMessage').value,
          payments: $('#s-payments').value.split('\n').map((x) => x.trim()).filter(Boolean),
          shipping,
        },
      });
      toast('Loja atualizada');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------- promoções ---------- */
  const PROMO_ACTIONS = [
    ['catalogo', 'Rolar até o catálogo'],
    ['categoria', 'Abrir uma categoria'],
    ['produto', 'Abrir um produto'],
    ['whatsapp', 'Abrir o WhatsApp'],
  ];

  /** Preenche o seletor de destino conforme a ação escolhida. */
  function fillTargetSelect(select, action, current) {
    if (action === 'categoria') {
      select.innerHTML = state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    } else if (action === 'produto') {
      select.innerHTML = state.products
        .filter((p) => p.active)
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
        .join('');
    } else {
      select.innerHTML = '';
    }
    if (current) select.value = current;
    return action === 'categoria' || action === 'produto';
  }

  function syncPromoBarTarget() {
    const action = $('#pb-action').value;
    const needs = fillTargetSelect($('#pb-value'), action, state.settings.promoBar && state.settings.promoBar.value);
    $('#pb-value-wrap').classList.toggle('hidden', !needs);
    $('#pb-value-label').textContent = action === 'produto' ? 'Produto' : 'Categoria';
  }
  $('#pb-action').addEventListener('change', syncPromoBarTarget);

  function renderPromoBar() {
    const bar = state.settings.promoBar || {};
    $('#pb-active').checked = !!bar.active;
    $('#pb-text').value = bar.text || '';
    $('#pb-ctaLabel').value = bar.ctaLabel || '';
    $('#pb-action').value = bar.action || 'catalogo';
    syncPromoBarTarget();
  }

  $('#promobar-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'PUT',
        json: {
          promoBar: {
            active: $('#pb-active').checked,
            text: $('#pb-text').value,
            ctaLabel: $('#pb-ctaLabel').value,
            action: $('#pb-action').value,
            value: $('#pb-value').value,
          },
        },
      });
      toast('Faixa de promoção salva');
      await loadAll();
      switchTab('promos');
    } catch (err) {
      toast(err.message);
    }
  });

  function promoRowHtml(p, i) {
    const actionOpts = PROMO_ACTIONS.map(
      ([v, label]) => `<option value="${v}" ${(p.action || 'catalogo') === v ? 'selected' : ''}>${label}</option>`
    ).join('');
    return `
      <div class="promo-admin" data-id="${esc(p.id || '')}">
        <div class="promo-admin-head">
          <strong>Promoção ${i + 1}</strong>
          <label class="switch"><input type="checkbox" class="pr-active" ${p.active === false ? '' : 'checked'} /><span></span>Ativa</label>
          <button type="button" class="icon-btn danger" data-act="del" title="Remover">🗑</button>
        </div>
        <div class="promo-admin-grid">
          <div class="promo-admin-img">
            <img class="img-hide-on-error" src="${esc(p.image || '')}" alt="" />
            <label class="btn btn-ghost btn-sm">${p.image ? 'Trocar foto' : 'Escolher foto'}
              <input type="file" class="pr-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden ${p.id ? '' : 'disabled'} />
            </label>
            ${p.image ? '<button type="button" class="btn-link" data-act="img-del">Remover foto</button>' : ''}
            ${p.id ? '' : '<small class="hint">Salve para liberar a foto</small>'}
          </div>
          <div class="promo-admin-fields">
            <div class="grid-2">
              <label>Selo (opcional)<input class="pr-badge" maxlength="24" value="${esc(p.badge || '')}" placeholder="Ex.: -20% HOJE" /></label>
              <label>Texto do botão<input class="pr-ctaLabel" maxlength="30" value="${esc(p.ctaLabel || '')}" placeholder="Ex.: Aproveitar" /></label>
            </div>
            <label>Título *<input class="pr-title" maxlength="70" value="${esc(p.title || '')}" placeholder="Ex.: Leve 3 pods e pague 2" /></label>
            <label>Explicação<input class="pr-subtitle" maxlength="160" value="${esc(p.subtitle || '')}" placeholder="Ex.: Válido até domingo, só para Itajaí" /></label>
            <div class="grid-2">
              <label>Para onde o botão leva<select class="pr-action">${actionOpts}</select></label>
              <label class="pr-value-wrap hidden">Destino<select class="pr-value"></select></label>
            </div>
          </div>
        </div>
      </div>`;
  }

  function wirePromoRow(row) {
    const actionSel = row.querySelector('.pr-action');
    const valueSel = row.querySelector('.pr-value');
    const valueWrap = row.querySelector('.pr-value-wrap');
    const saved = row.dataset.value || '';
    const sync = () => {
      const needs = fillTargetSelect(valueSel, actionSel.value, saved);
      valueWrap.classList.toggle('hidden', !needs);
    };
    actionSel.addEventListener('change', sync);
    sync();

    const del = row.querySelector('[data-act="del"]');
    if (del) {
      del.addEventListener('click', async () => {
        const { ok } = await askConfirm({ title: 'Remover promoção', text: 'Essa promoção sai da loja.', okLabel: 'Remover' });
        if (!ok) return;
        row.remove();
        savePromos();
      });
    }
    const imgDel = row.querySelector('[data-act="img-del"]');
    if (imgDel) {
      imgDel.addEventListener('click', async () => {
        try {
          const data = await api(`/api/settings/promos/${row.dataset.id}/image`, { method: 'DELETE' });
          state.settings.promos = data.promos;
          toast('Foto removida');
          renderPromoAdmin();
        } catch (err) {
          toast(err.message);
        }
      });
    }
    const file = row.querySelector('.pr-file');
    file.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('image', f);
      try {
        const data = await api(`/api/settings/promos/${row.dataset.id}/image`, { method: 'POST', body: fd });
        state.settings.promos = data.promos;
        toast('Foto da promoção enviada');
        renderPromoAdmin();
      } catch (err) {
        toast(err.message);
      } finally {
        e.target.value = '';
      }
    });
  }

  function renderPromoAdmin() {
    renderPromoBar();
    const list = state.settings.promos || [];
    const wrap = $('#promo-list');
    wrap.innerHTML = list.length
      ? list.map((p, i) => promoRowHtml(p, i)).join('')
      : '<p class="hint">Nenhuma promoção ainda. Toque em <b>+ Nova promoção</b>.</p>';
    wrap.querySelectorAll('.promo-admin').forEach((row, i) => {
      row.dataset.value = (list[i] && list[i].value) || '';
      wirePromoRow(row);
      row.querySelectorAll('input, select').forEach((el) =>
        el.addEventListener('change', () => {
          clearTimeout(promoSaveTimer);
          promoSaveTimer = setTimeout(savePromos, 400);
        })
      );
    });
  }

  let promoSaveTimer;
  function collectPromos() {
    return [...document.querySelectorAll('#promo-list .promo-admin')]
      .map((row) => ({
        id: row.dataset.id || '',
        badge: row.querySelector('.pr-badge').value,
        title: row.querySelector('.pr-title').value,
        subtitle: row.querySelector('.pr-subtitle').value,
        ctaLabel: row.querySelector('.pr-ctaLabel').value,
        action: row.querySelector('.pr-action').value,
        value: row.querySelector('.pr-value').value,
        active: row.querySelector('.pr-active').checked,
      }))
      .filter((p) => p.title.trim());
  }

  async function savePromos() {
    try {
      const data = await api('/api/settings', { method: 'PUT', json: { promos: collectPromos() } });
      state.settings = data.settings || state.settings;
      renderPromoAdmin();
      toast('Promoções salvas');
    } catch (err) {
      toast(err.message);
    }
  }

  $('#promo-add').addEventListener('click', () => {
    const list = state.settings.promos || [];
    if (list.length >= 6) return toast('Seis promoções já é bastante. Remova uma antes.');
    const wrap = $('#promo-list');
    if (!list.length) wrap.innerHTML = '';
    const div = document.createElement('div');
    div.innerHTML = promoRowHtml({ active: true, ctaLabel: 'Ver ofertas' }, wrap.querySelectorAll('.promo-admin').length);
    const row = div.firstElementChild;
    wrap.appendChild(row);
    wirePromoRow(row);
    row.querySelector('.pr-title').focus();
    row.querySelectorAll('input, select').forEach((el) =>
      el.addEventListener('change', () => {
        clearTimeout(promoSaveTimer);
        promoSaveTimer = setTimeout(savePromos, 400);
      })
    );
  });

  /* ---------- cupons ---------- */
  const COUPON_TYPES = [
    { id: 'percent', label: 'Porcentagem (%)' },
    { id: 'free_shipping', label: 'Frete grátis' },
    { id: 'gift', label: 'Brinde (jujuba)' },
  ];

  function couponRowHtml(c, idx) {
    const type = c.type || 'percent';
    return `
      <div class="coupon-admin" data-id="${esc(c.id || '')}">
        <div class="coupon-admin-head">
          <strong>Cupom ${idx + 1}</strong>
          <label class="check-row"><input type="checkbox" class="cp-active" ${c.active !== false ? 'checked' : ''} /> Ativo</label>
          <button type="button" class="icon-btn danger cp-remove" title="Remover">🗑</button>
        </div>
        <div class="grid-2">
          <label>Código<input class="cp-code" value="${esc(c.code || '')}" maxlength="30" placeholder="PROMO10" autocapitalize="characters" /></label>
          <label>Tipo<select class="cp-type">${COUPON_TYPES.map((t) => `<option value="${t.id}" ${type === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        </div>
        <div class="grid-3 cp-fields-percent ${type === 'percent' ? '' : 'hidden'}">
          <label>Desconto (%)<input class="cp-value" type="number" min="0" max="100" step="1" value="${c.value ?? 10}" /></label>
        </div>
        <div class="grid-2 cp-fields-gift ${type === 'gift' ? '' : 'hidden'}">
          <label>Nome do brinde<input class="cp-gift-label" value="${esc(c.giftLabel || 'Jujuba de brinde')}" maxlength="80" /></label>
          <label>Produto (opcional)<select class="cp-gift-product"><option value="">— Só texto no pedido —</option>${state.products.map((p) => `<option value="${esc(p.id)}" ${c.giftProductId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        </div>
        <div class="grid-3">
          <label>Pedido mínimo (R$)<input class="cp-min" type="number" min="0" step="0.01" value="${c.minOrder ?? 0}" /></label>
          <label>Limite de usos<input class="cp-max" type="number" min="0" step="1" value="${c.maxUses ?? ''}" placeholder="Ilimitado" /></label>
          <label>Validade<input class="cp-expires" type="date" value="${c.expiresAt ? String(c.expiresAt).slice(0, 10) : ''}" /></label>
        </div>
        <p class="hint cp-usage">${c.usedCount ? `Usado ${c.usedCount} vez(es)` : 'Ainda não usado'}</p>
      </div>`;
  }

  function syncCouponTypeFields(row) {
    const type = row.querySelector('.cp-type').value;
    row.querySelector('.cp-fields-percent').classList.toggle('hidden', type !== 'percent');
    row.querySelector('.cp-fields-gift').classList.toggle('hidden', type !== 'gift');
  }

  function collectCoupons() {
    return [...document.querySelectorAll('#coupon-list .coupon-admin')]
      .map((row) => {
        const type = row.querySelector('.cp-type').value;
        return {
          id: row.dataset.id || undefined,
          code: row.querySelector('.cp-code').value.trim(),
          type,
          value: type === 'percent' ? Number(row.querySelector('.cp-value').value) : null,
          giftLabel: type === 'gift' ? row.querySelector('.cp-gift-label').value.trim() : '',
          giftProductId: type === 'gift' ? row.querySelector('.cp-gift-product').value : '',
          minOrder: Number(row.querySelector('.cp-min').value) || 0,
          maxUses: row.querySelector('.cp-max').value === '' ? null : Number(row.querySelector('.cp-max').value),
          expiresAt: row.querySelector('.cp-expires').value || null,
          active: row.querySelector('.cp-active').checked,
        };
      })
      .filter((c) => c.code);
  }

  function wireCouponRow(row) {
    row.querySelector('.cp-type').addEventListener('change', () => syncCouponTypeFields(row));
    row.querySelector('.cp-remove').addEventListener('click', () => {
      row.remove();
      saveCoupons();
    });
    row.querySelectorAll('input, select').forEach((el) =>
      el.addEventListener('change', () => {
        clearTimeout(couponSaveTimer);
        couponSaveTimer = setTimeout(saveCoupons, 500);
      })
    );
  }

  let couponSaveTimer;
  async function saveCoupons() {
    try {
      const data = await api('/api/settings', { method: 'PUT', json: { coupons: collectCoupons() } });
      state.settings = data.settings || state.settings;
      renderCouponAdmin();
      toast('Cupons salvos');
    } catch (err) {
      toast(err.message);
    }
  }

  function renderReferralForm() {
    const ref = state.settings.referral || {};
    $('#ref-enabled').checked = ref.enabled !== false;
    $('#ref-referrer').value = ref.referrerBonus ?? 10;
    $('#ref-referred').value = ref.referredBonus ?? 5;
    $('#ref-order-pct').value = ref.orderCashbackPercent ?? 2;
    const count = (state.customers || []).length;
    $('#customers-count').textContent = count ? `(${count})` : '';
    $('#customers-list').innerHTML = (state.customers || []).slice(0, 50).map((c) => `
      <div class="cat-row">
        <span class="cat-name">${esc(c.name)} <small class="user-tag">${esc(c.phone)}</small></span>
        <span class="cat-count">${money(c.cashbackBalance)} · ${esc(c.referralCode)}</span>
      </div>`).join('') || '<p class="hint">Nenhum cliente cadastrado ainda.</p>';
  }

  function renderCouponAdmin() {
    const list = state.settings.coupons || [];
    const wrap = $('#coupon-list');
    wrap.innerHTML = list.length ? list.map((c, i) => couponRowHtml(c, i)).join('') : '<p class="hint">Nenhum cupom. Clique em + Novo cupom.</p>';
    wrap.querySelectorAll('.coupon-admin').forEach(wireCouponRow);
    renderReferralForm();
  }

  $('#coupon-add').addEventListener('click', () => {
    const wrap = $('#coupon-list');
    if (wrap.querySelector('.hint') && !wrap.querySelector('.coupon-admin')) wrap.innerHTML = '';
    const div = document.createElement('div');
    div.innerHTML = couponRowHtml({ type: 'percent', value: 10, active: true, minOrder: 0 }, wrap.querySelectorAll('.coupon-admin').length);
    const row = div.firstElementChild;
    wrap.appendChild(row);
    wireCouponRow(row);
    row.querySelector('.cp-code').focus();
  });

  $('#referral-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/settings', {
        method: 'PUT',
        json: {
          referral: {
            enabled: $('#ref-enabled').checked,
            referrerBonus: Number($('#ref-referrer').value) || 0,
            referredBonus: Number($('#ref-referred').value) || 0,
            orderCashbackPercent: Number($('#ref-order-pct').value) || 0,
          },
        },
      });
      state.settings = data.settings || state.settings;
      toast('Cashback salvo');
      renderReferralForm();
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------- users ---------- */
  function renderUsers() {
    const pageInfo = pageSlice(state.users || [], state.usersPage || 1, state.pageSize);
    state.usersPage = pageInfo.page;
    $('#users-list').innerHTML = pageInfo.items
      .map(
        (u) => `
      <div class="cat-row">
        <span class="cat-name">${esc(u.name)} <small class="user-tag">@${esc(u.username)}</small>${
          u.mustChangePassword ? '<small class="user-warn">senha pendente</small>' : ''
        }${
          u.twoFactor
            ? `<small class="user-2fa">2FA ativo · ${u.recoveryLeft} código(s)</small>`
            : '<small class="user-warn">2FA pendente</small>'
        }${
          u.notifyPushOrders ? '<small class="user-2fa">push pedidos</small>' : ''
        }${
          u.pushEnabled ? '<small class="user-2fa">aparelho ativo</small>' : ''
        }</span>
        <span class="cat-count">${u.role === 'admin' ? 'Administrador' : 'Editor'}</span>
        ${
          u.id !== state.user.id
            ? `<button class="icon-btn" data-act="reset" data-id="${esc(u.id)}" title="Redefinir senha">🔑</button>
               ${u.twoFactor ? `<button class="icon-btn" data-act="reset2fa" data-id="${esc(u.id)}" title="Zerar 2FA">📵</button>` : ''}
               <button class="icon-btn danger" data-act="del" data-id="${esc(u.id)}" title="Excluir">🗑</button>`
            : '<span class="cat-count">você</span>'
        }
      </div>`
      )
      .join('');
    $('#users-list').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.act === 'del') removeUser(b.dataset.id);
        else if (b.dataset.act === 'reset2fa') resetUserTwoFactor(b.dataset.id);
        else resetUserPassword(b.dataset.id);
      })
    );
    renderPager($('#users-pager'), pageInfo, (p) => {
      state.usersPage = p;
      renderUsers();
    });
  }

  async function removeUser(id) {
    const u = state.users.find((x) => x.id === id);
    const { ok } = await askConfirm({
      title: 'Excluir acesso',
      text: `Excluir o acesso de ${u ? u.name : 'usuário'}? Ele perde o painel na hora.`,
      okLabel: 'Excluir',
    });
    if (!ok) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast('Acesso excluído');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  }

  async function resetUserPassword(id) {
    const u = state.users.find((x) => x.id === id);
    const { ok, password } = await askConfirm({
      title: 'Redefinir senha',
      text: `Defina a senha provisória de ${u ? u.name : 'usuário'} (mínimo 8). Essa pessoa terá que trocar no próximo login.`,
      password: true,
      passLabel: 'Senha provisória',
      danger: false,
      okLabel: 'Redefinir',
    });
    if (!ok || !password) return;
    try {
      await api(`/api/users/${id}/password`, { method: 'PUT', json: { password } });
      toast('Senha redefinida. Avise a pessoa.');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  }

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/users', {
        json: {
          name: $('#u-name').value,
          username: $('#u-username').value,
          password: $('#u-password').value,
          role: $('#u-role').value,
          notifyPushOrders: !!$('#u-notify-push')?.checked,
        },
      });
      $('#u-name').value = '';
      $('#u-username').value = '';
      $('#u-password').value = '';
      if ($('#u-notify-push')) $('#u-notify-push').checked = true;
      toast('Acesso criado');
      await loadAll();
    } catch (err) {
      toast(err.message);
    }
  });

  async function changeOwnPassword(currentSel, nextSel) {
    const currentPassword = $(currentSel).value;
    const password = $(nextSel).value;
    if (!currentPassword) return toast('Digite sua senha atual.');
    if (password.length < 8) return toast('A nova senha precisa de ao menos 8 caracteres.');
    try {
      await api('/api/users/me/password', { method: 'PUT', json: { currentPassword, password } });
      $(currentSel).value = '';
      $(nextSel).value = '';
      toast('Senha alterada');
    } catch (err) {
      toast(err.message);
    }
  }
  $('#editor-password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    changeOwnPassword('#epw-current', '#epw-next');
  });

  /* ---------- logs ---------- */
  function logQuery() {
    const params = new URLSearchParams();
    const q = $('#log-search').value.trim();
    if (q) params.set('q', q);
    if ($('#log-action').value) params.set('action', $('#log-action').value);
    if ($('#log-actor').value) params.set('actor', $('#log-actor').value);
    if ($('#log-severity').value) params.set('severity', $('#log-severity').value);
    if ($('#log-from').value) params.set('from', $('#log-from').value);
    if ($('#log-to').value) params.set('to', $('#log-to').value);
    return params;
  }

  async function loadLogs(reset) {
    if (state.user.role !== 'admin' || state.logLoading) return;
    state.logLoading = true;
    if (reset) state.logLimit = 100;
    const params = logQuery();
    params.set('limit', String(state.logLimit));
    try {
      const data = await api(`/api/audit?${params.toString()}`);
      state.logs = data.entries || [];
      state.logMeta = data;
      renderLogs();
    } catch (err) {
      toast(err.message);
    } finally {
      state.logLoading = false;
    }
  }

  function fillLogSelects(meta) {
    const actionSel = $('#log-action');
    if (actionSel.dataset.filled !== String((meta.actions || []).length)) {
      const current = actionSel.value;
      actionSel.innerHTML =
        '<option value="">Todas as ações</option>' +
        (meta.actions || []).map((a) => `<option value="${esc(a.action)}">${esc(a.label)}</option>`).join('');
      actionSel.value = current;
      actionSel.dataset.filled = String((meta.actions || []).length);
    }
    const actorSel = $('#log-actor');
    if (actorSel.dataset.filled !== String((meta.actors || []).length)) {
      const current = actorSel.value;
      actorSel.innerHTML =
        '<option value="">Todos os usuários</option>' +
        (meta.actors || []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      actorSel.value = current;
      actorSel.dataset.filled = String((meta.actors || []).length);
    }
  }

  function fmtValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'sim' : 'não';
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v);
  }

  function renderLogs() {
    const meta = state.logMeta || {};
    const stats = meta.stats || {};
    fillLogSelects(meta);
    $('#log-stats').innerHTML = `
      <div class="profit-card"><span>Registros guardados</span><strong>${stats.stored || 0}</strong></div>
      <div class="profit-card"><span>Ações nas últimas 24h</span><strong>${stats.last24h || 0}</strong></div>
      <div class="profit-card ${stats.alerts24h ? 'bad' : 'ok'}"><span>Alertas em 24h</span><strong>${stats.alerts24h || 0}</strong></div>
      <div class="profit-card"><span>Logins / falhas (24h)</span><strong>${stats.logins24h || 0} / ${stats.failed24h || 0}</strong></div>`;

    $('#log-total').textContent = `${meta.total || 0} registro(s) no filtro · mostrando ${state.logs.length}`;
    $('#log-more').classList.toggle('hidden', (meta.total || 0) <= state.logs.length);

    $('#log-list').innerHTML =
      state.logs
        .map((e) => {
          const when = new Date(e.at).toLocaleString('pt-BR');
          const target = e.targetName ? ` · ${esc(e.targetName)}` : '';
          const changes = (e.changes || [])
            .map((c) => `<li><b>${esc(c.field)}</b>: ${esc(fmtValue(c.from))} → ${esc(fmtValue(c.to))}</li>`)
            .join('');
          return `
        <article class="log-row ${e.severity === 'alert' ? 'alert' : ''}">
          <div class="log-row-head">
            <strong>${esc(e.label || e.action)}</strong>
            <span class="log-when">${esc(when)}</span>
          </div>
          <div class="log-row-body">${esc(e.actorName || 'não identificado')}${
            e.actorRole && e.actorRole !== 'guest' ? ` (${esc(e.actorRole)})` : ''
          }${target}</div>
          ${e.detail ? `<div class="log-row-detail">${esc(e.detail)}</div>` : ''}
          ${changes ? `<ul class="log-changes">${changes}</ul>` : ''}
          <div class="log-row-meta">${esc(e.ip || '—')} · ${esc(e.method || '')} ${esc(e.route || '')}</div>
        </article>`;
        })
        .join('') || '<p class="profit-empty">Nenhum registro com esses filtros.</p>';
  }

  let logSearchTimer;
  $('#log-search').addEventListener('input', () => {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => loadLogs(true), 300);
  });
  ['#log-action', '#log-actor', '#log-severity', '#log-from', '#log-to'].forEach((sel) =>
    $(sel).addEventListener('change', () => loadLogs(true))
  );
  $('#log-refresh').addEventListener('click', () => loadLogs(true));
  $('#log-more').addEventListener('click', () => {
    state.logLimit = Math.min(500, state.logLimit + 200);
    loadLogs(false);
  });
  $('#log-export').addEventListener('click', () => {
    const params = logQuery();
    window.location.href = `/api/audit/export.csv?${params.toString()}`;
  });
  $('#log-clear').addEventListener('click', async () => {
    const { ok, password } = await askConfirm({
      title: 'Apagar logs',
      text: 'Os registros atuais vão para a pasta backups/ do servidor e a lista começa de novo. Confirme com sua senha.',
      password: true,
      okLabel: 'Apagar',
    });
    if (!ok) return;
    try {
      const data = await api('/api/audit', { method: 'DELETE', json: { password } });
      toast(`${data.archived} registro(s) arquivado(s)`);
      loadLogs(true);
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------- teclado ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#confirm-modal').classList.contains('hidden')) return closeConfirm({ ok: false });
    if (!$('#notify-guide-modal')?.classList.contains('hidden')) return closeNotifyGuide(false);
    if (!$('#order-modal')?.classList.contains('hidden')) return closeOrderModal();
    if (!$('#flavors-modal').classList.contains('hidden')) return closeFlavors();
    if (!$('#product-modal').classList.contains('hidden')) return closeProductModal();
  });

  /* ---------- init ---------- */
  (async () => {
    await fetchCsrf();
    try {
      const data = await api('/api/me');
      state.user = data.user;
      state.csrf = data.csrf || state.csrf;
      if (data.mustChangePassword) showPasswordGate();
      else showPanel();
    } catch {
      // api() já mandou para a tela certa (login, código ou 2FA)
    }
  })();
})();
