/* GOLD SKULL — vitrine */
(() => {
  const RETAIL_SKIP = 'Atacado';
  const DEFAULT_CATEGORY = 'all';
  const SESSION_LOCATION_KEY = 'gs_location_session';
  const CASHBOXES = [
    { id: 'Itajaí', title: 'Itajaí e região', hint: 'Entrega de motoboy', confirm: 'Confirmo que estou em Itajaí e região' },
    { id: 'Joinville', title: 'Joinville e região', hint: 'Entrega de motoboy', confirm: 'Confirmo que estou em Joinville e região' },
    { id: 'Atacado', title: 'Brasil', hint: '', confirm: 'Confirmo envio para o Brasil' },
  ];

  const state = {
    store: {},
    promos: [],
    promoBar: null,
    coupons: [],
    referral: { enabled: true, referrerBonus: 10, referredBonus: 5, orderCashbackPercent: 2 },
    categories: [],
    products: [],
    activeCategory: DEFAULT_CATEGORY,
    catalogFilter: 'all',
    catalogSort: 'default',
    search: '',
    cart: loadCart(),
    modalProduct: null,
    modalQty: 1,
    shipId: '0',
    pay: '',
    checkoutStep: 1,
    cityConfirmed: false,
    locationReady: false,
    customer: null,
    appliedCoupon: null,
    useCashback: false,
    csrf: '',
    authEntry: false,
    changingLocation: false,
  };

  const $ = (sel) => document.querySelector(sel);

  /* GitHub Pages fica em /nome-do-repo/; o servidor local continua na raiz. */
  const IS_PAGES = /\.github\.io$/i.test(location.hostname);
  const PAGES_BASE = IS_PAGES
    ? `/${location.pathname.split('/').filter(Boolean)[0] || ''}`
    : '';

  function asset(url) {
    if (!url) return '';
    if (/^(https?:|data:|blob:)/i.test(url)) return url;
    if (!PAGES_BASE) return url;
    if (url === PAGES_BASE || url.startsWith(`${PAGES_BASE}/`)) return url;
    if (url.startsWith('/')) return PAGES_BASE + url;
    return `${PAGES_BASE}/${url}`;
  }

  /* Nada de handler inline no HTML: a CSP do servidor só aceita scripts do próprio site. */
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'IMG' || el.dataset.fallbackDone) return;
      el.dataset.fallbackDone = '1';
      if (el.dataset.onerror === 'hide') el.style.visibility = 'hidden';
      else el.src = IMG_FALLBACK;
    },
    true
  );

  const money = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- storage ---------- */
  function loadCart() {
    try { return JSON.parse(localStorage.getItem('gs_cart')) || []; } catch { return []; }
  }
  function saveCart() {
    localStorage.setItem('gs_cart', JSON.stringify(state.cart));
    renderCartBadge();
    renderCartBar();
  }
  function loadGuest() {
    try { return JSON.parse(localStorage.getItem('gs_guest')) || {}; } catch { return {}; }
  }
  function saveGuest() {
    localStorage.setItem('gs_guest', JSON.stringify({
      name: $('#order-name').value.trim(),
      phone: $('#order-phone').value.trim(),
      address: $('#order-address').value.trim(),
      pay: state.pay || '',
      note: $('#order-note').value.trim(),
    }));
  }
  function saveCatalogPrefs() {
    try {
      sessionStorage.setItem('gs_catalog', JSON.stringify({
        category: state.activeCategory,
        filter: state.catalogFilter,
        sort: state.catalogSort,
      }));
    } catch { /* sessão cheia ou privada */ }
  }
  function applyCatalogPrefs() {
    state.activeCategory = 'all';
    state.catalogFilter = 'all';
    state.catalogSort = 'default';
  }
  function isPromo(p) {
    return !!(p.originalPrice && p.originalPrice > p.price);
  }
  function fillGuest() {
    const g = loadGuest();
    $('#order-name').value = g.name || '';
    $('#order-phone').value = formatPhoneMask(g.phone || '');
    $('#order-address').value = g.address || '';
    $('#order-note').value = g.note || '';
    if (g.pay) state.pay = g.pay;
  }

  /* ---------- toast ---------- */
  let toastTimer;
  let askYesFn = null;
  let askNoFn = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
  }
  function closeAsk() {
    $('#toast-ask').classList.add('hidden');
    askYesFn = null;
    askNoFn = null;
  }
  function askToast(msg, onYes, onNo) {
    askYesFn = onYes;
    askNoFn = onNo || null;
    $('#toast-ask-msg').textContent = msg;
    $('#toast-ask').classList.remove('hidden');
  }

  /* ---------- age gate ---------- */
  function initAgeGate() {
    if (localStorage.getItem('gs_age') === 'ok') return;
    $('#age-gate').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#age-yes').addEventListener('click', () => {
      localStorage.setItem('gs_age', 'ok');
      $('#age-gate').classList.add('hidden');
      if (state.store.shipping && state.store.shipping.length) initLocationGate();
      else initAuthGate();
      document.querySelectorAll('.reveal.in').forEach((el) => el.classList.remove('in'));
      requestAnimationFrame(() => watchReveals());
    });
  }

  /* ---------- localização na entrada ---------- */
  function loadLocation() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_LOCATION_KEY)) || null;
    } catch {
      return null;
    }
  }
  function saveLocation() {
    try {
      sessionStorage.setItem(SESSION_LOCATION_KEY, JSON.stringify({
        shipId: state.shipId,
        confirmed: true,
      }));
    } catch { /* sessão privada: mostra a escolha novamente no próximo carregamento */ }
  }
  function applySavedLocation() {
    const loc = loadLocation();
    if (!loc || !loc.confirmed) return false;
    const ship = (state.store.shipping || []).find((s) => s.id === loc.shipId);
    if (!ship) return false;
    state.shipId = loc.shipId;
    state.cityConfirmed = true;
    state.locationReady = true;
    return true;
  }
  function openLocationGate(opts = {}) {
    const changing = !!opts.changing;
    state.changingLocation = changing;
    if (!(state.store.shipping && state.store.shipping.length)) {
      state.locationReady = true;
      renderRegionBtn();
      if (!changing) initAuthGate();
      return;
    }
    if (!changing && applySavedLocation()) {
      refreshCityCatalog();
      initAuthGate();
      return;
    }
    const gate = $('#location-gate');
    if (!gate) {
      if (!changing) initAuthGate();
      return;
    }
    if (changing) {
      try { sessionStorage.removeItem(SESSION_LOCATION_KEY); } catch { /* ignore */ }
      state.locationReady = false;
      state.cityConfirmed = false;
      const box = $('#location-confirm');
      if (box) box.checked = false;
    }
    gate.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderLocationChoices();
    updateLocationContinue();
  }
  function initLocationGate() {
    openLocationGate();
  }
  function shippingOptions() {
    const order = CASHBOXES.map((c) => c.id);
    return [...(state.store.shipping || [])].sort((a, b) => {
      const ia = order.indexOf(cashboxOf(a.name));
      const ib = order.indexOf(cashboxOf(b.name));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  function renderLocationChoices() {
    const wrap = $('#location-choices');
    const ships = shippingOptions();
    if (!wrap || !ships.length) return;
    const choiceBtn = (sh) => {
      const box = cashboxMeta(sh.name);
      return `<button type="button" class="choice city-choice location-choice ${state.shipId === sh.id ? 'selected' : ''}" data-ship="${esc(sh.id)}">
        <span><strong>${esc(box.title)}</strong>${box.hint ? `<small>${esc(box.hint)}</small>` : ''}</span>
      </button>`;
    };
    wrap.innerHTML = ships.map(choiceBtn).join('');
    wrap.querySelectorAll('[data-ship]').forEach((b) =>
      b.addEventListener('click', () => {
        state.shipId = b.dataset.ship;
        state.cityConfirmed = false;
        $('#location-confirm').checked = false;
        renderLocationChoices();
        updateLocationContinue();
      })
    );
    const ship = currentShipping();
    const text = $('#location-confirm-text');
    if (text && ship) text.textContent = cashboxMeta(ship.name).confirm;
    updateLocationContinue();
  }
  function updateLocationContinue() {
    const btn = $('#location-continue');
    const box = $('#location-confirm');
    if (btn) btn.disabled = !(box && box.checked && currentShipping());
  }
  function closeLocationGate() {
    const changing = state.changingLocation;
    state.changingLocation = false;
    const gate = $('#location-gate');
    if (gate) gate.classList.add('hidden');
    state.locationReady = true;
    state.cityConfirmed = true;
    saveLocation();
    state.activeCategory = 'all';
    saveCatalogPrefs();
    refreshCityCatalog();
    renderChoices();
    renderCart();
    if (changing) revealStore();
    else initAuthGate();
  }

  /* ---------- data ---------- */
  async function loadCatalog() {
    applyCatalogPrefs();
    renderSkeleton();
    try {
      const catalogUrl = IS_PAGES ? `${PAGES_BASE}/data/store.json` : '/api/public/store';
      const res = await fetch(catalogUrl);
      const data = await res.json();
      const s = data.settings || {};
      const shipping = (s.shipping || []).map((sh, i) => ({ id: String(i), name: sh.name, price: Number(sh.price) || 0, description: sh.description || '' }));
      state.store = {
        name: s.name || 'GOLD SKULL',
        tagline: s.tagline || 'Loja online de produtos de THC',
        description: s.extra || '',
        whatsapp: String(s.whatsapp || '').replace(/\D/g, ''),
        address: s.address || '',
        banner: asset(s.banner || ''),
        checkoutMessage: s.checkoutMessage || '',
        payments: Array.isArray(s.payments) ? s.payments : [],
        paymentNote: (s.payments || []).join(' • '),
        shipping,
      };
      state.promoBar = s.promoBar && s.promoBar.text ? s.promoBar : null;
      state.promos = Array.isArray(s.promos) ? s.promos.filter((p) => p && p.title).map((p) => ({ ...p, image: asset(p.image || '') })) : [];
      state.coupons = Array.isArray(s.coupons) ? s.coupons : [];
      state.referral = s.referral && typeof s.referral === 'object' ? s.referral : state.referral;
      state.categories = (data.categories || []).map((name) => ({ id: name, name }));
      if (state.activeCategory !== 'all' && !state.categories.some((c) => c.id === state.activeCategory)) {
        state.activeCategory = 'all';
      }
      state.products = (data.products || []).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        price: p.promoPrice != null ? p.promoPrice : p.price,
        originalPrice: p.promoPrice != null && p.promoPrice < p.price ? p.price : null,
        category: p.category || '',
        categoryId: p.category || '',
        cities: (Array.isArray(p.cities) && p.cities.length ? p.cities : (p.category ? [p.category] : []))
          .map(cashboxOf)
          .filter(Boolean),
        image: asset(p.image || ''),
        featured: !!p.pin,
        outOfStock: !!(p.stockActive && p.stock != null && p.stock <= 0),
        optionGroup: p.optionGroup || '',
        options: Array.isArray(p.options) ? p.options.map((o) => ({ ...o, image: asset(o.image || '') })) : [],
      }));
      renderStore();
      renderCategories();
      renderPromos();
      renderDeals();
      renderGrid();
      await loadCustomer();
      if (localStorage.getItem('gs_age') === 'ok') initLocationGate();
    } catch {
      $('#grid').innerHTML = '';
      $('#empty').classList.remove('hidden');
      $('#empty p').textContent = 'Não foi possível carregar o catálogo. Atualize a página.';
    }
  }

  function renderStore() {
    const s = state.store;
    document.title = `${s.name} — Catálogo`;
    $('#brand-name').textContent = s.name;
    $('#store-name').textContent = s.name;
    $('#store-tagline').textContent = s.tagline;
    $('#store-desc').textContent = s.description;
    $('#footer-name').textContent = s.name;
    $('#footer-address').textContent = s.address;
    $('#payment-note').textContent = s.paymentNote;
    $('#checkout-message').textContent = s.checkoutMessage;
    const bannerSection = $('#banner-section');
    if (s.banner) $('#hero-banner').src = s.banner;
    bannerSection.classList.add('hidden');
    const wa = s.whatsapp ? `https://wa.me/${s.whatsapp}` : '#';
    $('#wa-float').href = wa;
    $('#footer-wa').href = wa;
    $('#hero-wa').href = wa;
    if (!state.shipId && s.shipping[0]) state.shipId = s.shipping[0].id;
    fillGuest();
    if (!state.pay && s.payments[0]) state.pay = s.payments[0];
    renderChoices();
  }

  function payShort(p) {
    if (/pix/i.test(p)) return 'Pix';
    if (/cart/i.test(p)) return 'Cartão';
    return p;
  }

  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function isRemoteShipping(sh) {
    return /outras|transportadora|correios|sedex|pac|brasil|atacado/i.test(`${sh.name} ${sh.description}`);
  }

  function cashboxOf(name) {
    const t = fold(name);
    if (t.includes('joinville')) return 'Joinville';
    if (t.includes('itajai')) return 'Itajaí';
    if (/(brasil|atacado|outras|remoto|transportadora)/.test(t)) return 'Atacado';
    return name || '';
  }

  function cashboxMeta(name) {
    const id = cashboxOf(name);
    return CASHBOXES.find((c) => c.id === id) || { id, title: name || id, hint: '', confirm: `Confirmo que estou em ${name || id}` };
  }

  function shipPriceLabel(ship, amount, free) {
    if (free) return 'Grátis';
    if (!ship) return 'A combinar';
    if (cashboxOf(ship.name) === 'Atacado') return 'A combinar';
    return money(amount);
  }

  function orderCityLabel(ship) {
    if (!ship) return 'A combinar';
    const box = cashboxMeta(ship.name);
    return box.id === 'Atacado' ? 'Brasil (Atacado)' : box.title;
  }

  function shipKind(sh) {
    if (!sh) return '';
    const box = cashboxOf(sh.name);
    if (box === 'Atacado' || isRemoteShipping(sh)) return 'remote';
    if (box === 'Joinville') return 'joinville';
    if (box === 'Itajaí') return 'itajai';
    return fold(sh.name);
  }

  function shipChoiceHint(sh) {
    return cashboxMeta(sh && sh.name).hint || sh.description || '';
  }

  const OTHER_CITY_WORDS = ['balneario', 'navegantes', 'camboriu', 'curitiba', 'florianopolis', 'floripa'];

  function textHasAny(text, words) {
    return words.some((w) => text.includes(w));
  }

  function addressLooksLikeCity(address, city) {
    const t = fold(address).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const c = fold(city);
    return t === c || t === `${c} sc` || t === `cidade de ${c}` || t === `${c} santa catarina`;
  }

  function addressConflictsWithShip(address, ship) {
    const addr = fold(address);
    if (!addr || !ship) return null;
    const kind = shipKind(ship);
    if (kind === 'itajai' && textHasAny(addr, ['joinville', ...OTHER_CITY_WORDS])) {
      return { block: true, message: 'Esse endereço não parece Itajaí. Troque a cidade no passo 1 ou o endereço.' };
    }
    if (kind === 'joinville' && textHasAny(addr, ['itajai', ...OTHER_CITY_WORDS])) {
      return { block: true, message: 'Esse endereço não parece Joinville. Troque a cidade no passo 1 ou o endereço.' };
    }
    if (kind === 'remote') {
      const looksLocal = addressLooksLikeCity(address, 'itajai')
        || addressLooksLikeCity(address, 'joinville')
        || (addr.includes('itajai') && !textHasAny(addr, ['joinville', ...OTHER_CITY_WORDS]))
        || (addr.includes('joinville') && !textHasAny(addr, ['itajai', ...OTHER_CITY_WORDS]));
      if (looksLocal) {
        return { block: false, message: 'Se mora em Itajaí ou Joinville, volte e escolha a entrega de motoboy.' };
      }
    }
    return null;
  }

  function shippingForCategory(cat) {
    return (state.store.shipping || []).find((s) => cashboxOf(s.name) === cashboxOf(cat));
  }

  function productCitiesOf(p) {
    if (Array.isArray(p.cities) && p.cities.length) return p.cities;
    return p.category ? [p.category] : [];
  }

  function productMatchesShip(p, ship) {
    if (!ship) return true;
    const box = cashboxOf(ship.name);
    const cities = productCitiesOf(p).map(cashboxOf);
    if (cities.includes(box)) return true;
    if (cashboxOf(p.categoryId) === box) return true;
    if (box === 'Atacado' && (p.categoryId === RETAIL_SKIP || cities.includes('Atacado'))) return true;
    return false;
  }

  function cityProducts() {
    return state.products.filter((p) => productMatchesShip(p, currentShipping()));
  }

  function catalogCategories() {
    const citySkip = new Set((state.store.shipping || []).map((s) => fold(s.name)));
    const seen = new Set();
    const cats = [];
    for (const p of cityProducts()) {
      const name = p.category || '';
      if (!name || citySkip.has(fold(name))) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      cats.push({ id: name, name });
    }
    return cats;
  }

  function refreshCityCatalog() {
    if (state.activeCategory !== 'all' && !catalogCategories().some((c) => c.id === state.activeCategory)) {
      state.activeCategory = 'all';
      saveCatalogPrefs();
    }
    renderCategories();
    renderDeals();
    renderGrid();
    renderCartBar();
  }

  function sortProducts(list) {
    return [...list].sort((a, b) => {
      if (!!a.outOfStock !== !!b.outOfStock) return a.outOfStock ? 1 : -1;
      if (state.catalogSort === 'price-asc') return (a.price || 0) - (b.price || 0);
      if (state.catalogSort === 'price-desc') return (b.price || 0) - (a.price || 0);
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });
  }

  function applyCategoryShipping(catId) {
    const prev = state.shipId;
    if (catId === 'all') return;
    if (catId === RETAIL_SKIP) {
      const remote = (state.store.shipping || []).find((s) => isRemoteShipping(s));
      if (remote) state.shipId = remote.id;
    } else {
      const ship = shippingForCategory(catId);
      if (ship) state.shipId = ship.id;
    }
    if (state.shipId !== prev) setCityConfirmed(false);
  }

  function setCityConfirmed(on) {
    state.cityConfirmed = !!on;
    const box = $('#city-confirm');
    if (box) box.checked = state.cityConfirmed;
  }

  function renderCityConfirm() {
    const ship = currentShipping();
    const text = $('#city-confirm-text');
    if (text) text.textContent = ship ? cashboxMeta(ship.name).confirm : 'Confirmo que estou nessa região';
    const box = $('#city-confirm');
    if (box) box.checked = state.cityConfirmed;
  }

  function renderCityBanner() {
    const ship = currentShipping();
    const title = $('#city-banner-title');
    if (!title) return;
    title.textContent = ship ? cashboxMeta(ship.name).title : 'Entrega';
  }

  function renderChoices() {
    const ships = shippingOptions();
    const choiceBtn = (sh) => {
      const box = cashboxMeta(sh.name);
      return `<button type="button" class="choice city-choice ${state.shipId === sh.id ? 'selected' : ''}" data-ship="${esc(sh.id)}">
          <strong>${esc(box.title)}</strong>
          ${box.hint ? `<small>${esc(box.hint)}</small>` : ''}
        </button>`;
    };
    $('#shipping-choices').innerHTML = ships.length
      ? `<div class="choice-list">${ships.map(choiceBtn).join('')}</div>`
      : '<p class="cart-note">Combinamos a entrega no WhatsApp.</p>';
    $('#shipping-choices').querySelectorAll('[data-ship]').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.shipId !== b.dataset.ship) setCityConfirmed(false);
        state.shipId = b.dataset.ship;
        renderChoices();
        renderCart();
        refreshCityCatalog();
      })
    );
    renderCityConfirm();
    renderCityBanner();
    const pays = state.store.payments && state.store.payments.length ? state.store.payments : ['A combinar'];
    if (!state.pay) state.pay = pays[0];
    $('#pay-choices').innerHTML = pays
      .map(
        (p) => `<button type="button" class="choice ${state.pay === p ? 'selected' : ''}" data-pay="${esc(p)}">${esc(payShort(p))}</button>`
      )
      .join('');
    $('#pay-choices').querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', () => {
        state.pay = b.dataset.pay;
        saveGuest();
        renderChoices();
      })
    );
  }

  function renderRegionBtn() {
    const btn = $('#region-open');
    const label = $('#region-label');
    if (!btn || !label) return;
    const ship = currentShipping();
    const ready = state.locationReady && !!ship;
    btn.classList.toggle('hidden', !ready);
    if (ready) label.textContent = cashboxMeta(ship.name).title;
  }

  function renderCategories() {
    renderRegionBtn();
  }

  /* ---------- animação de entrada no scroll ---------- */
  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const el = entry.target;
            revealObserver.unobserve(el);
            // 1 frame depois = o browser pinta o estado inicial (opacity 0) e a transição roda
            requestAnimationFrame(() => {
              requestAnimationFrame(() => el.classList.add('in'));
            });
          });
        },
        { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
      )
    : null;

  function watchReveals(root) {
    const items = (root || document).querySelectorAll('.reveal:not(.in)');
    if (!revealObserver) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    // Se o age-gate está aberto, segura a animação até o usuário confirmar
    if (!$('#age-gate').classList.contains('hidden')) return;
    items.forEach((el) => revealObserver.observe(el));
  }

  function initScrollFx() {
    const header = $('#header');
    let raf = null;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        header.classList.toggle('scrolled', window.scrollY > 12);
        raf = null;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function scrollToCatalog() {
    const el = $('#catalog');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- promoções e chamadas para ação ---------- */
  function runPromoAction(action, value) {
    if (action === 'whatsapp') {
      const wa = state.store.whatsapp;
      if (!wa) { toast('WhatsApp da loja não configurado'); return; }
      const text = encodeURIComponent(`Olá! Vi a promoção no site${value ? ` (${value})` : ''} e quero saber mais.`);
      window.open(`https://wa.me/${wa}?text=${text}`, '_blank');
      return;
    }
    if (action === 'produto' && value) {
      const p = state.products.find((x) => x.id === value)
        || state.products.find((x) => fold(x.name) === fold(value));
      if (p) { openModal(p.id); return; }
    }
    if (action === 'categoria' && value) {
      const ship = (state.store.shipping || []).find((s) => fold(s.name) === fold(value));
      if (ship) {
        state.shipId = ship.id;
        setCityConfirmed(true);
        state.activeCategory = 'all';
        refreshCityCatalog();
        renderChoices();
        renderCart();
      } else {
        const cat = catalogCategories().find((c) => fold(c.id) === fold(value))
          || state.categories.find((c) => fold(c.id) === fold(value));
        if (cat) {
          state.activeCategory = cat.id;
          state.search = '';
          $('#search').value = '';
          saveCatalogPrefs();
          renderCategories();
          renderGrid();
          renderCartBar();
        }
      }
    }
    scrollToCatalog();
  }

  function renderPromos() {
    // barra fina no topo
    const bar = $('#promo-bar');
    const barCta = $('#promo-bar-cta');
    if (state.promoBar) {
      $('#promo-bar-text').textContent = state.promoBar.text;
      const label = state.promoBar.ctaLabel || '';
      barCta.textContent = label;
      barCta.classList.toggle('hidden', !label);
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }

    // cards de promoção
    const section = $('#promos-section');
    const wrap = $('#promos');
    const list = state.promos;
    section.classList.toggle('hidden', list.length === 0);
    wrap.innerHTML = list
      .map(
        (p, i) => `
      <article class="promo-card reveal reveal-scale ${p.image ? 'has-img' : ''}" style="--d:${Math.min(i * 130, 520)}ms">
        ${p.image ? `<img class="promo-card-img" src="${esc(p.image)}" alt="" loading="lazy" data-onerror="hide" />` : ''}
        ${p.badge ? `<span class="promo-badge">${esc(p.badge)}</span>` : ''}
        <h3 class="promo-title">${esc(p.title)}</h3>
        ${p.subtitle ? `<p class="promo-sub">${esc(p.subtitle)}</p>` : ''}
        <button type="button" class="promo-cta" data-action="${esc(p.action || 'catalogo')}" data-value="${esc(p.value || '')}">
          ${esc(p.ctaLabel || 'Ver ofertas')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>
      </article>`
      )
      .join('');
    wrap.querySelectorAll('.promo-cta').forEach((b) =>
      b.addEventListener('click', () => runPromoAction(b.dataset.action, b.dataset.value))
    );
    watchReveals(wrap);
  }

  function renderDeals() {
    const section = $('#deals-section');
    const rail = $('#deals-rail');
    const list = cityProducts()
      .filter((p) => p.originalPrice && p.originalPrice > p.price && !p.outOfStock)
      .slice(0, 12);
    section.classList.toggle('hidden', list.length === 0);
    if (!list.length) { rail.innerHTML = ''; return; }
    $('#deals-count').textContent = `${list.length} ${list.length === 1 ? 'oferta' : 'ofertas'}`;
    rail.innerHTML = list.map((p, i) => cardHtml(p, i)).join('');
    rail.querySelectorAll('.card').forEach((el) => el.addEventListener('click', () => openModal(el.dataset.id)));
    watchReveals(rail);
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    let list = cityProducts().filter((p) => {
      if (state.activeCategory !== 'all' && p.categoryId !== state.activeCategory) return false;
      if (state.catalogFilter === 'promo' && !isPromo(p)) return false;
      if (state.catalogFilter === 'featured' && !p.featured) return false;
      if (state.catalogFilter === 'available' && p.outOfStock) return false;
      if (!q) return true;
      return [p.name, p.description, p.category, ...(p.cities || [])].join(' ').toLowerCase().includes(q);
    });
    list = dedupeProducts(list);
    return sortProducts(list);
  }

  function productKey(name) {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^\s*\d+\s*uni[dn]?\w*\.?\s*/i, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function dedupeProducts(list) {
    const byKey = new Map();
    for (const p of list) {
      const key = productKey(p.name);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, p);
        continue;
      }
      const pOpts = (p.options || []).length;
      const prevOpts = (prev.options || []).length;
      const preferCurrentCity =
        state.activeCategory !== 'all' &&
        p.categoryId === state.activeCategory &&
        prev.categoryId !== state.activeCategory;
      const preferMoreOpts = pOpts > prevOpts;
      const preferFeatured = p.featured && !prev.featured;
      if (preferCurrentCity || preferMoreOpts || preferFeatured) byKey.set(key, p);
    }
    return [...byKey.values()];
  }

  function renderSkeleton() {
    $('#grid').innerHTML = Array.from({ length: 8 })
      .map(() => '<div class="skel"><div class="skel-img"></div><div class="skel-line"></div><div class="skel-line short"></div></div>')
      .join('');
  }

  function renderGrid() {
    const list = filtered();
    const grid = $('#grid');
    const ship = currentShipping();
    const title = ship ? cashboxMeta(ship.name).title : 'Catálogo';
    $('#grid-title').textContent = state.search ? `Busca: "${state.search}"` : title;
    $('#result-count').textContent = `${list.length} ${list.length === 1 ? 'item' : 'itens'}`;
    $('#empty').classList.toggle('hidden', list.length > 0);
    grid.innerHTML = list.map((p, i) => cardHtml(p, i)).join('');
    grid.querySelectorAll('.card').forEach((el) =>
      el.addEventListener('click', () => openModal(el.dataset.id))
    );
    watchReveals(grid);
  }

  const IMG_FALLBACK = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%23efede6%22/><rect x=%2210%22 y=%2210%22 width=%2280%22 height=%2280%22 rx=%2212%22 fill=%22%23ffbe0e%22/><text x=%2250%22 y=%2268%22 text-anchor=%22middle%22 font-size=%2248%22 font-weight=%22bold%22 fill=%22%23181200%22 font-family=%22Arial%22>G</text></svg>";

  function cardHtml(p, i) {
    const promo = p.originalPrice && p.originalPrice > p.price;
    const dir = i % 3 === 1 ? 'reveal-left' : i % 3 === 2 ? 'reveal-right' : 'reveal-scale';
    return `
      <article class="card reveal ${dir} ${p.outOfStock ? 'out' : ''}" data-id="${esc(p.id)}" role="button" tabindex="0" style="--d:${Math.min(i * 70, 560)}ms">
        <div class="card-img-wrap">
          <img class="card-img" loading="lazy" src="${esc(p.image)}" alt="${esc(p.name)}" />
          ${promo ? '<span class="badge badge-promo">Promoção</span>' : ''}
          ${p.featured && !promo ? '<span class="badge badge-feat">Destaque</span>' : ''}
          ${p.outOfStock ? '<span class="badge badge-out">Esgotado</span>' : ''}
        </div>
        <div class="card-body">
          <div class="card-cat">${esc(p.category || 'Geral')}</div>
          <div class="card-name" title="${esc(p.name)}">${esc(p.name)}</div>
          ${p.options && p.options.length ? `<div class="card-opts">${p.options.length} sabores</div>` : ''}
          <div class="card-price-row">
            <span class="card-price">${money(p.price)}</span>
            ${promo ? `<span class="card-price-old">${money(p.originalPrice)}</span>` : ''}
          </div>
          <div class="card-cta">${p.outOfStock ? 'Esgotado' : 'Comprar'}</div>
        </div>
      </article>`;
  }

  /* ---------- product modal ---------- */
  function openModal(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    state.modalProduct = p;
    state.modalQty = 1;
    state.modalOption = '';
    const promo = p.originalPrice && p.originalPrice > p.price;
    const hasOpts = p.options && p.options.length;
    const firstOk = hasOpts ? p.options.find((o) => o.available !== false) : null;
    state.modalOption = firstOk ? firstOk.title : '';
    const optsHtml = hasOpts
      ? `<div class="opt-wrap">
          <p class="opt-label">1. Toque no sabor</p>
          <div class="opt-list" id="opt-list">
            ${p.options
              .map(
                (o) => `
              <button type="button" class="opt-item ${o.available === false ? 'disabled' : ''} ${state.modalOption === o.title ? 'selected' : ''}" data-opt="${esc(o.title)}" ${o.available === false ? 'disabled' : ''}>
                ${o.image ? `<img src="${esc(o.image)}" alt="" />` : '<span class="opt-dot"></span>'}
                <span>${esc(o.title)}</span>
              </button>`
              )
              .join('')}
          </div>
          <p class="opt-hint" id="opt-hint">${state.modalOption ? 'Sabor: ' + esc(state.modalOption) : 'Escolha um sabor'}</p>
        </div>`
      : '';
    const mainImg = (firstOk && firstOk.image) || p.image;
    const descHtml = p.description
      ? `<div class="modal-desc"><span class="modal-desc-title">Detalhes</span>${esc(p.description)}</div>`
      : '';
    $('#modal-body').innerHTML = `
      <div class="modal-grid">
        <div class="modal-media">
          <div class="modal-img-wrap">
            <img class="modal-img" id="modal-main-img" src="${esc(mainImg)}" alt="${esc(p.name)}" />
            ${promo ? '<span class="badge badge-promo">Promoção</span>' : ''}
          </div>
          ${descHtml}
        </div>
        <div class="modal-info">
          <span class="modal-cat">${esc(p.category || 'Geral')}</span>
          <h3 class="modal-name">${esc(p.name)}</h3>
          <div class="modal-price-row">
            <span class="modal-price">${money(p.price)}</span>
            ${promo ? `<span class="modal-price-old">${money(p.originalPrice)}</span>` : ''}
          </div>
          ${optsHtml}
          <div class="modal-actions">
            ${p.outOfStock
              ? '<span class="badge badge-out" style="position:static">Produto esgotado</span>'
              : `<div class="qty">
                  <button id="qty-minus" aria-label="Diminuir">−</button>
                  <span id="qty-value">1</span>
                  <button id="qty-plus" aria-label="Aumentar">+</button>
                </div>
                <button class="btn btn-gold" id="modal-add" style="flex:1">COLOCAR NO PEDIDO</button>`}
          </div>
        </div>
      </div>`;
    if (hasOpts) {
      $('#opt-list').querySelectorAll('.opt-item:not(.disabled)').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.modalOption = btn.dataset.opt;
          $('#opt-list').querySelectorAll('.opt-item').forEach((x) => x.classList.toggle('selected', x === btn));
          const hint = $('#opt-hint');
          if (hint) hint.textContent = 'Sabor: ' + btn.textContent.trim();
          const chosen = p.options.find((o) => o.title === btn.dataset.opt);
          if (chosen && chosen.image) $('#modal-main-img').src = chosen.image;
        });
      });
    }
    if (!p.outOfStock) {
      $('#qty-minus').addEventListener('click', () => { state.modalQty = Math.max(1, state.modalQty - 1); $('#qty-value').textContent = state.modalQty; });
      $('#qty-plus').addEventListener('click', () => { state.modalQty = Math.min(99, state.modalQty + 1); $('#qty-value').textContent = state.modalQty; });
      $('#modal-add').addEventListener('click', () => {
        if (hasOpts && !state.modalOption) {
          toast('Toque em um sabor primeiro');
          return;
        }
        addToCart(p.id, state.modalQty, state.modalOption);
        $('#product-modal').classList.add('hidden');
        openCart();
        toast('Pronto. Agora preencha seus dados e finalize o pedido.');
      });
    }
    $('#product-modal').classList.remove('hidden');
    $('#drawer-backdrop').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('#product-modal').classList.add('hidden');
    if ($('#cart-drawer').classList.contains('hidden')) {
      $('#drawer-backdrop').classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  /* ---------- cart ---------- */
  function cartKey(id, option) {
    return `${id}::${option || ''}`;
  }
  function promptShippingMix(product) {
    if (!product) return;
    const current = currentShipping();
    if (!current) return;
    if (productMatchesShip(product, current)) return;
    const cities = productCitiesOf(product);
    const boxes = cities.map(cashboxOf);
    const target = (state.store.shipping || []).find((s) => boxes.includes(cashboxOf(s.name)))
      || (product.categoryId === RETAIL_SKIP || boxes.includes('Atacado')
        ? (state.store.shipping || []).find((s) => cashboxOf(s.name) === 'Atacado' || isRemoteShipping(s))
        : shippingForCategory(product.category));
    if (!target || target.id === current.id) return;
    const label = cashboxMeta(target.name).title;
    askToast(`Esse produto é de ${label}. Trocar entrega para ${label}?`, () => {
      state.shipId = target.id;
      setCityConfirmed(false);
      saveCart();
      renderCart();
      refreshCityCatalog();
    });
  }

  function addToCart(id, qty, option) {
    const key = cartKey(id, option);
    const item = state.cart.find((i) => cartKey(i.id, i.option) === key);
    if (item) item.qty = Math.min(99, item.qty + qty);
    else state.cart.push({ id, qty, option: option || '' });
    const product = state.products.find((p) => p.id === id);
    saveCart();
    renderCart();
    promptShippingMix(product);
  }
  function setQty(key, qty) {
    const item = state.cart.find((i) => cartKey(i.id, i.option) === key);
    if (!item) return;
    item.qty = qty;
    if (item.qty <= 0) state.cart = state.cart.filter((i) => cartKey(i.id, i.option) !== key);
    saveCart();
    renderCart();
  }
  function removeFromCart(key) {
    state.cart = state.cart.filter((i) => cartKey(i.id, i.option) !== key);
    saveCart();
    renderCart();
  }
  function renderCartBadge() {
    const n = state.cart.reduce((s, i) => s + i.qty, 0);
    const el = $('#cart-count');
    el.textContent = n;
    el.classList.toggle('hidden', n === 0);
  }

  function currentShipping() {
    return (state.store.shipping || []).find((s) => s.id === state.shipId) || (state.store.shipping || [])[0] || null;
  }

  function normalizeCouponCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  }

  function findCouponLocal(code) {
    const norm = normalizeCouponCode(code);
    return state.coupons.find((c) => normalizeCouponCode(c.code) === norm) || null;
  }

  function evaluateCouponLocal(coupon, { subtotal, shipPrice }) {
    if (!coupon) return { error: 'Cupom inválido.' };
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return { error: 'Cupom expirado.' };
    if (coupon.maxUses != null && Number(coupon.usedCount) >= Number(coupon.maxUses)) return { error: 'Cupom esgotado.' };
    const min = Number(coupon.minOrder) || 0;
    if (min > 0 && subtotal < min) return { error: `Pedido mínimo de ${money(min)} para este cupom.` };
    if (coupon.type === 'percent') {
      const pct = Math.min(100, Math.max(0, Number(coupon.value) || 0));
      return { discount: Math.round(subtotal * pct) / 100, freeShipping: false, gift: null, label: `${pct}% de desconto` };
    }
    if (coupon.type === 'free_shipping') {
      return { discount: Math.max(0, Number(shipPrice) || 0), freeShipping: true, gift: null, label: 'Frete grátis' };
    }
    if (coupon.type === 'gift') {
      return {
        discount: 0,
        freeShipping: false,
        gift: { label: coupon.giftLabel || 'Jujuba de brinde', productId: coupon.giftProductId || '' },
        label: coupon.giftLabel || 'Brinde',
      };
    }
    return { error: 'Cupom inválido.' };
  }

  function cartTotals() {
    const items = state.cart
      .map((i) => ({ ...i, product: state.products.find((p) => p.id === i.id) }))
      .filter((i) => i.product);
    const subtotal = items.reduce((s, i) => s + i.product.price * i.qty, 0);
    const ship = currentShipping();
    const shipPrice = ship ? ship.price : 0;
    let couponDiscount = 0;
    let freeShipping = false;
    let gift = null;
    if (state.appliedCoupon) {
      const ev = evaluateCouponLocal(state.appliedCoupon.coupon, { subtotal, shipPrice });
      if (!ev.error) {
        couponDiscount = ev.discount || 0;
        freeShipping = !!ev.freeShipping;
        gift = ev.gift || null;
      } else {
        state.appliedCoupon = null;
      }
    }
    const effectiveShip = freeShipping ? 0 : shipPrice;
    const afterCoupon = Math.max(0, subtotal - couponDiscount) + effectiveShip;
    const maxCashback = state.customer ? Math.min(Number(state.customer.cashbackBalance) || 0, afterCoupon) : 0;
    const cashbackUsed = state.useCashback ? maxCashback : 0;
    const total = Math.max(0, afterCoupon - cashbackUsed);
    return { items, subtotal, ship, shipPrice, couponDiscount, freeShipping, gift, effectiveShip, cashbackUsed, total, afterCoupon };
  }

  /* ---------- conta do cliente ---------- */
  async function fetchCsrf() {
    if (IS_PAGES) return '';
    const res = await fetch('/api/public/csrf', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    state.csrf = data.csrf || '';
    return state.csrf;
  }

  async function storeFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = { ...(opts.headers || {}) };
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) {
      if (!state.csrf) await fetchCsrf();
      headers['X-CSRF-Token'] = state.csrf;
      if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    let res = await fetch(url, { ...opts, method, headers, credentials: 'same-origin' });
    if (mutating && res.status === 403) {
      const data = await res.clone().json().catch(() => ({}));
      if (data.csrf) {
        await fetchCsrf();
        headers['X-CSRF-Token'] = state.csrf;
        res = await fetch(url, { ...opts, method, headers, credentials: 'same-origin' });
      }
    }
    return res;
  }

  async function loadCustomer() {
    captureReferral();
    if (IS_PAGES) {
      try {
        const cached = JSON.parse(localStorage.getItem('gs_customer') || 'null');
        if (cached) state.customer = cached;
      } catch { /* ignore */ }
      renderAccountBtn();
      return;
    }
    try {
      await fetchCsrf();
      const res = await storeFetch('/api/public/customer/me');
      const data = await res.json();
      state.customer = data.customer || null;
      if (state.customer) {
        cacheCustomer(state.customer);
        fillFromCustomer();
      }
      renderAccountBtn();
    } catch { /* offline */ }
  }

  function cacheCustomer(customer) {
    if (!customer) {
      localStorage.removeItem('gs_customer');
      return;
    }
    localStorage.setItem('gs_customer', JSON.stringify({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      referralCode: customer.referralCode,
      cashbackBalance: customer.cashbackBalance,
      ordersCount: customer.ordersCount,
    }));
  }

  function captureReferral() {
    try {
      const q = new URLSearchParams(location.search);
      const code = String(q.get('ref') || q.get('indicacao') || q.get('ind') || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 20);
      if (code) localStorage.setItem('gs_ref', code);
    } catch { /* ignore */ }
    return localStorage.getItem('gs_ref') || '';
  }

  function fillFromCustomer() {
    if (!state.customer) return;
    if (state.customer.name) $('#order-name').value = state.customer.name;
    if (state.customer.phone) $('#order-phone').value = formatPhoneMask(state.customer.phone);
    if (state.customer.address) $('#order-address').value = state.customer.address;
  }

  function prefillRegister() {
    const guest = loadGuest();
    const name = $('#acc-reg-name');
    const phone = $('#acc-reg-phone');
    const address = $('#acc-reg-address');
    const ref = $('#acc-reg-ref');
    if (name && !name.value) name.value = guest.name || '';
    if (phone && !phone.value) phone.value = guest.phone || $('#acc-phone').value || '';
    if (address && !address.value) address.value = guest.address || '';
    if (ref && !ref.value) ref.value = captureReferral();
  }

  function renderAccountBtn() {
    const label = $('#account-label');
    if (!label) return;
    if (state.customer) {
      label.textContent = state.customer.name.split(' ')[0] || 'Conta';
    } else {
      label.textContent = 'Entrar';
    }
  }

  function onlyDigits(el, max) {
    if (!el) return;
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, max);
    });
  }

  function setAccountMode(mode) {
    document.querySelectorAll('.account-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    $('#account-login-form').classList.toggle('hidden', mode !== 'login');
    $('#account-register-form').classList.toggle('hidden', mode !== 'register');
    showAccountError('');
    if (mode === 'register') prefillRegister();
  }

  function showAccountError(msg) {
    const el = $('#account-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function authSkipped() {
    try {
      const s = JSON.parse(localStorage.getItem('gs_auth') || 'null');
      if (!s || !s.skipped) return false;
      if (s.at && Date.now() - s.at > 30 * 24 * 60 * 60 * 1000) return false;
      return true;
    } catch {
      return false;
    }
  }

  function skipAuth() {
    localStorage.setItem('gs_auth', JSON.stringify({ skipped: true, at: Date.now() }));
    closeAccount();
  }

  function revealStore() {
    if ($('#age-gate') && !$('#age-gate').classList.contains('hidden')) return;
    if ($('#location-gate') && !$('#location-gate').classList.contains('hidden')) return;
    if ($('#account-gate') && !$('#account-gate').classList.contains('hidden')) return;
    document.body.style.overflow = '';
    document.querySelectorAll('.reveal.in').forEach((el) => el.classList.remove('in'));
    requestAnimationFrame(() => watchReveals());
  }

  function initAuthGate(opts = {}) {
    const force = !!opts.force;
    if (!force && state.customer) {
      revealStore();
      return;
    }
    if (!force && authSkipped()) {
      revealStore();
      return;
    }
    if ($('#age-gate') && !$('#age-gate').classList.contains('hidden')) return;
    if ($('#location-gate') && !$('#location-gate').classList.contains('hidden')) return;
    openAccount({ entry: !force });
  }

  function openAccount(opts = {}) {
    const gate = $('#account-gate');
    if (!gate) return;
    state.authEntry = !!opts.entry;
    gate.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#account-close').classList.toggle('hidden', state.authEntry && !state.customer);
    $('#account-skip').classList.toggle('hidden', !state.authEntry || !!state.customer);
    $('#account-go').classList.toggle('hidden', !state.authEntry);
    $('#account-title').textContent = state.customer ? 'Minha conta' : (state.authEntry ? 'Entrar ou criar conta' : 'Sua conta');
    $('#account-sub').textContent = state.customer
      ? 'Seus dados já entram no pedido. Compartilhe o código para ganhar cashback.'
      : 'Salve a entrega e acumule cashback. Ou continue sem cadastro.';
    showAccountError('');
    renderAccountPanel();
    if (!state.customer) {
      setAccountMode('login');
      const phone = $('#acc-phone');
      if (phone && !phone.value) phone.value = loadGuest().phone || '';
    }
  }

  function closeAccount() {
    const gate = $('#account-gate');
    if (gate) gate.classList.add('hidden');
    state.authEntry = false;
    revealStore();
  }

  function renderAccountPanel() {
    const logged = !!state.customer;
    $('#account-logged').classList.toggle('hidden', !logged);
    $('#account-guest').classList.toggle('hidden', logged);
    $('#account-skip').classList.toggle('hidden', logged || !state.authEntry);
    $('#account-go').classList.toggle('hidden', !logged || !state.authEntry);
    $('#account-close').classList.toggle('hidden', state.authEntry && !logged);
    if (logged) {
      $('#account-name').textContent = state.customer.name;
      $('#account-balance').textContent = money(state.customer.cashbackBalance);
      $('#account-ref-code').textContent = state.customer.referralCode;
      $('#account-title').textContent = 'Minha conta';
    }
  }

  async function customerLogin(phone, pin) {
    if (IS_PAGES) return toast('Login disponível só com o servidor da loja ligado.');
    const res = await storeFetch('/api/public/customer/login', {
      method: 'POST',
      body: JSON.stringify({ phone, pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha no login');
    if (data.csrf) state.csrf = data.csrf;
    afterCustomerAuth(data.customer, `Olá, ${data.customer.name.split(' ')[0]}!`);
  }

  async function customerRegister(body) {
    if (IS_PAGES) return toast('Cadastro disponível só com o servidor da loja ligado.');
    const res = await storeFetch('/api/public/customer/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      $('#acc-phone').value = body.phone || '';
      setAccountMode('login');
      throw new Error(data.error || 'Esse WhatsApp já tem conta. Entre com o PIN.');
    }
    if (!res.ok) throw new Error(data.error || 'Falha no cadastro');
    if (data.csrf) state.csrf = data.csrf;
    afterCustomerAuth(
      data.customer,
      data.unknownReferral
        ? 'Conta criada. Código de indicação não encontrado.'
        : 'Conta criada! Seus dados foram salvos.'
    );
  }

  function afterCustomerAuth(customer, msg) {
    state.customer = customer;
    cacheCustomer(customer);
    localStorage.removeItem('gs_auth');
    fillFromCustomer();
    saveGuest();
    renderAccountBtn();
    renderAccountPanel();
    renderCart();
    toast(msg);
    if (!state.authEntry) return;
    $('#account-go').classList.remove('hidden');
    $('#account-close').classList.remove('hidden');
  }

  async function customerLogout() {
    if (!IS_PAGES) {
      try {
        await storeFetch('/api/public/customer/logout', { method: 'POST' });
      } catch { /* ignore */ }
    }
    state.customer = null;
    state.useCashback = false;
    cacheCustomer(null);
    renderAccountBtn();
    renderAccountPanel();
    renderCart();
    toast('Você saiu da conta.');
    if (state.authEntry) setAccountMode('login');
  }

  async function copyReferral() {
    const code = state.customer && state.customer.referralCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Código copiado.');
    } catch {
      toast(code);
    }
  }

  async function applyCouponCode() {
    const code = normalizeCouponCode($('#coupon-code').value);
    if (!code) return toast('Digite o código do cupom');
    const totals = cartTotals();
    if (IS_PAGES) {
      const coupon = findCouponLocal(code);
      if (!coupon) return toast('Cupom não encontrado');
      const ev = evaluateCouponLocal(coupon, { subtotal: totals.subtotal, shipPrice: totals.shipPrice });
      if (ev.error) return toast(ev.error);
      state.appliedCoupon = { code: coupon.code, coupon, ...ev };
    } else {
      try {
        const res = await storeFetch('/api/public/coupon/validate', {
          method: 'POST',
          body: JSON.stringify({ code, subtotal: totals.subtotal, shipPrice: totals.shipPrice }),
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Cupom inválido');
        const coupon = findCouponLocal(code) || { code: data.code, type: data.type };
        state.appliedCoupon = { code: data.code, coupon, ...data };
      } catch {
        return toast('Erro ao validar cupom');
      }
    }
    renderCart();
    toast(`Cupom ${state.appliedCoupon.label || code} aplicado!`);
  }

  function renderCartBar() {
    const { total } = cartTotals();
    const bar = $('#cart-bar');
    const n = state.cart.reduce((s, i) => s + i.qty, 0);
    if (bar) bar.classList.toggle('hidden', n === 0);
    document.body.classList.toggle('has-cart-bar', n > 0);
    const totalEl = $('#cart-bar-total');
    if (totalEl) totalEl.textContent = money(total);
  }

  function setCheckoutStep(step) {
    state.checkoutStep = Math.max(1, Math.min(3, step));
    [1, 2, 3].forEach((n) => {
      const panel = $(`#wizard-step-${n}`);
      if (panel) panel.classList.toggle('hidden', n !== state.checkoutStep);
      const dot = document.querySelector(`.wizard-dot[data-step="${n}"]`);
      if (dot) dot.classList.toggle('active', n <= state.checkoutStep);
    });
    const label = $('#wizard-step-label');
    if (label) label.textContent = `Passo ${state.checkoutStep} de 3`;
    const back = $('#wizard-back');
    const next = $('#wizard-next');
    if (back) back.classList.toggle('hidden', state.checkoutStep === 1);
    if (next) {
      next.textContent = state.checkoutStep === 3 ? 'Enviar' : 'Próximo';
      next.classList.toggle('hidden', state.checkoutStep === 3);
    }
  }

  function validateCheckoutStep(step) {
    if (step === 1) {
      if (state.locationReady && state.cityConfirmed) return true;
      if (!currentShipping()) { toast('Escolha sua região de entrega'); return false; }
      if (!state.cityConfirmed) { toast('Marque a confirmação da cidade'); return false; }
      return true;
    }
    if (step === 2) {
      const name = $('#order-name').value.trim();
      const phone = $('#order-phone').value.trim();
      const address = $('#order-address').value.trim();
      if (!name) { toast('Escreva seu nome'); $('#order-name').focus(); return false; }
      if (phone.replace(/\D/g, '').length < 10) { toast('Escreva seu WhatsApp com DDD'); $('#order-phone').focus(); return false; }
      if (!address) { toast('Escreva o bairro e a cidade'); $('#order-address').focus(); return false; }
      const conflict = addressConflictsWithShip(address, currentShipping());
      if (conflict) {
        toast(conflict.message);
        if (conflict.block) {
          $('#order-address').focus();
          return false;
        }
      }
      saveGuest();
      return true;
    }
    return true;
  }

  function renderCart() {
    const wrap = $('#cart-items');
    const { items, subtotal, ship, shipPrice, couponDiscount, freeShipping, gift, effectiveShip, cashbackUsed, total } = cartTotals();
    const has = items.length > 0;
    const successOpen = $('#checkout-success') && !$('#checkout-success').classList.contains('hidden');
    $('#cart-empty').classList.toggle('hidden', has || successOpen);
    $('#cart-foot').classList.toggle('hidden', !has && !successOpen);
    wrap.classList.toggle('hidden', !has);
    wrap.innerHTML = items
      .map((i) => {
        const key = cartKey(i.id, i.option);
        const thumb = (i.product.options || []).find((o) => o.title === i.option);
        return `
      <div class="cart-item">
        <img src="${esc((thumb && thumb.image) || i.product.image)}" alt="" data-onerror="hide" />
        <div>
          <div class="cart-item-name">${esc(i.product.name)}</div>
          ${i.option ? `<div class="cart-item-opt">${esc(i.option)}</div>` : ''}
          <div class="cart-item-row">
            <div class="qty small">
              <button data-act="minus" data-key="${esc(key)}">−</button>
              <span>${i.qty}</span>
              <button data-act="plus" data-key="${esc(key)}">+</button>
            </div>
            <span class="cart-item-price">${money(i.product.price * i.qty)}</span>
          </div>
        </div>
        <button class="cart-item-remove" data-act="rm" data-key="${esc(key)}" aria-label="Remover">🗑</button>
      </div>`;
      })
      .join('');
    if (gift && has) {
      wrap.innerHTML += `<div class="cart-gift">🎁 Brinde: ${esc(gift.label)}</div>`;
    }
    wrap.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        const { act, key } = b.dataset;
        if (act === 'rm') removeFromCart(key);
        else setQty(key, (state.cart.find((i) => cartKey(i.id, i.option) === key)?.qty || 1) + (act === 'plus' ? 1 : -1));
      })
    );
    $('#cart-subtotal').textContent = money(subtotal);
    $('#cart-shipping').textContent = shipPriceLabel(ship, effectiveShip, freeShipping);
    $('#cart-total').textContent = money(total);
    const totalFinal = $('#cart-total-final');
    if (totalFinal) totalFinal.textContent = money(total);
    const discRow = $('#cart-discount-row');
    const discEl = $('#cart-discount');
    if (discRow && discEl) {
      discRow.classList.toggle('hidden', !(couponDiscount > 0));
      discEl.textContent = `− ${money(couponDiscount)}`;
    }
    const cbRow = $('#cart-cashback-row');
    const cbEl = $('#cart-cashback');
    if (cbRow && cbEl) {
      cbRow.classList.toggle('hidden', !(cashbackUsed > 0));
      cbEl.textContent = `− ${money(cashbackUsed)}`;
    }
    const appliedEl = $('#coupon-applied');
    if (appliedEl) {
      if (state.appliedCoupon) {
        appliedEl.classList.remove('hidden');
        appliedEl.textContent = `✓ ${state.appliedCoupon.label || state.appliedCoupon.code} — toque aqui para remover`;
        appliedEl.onclick = () => { state.appliedCoupon = null; renderCart(); toast('Cupom removido'); };
      } else {
        appliedEl.classList.add('hidden');
        appliedEl.onclick = null;
      }
    }
    const cashbackRow = $('#cashback-row');
    const cashbackLabel = $('#cashback-label');
    const cashbackCheck = $('#cashback-use');
    if (cashbackRow && state.customer && (state.customer.cashbackBalance || 0) > 0) {
      cashbackRow.classList.remove('hidden');
      if (cashbackLabel) cashbackLabel.textContent = `Usar cashback (${money(state.customer.cashbackBalance)})`;
      if (cashbackCheck) cashbackCheck.checked = state.useCashback;
    } else if (cashbackRow) {
      cashbackRow.classList.add('hidden');
    }
    const n = state.cart.reduce((s, i) => s + i.qty, 0);
    const summary = $('#cart-summary');
    if (summary) {
      summary.classList.toggle('hidden', !has);
      summary.textContent = has ? `${n} ${n === 1 ? 'item' : 'itens'} · ${money(total)}` : '';
    }
    renderChoices();
    renderCityBanner();
    renderCartBar();
    if (has) setCheckoutStep(state.checkoutStep);
  }

  function openCart() {
    resetCheckoutSuccess();
    state.checkoutStep = state.locationReady && state.cityConfirmed ? 2 : 1;
    if (state.locationReady) state.cityConfirmed = true;
    renderCart();
    setCheckoutStep(state.checkoutStep);
    $('#cart-drawer').classList.remove('hidden');
    $('#drawer-backdrop').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeCart() {
    $('#cart-drawer').classList.add('hidden');
    resetCheckoutSuccess();
    if ($('#product-modal').classList.contains('hidden')) {
      $('#drawer-backdrop').classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  function formatPhoneMask(raw) {
    const d = String(raw || '').replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  function burstConfetti() {
    const canvas = $('#confetti-canvas');
    if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    const parent = canvas.parentElement;
    const w = parent.clientWidth || 360;
    const h = parent.clientHeight || 420;
    canvas.width = w;
    canvas.height = h;
    const colors = ['#ffc422', '#ffd873', '#25d366', '#ffffff', '#ff6b6b', '#7aa2ff'];
    const pieces = Array.from({ length: 90 }, () => ({
      x: Math.random() * w,
      y: -20 - Math.random() * h,
      r: 3 + Math.random() * 5,
      c: colors[(Math.random() * colors.length) | 0],
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4,
    }));
    let frame = 0;
    const tick = () => {
      frame += 1;
      ctx.clearRect(0, 0, w, h);
      pieces.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        ctx.restore();
      });
      if (frame < 160) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    requestAnimationFrame(tick);
  }

  function showCheckoutSuccess(waMsg) {
    state.lastWhatsAppMsg = waMsg || '';
    const wizard = document.querySelector('.checkout-wizard');
    const success = $('#checkout-success');
    if (wizard) wizard.classList.add('hidden');
    if (success) success.classList.remove('hidden');
    $('#cart-empty')?.classList.add('hidden');
    $('#cart-foot')?.classList.remove('hidden');
    $('#cart-items')?.classList.add('hidden');
    const waBtn = $('#success-wa');
    if (waBtn) {
      if (state.store.whatsapp && waMsg) {
        waBtn.href = `https://wa.me/${state.store.whatsapp}?text=${encodeURIComponent(waMsg)}`;
        waBtn.classList.remove('hidden');
      } else {
        waBtn.classList.add('hidden');
      }
    }
    burstConfetti();
  }

  function resetCheckoutSuccess() {
    const wizard = document.querySelector('.checkout-wizard');
    const success = $('#checkout-success');
    if (wizard) wizard.classList.remove('hidden');
    if (success) success.classList.add('hidden');
    state.lastWhatsAppMsg = '';
  }

  async function checkout() {
    if (!state.cart.length) return;
    if (!state.cityConfirmed && !state.locationReady) {
      setCheckoutStep(1);
      toast('Marque a confirmação da cidade');
      return;
    }
    if (!validateCheckoutStep(2)) {
      setCheckoutStep(2);
      return;
    }
    if (!state.pay) {
      toast('Escolha como vai pagar');
      return;
    }
    const name = $('#order-name').value.trim();
    const phone = $('#order-phone').value.trim();
    const address = $('#order-address').value.trim();
    const note = $('#order-note').value.trim();
    const pay = state.pay || 'A combinar';
    saveGuest();

    let totals = cartTotals();
    let checkoutMeta = null;

    if (state.appliedCoupon && !IS_PAGES && !state.customer) {
      try {
        await storeFetch('/api/public/coupon/redeem', {
          method: 'POST',
          body: JSON.stringify({
            code: state.appliedCoupon.code,
            subtotal: totals.subtotal,
            shipPrice: totals.shipPrice,
          }),
        });
      } catch { /* segue mesmo se falhar */ }
    }

    if (state.customer && !IS_PAGES) {
      try {
        const res = await storeFetch('/api/public/customer/checkout', {
          method: 'POST',
          body: JSON.stringify({
            subtotal: totals.subtotal,
            shipPrice: totals.shipPrice,
            cashbackUse: state.useCashback ? totals.cashbackUsed : 0,
            couponCode: state.appliedCoupon ? state.appliedCoupon.code : '',
          }),
        });
        const data = await res.json();
        if (res.ok) {
          checkoutMeta = data;
          state.customer = data.customer;
          totals = cartTotals();
          if (state.customer) await storeFetch('/api/public/customer/profile', {
            method: 'PUT',
            body: JSON.stringify({ name, address }),
          }).catch(() => {});
        }
      } catch { /* segue sem cashback server-side */ }
    }

    const { items, subtotal, ship, couponDiscount, freeShipping, gift, effectiveShip, cashbackUsed, total } = totals;
    const lines = items.map((i) => `• ${i.qty}x ${i.product.name}${i.option ? ` (${i.option})` : ''} — ${money(i.product.price * i.qty)}`);
    const msg = [
      `*Novo pedido — ${state.store.name}*`,
      `*CIDADE:* ${orderCityLabel(ship)}`,
      '',
      `*Cliente:* ${name}`,
      `*WhatsApp do cliente:* ${phone}`,
      `*Entrega em:* ${address}`,
      `*Frete:* ${shipPriceLabel(ship, effectiveShip, freeShipping)}`,
      `*Pagamento:* ${pay}`,
      ...(state.appliedCoupon ? [`*Cupom:* ${state.appliedCoupon.code} (${state.appliedCoupon.label || ''})`] : []),
      ...(gift ? [`*Brinde:* ${gift.label}`] : []),
      ...(cashbackUsed > 0 ? [`*Cashback usado:* ${money(cashbackUsed)}`] : []),
      ...(checkoutMeta && checkoutMeta.cashbackEarned > 0 ? [`*Cashback ganho:* ${money(checkoutMeta.cashbackEarned)}`] : []),
      '',
      '*Itens:*',
      ...lines,
      '',
      `Subtotal: ${money(subtotal)}`,
      ...(couponDiscount > 0 ? [`Desconto: − ${money(couponDiscount)}`] : []),
      `Entrega: ${shipPriceLabel(ship, effectiveShip, freeShipping)}`,
      ...(cashbackUsed > 0 ? [`Cashback: − ${money(cashbackUsed)}`] : []),
      `*Total: ${money(checkoutMeta ? checkoutMeta.total : total)}*`,
      ...(note ? ['', `Obs: ${note}`] : []),
    ].join('\n');

    if (!IS_PAGES) {
      // Avisa o sininho do painel. Não trava o checkout se isso falhar.
      storeFetch('/api/public/order/notify', {
        method: 'POST',
        body: JSON.stringify({
          name,
          phone,
          address,
          city: orderCityLabel(ship),
          payment: pay,
          note,
          couponCode: state.appliedCoupon ? state.appliedCoupon.code : '',
          subtotal,
          total: checkoutMeta ? checkoutMeta.total : total,
          cashbackUsed,
          items: items.map((i) => {
            const flavor = (i.product.options || []).find((o) => o.title === i.option);
            return {
              productId: i.product.id,
              name: i.product.name,
              qty: i.qty,
              option: i.option || '',
              price: i.product.price,
              image: (flavor && flavor.image) || i.product.image || '',
            };
          }),
        }),
      }).catch(() => {});
    }

    state.cart = [];
    state.appliedCoupon = null;
    state.useCashback = false;
    const couponInput = $('#coupon-code');
    if (couponInput) couponInput.value = '';
    const couponRow = $('#coupon-row');
    if (couponRow) couponRow.classList.add('hidden');
    saveCart();
    renderAccountBtn();
    renderCart();
    showCheckoutSuccess(msg);
    toast('Pedido finalizado!');
  }

  /* ---------- instalar na tela inicial (PWA) ---------- */
  function initPwa() {
    if ('serviceWorker' in navigator && !IS_PAGES) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          /* sem service worker o site continua funcionando normal */
        });
      });
    }

    const section = $('#install-section');
    const btn = $('#install-btn');
    const hint = $('#install-hint');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (standalone) return; // já está instalado

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    let prompt = null;

    function showInstall() {
      section.classList.remove('hidden');
      watchReveals(section);
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      prompt = e;
      showInstall();
    });

    btn.addEventListener('click', async () => {
      if (prompt) {
        prompt.prompt();
        const choice = await prompt.userChoice.catch(() => null);
        prompt = null;
        if (choice && choice.outcome === 'accepted') {
          section.classList.add('hidden');
          toast('Pronto! O ícone da loja já está no seu celular.');
        }
        return;
      }
      toast(isIos ? 'No Safari: toque em Compartilhar e depois "Adicionar à Tela de Início".' : 'Abra o menu do navegador e toque em "Instalar aplicativo".');
    });

    window.addEventListener('appinstalled', () => {
      section.classList.add('hidden');
      toast('Loja instalada no seu celular.');
    });

    if (isIos) {
      hint.textContent = 'No iPhone: toque em Compartilhar (o quadrado com a flecha) e escolha "Adicionar à Tela de Início".';
      btn.textContent = 'COMO INSTALAR';
    }
    showInstall();
  }

  /* ---------- events ---------- */
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      renderGrid();
    }, 160);
  });
  $('#hero-cta').addEventListener('click', scrollToCatalog);
  $('#footer-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $('#promo-bar-cta').addEventListener('click', () => {
    if (state.promoBar) runPromoAction(state.promoBar.action, state.promoBar.value);
  });
  $('#cart-open').addEventListener('click', openCart);
  $('#cart-bar-open').addEventListener('click', openCart);
  $('#cart-close').addEventListener('click', closeCart);
  $('#modal-close').addEventListener('click', closeModal);
  $('#drawer-backdrop').addEventListener('click', () => { closeModal(); closeCart(); closeAccount(); });
  $('#checkout-btn').addEventListener('click', checkout);
  $('#coupon-toggle').addEventListener('click', () => {
    const row = $('#coupon-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) $('#coupon-code').focus();
  });
  $('#order-phone').addEventListener('input', (e) => {
    e.target.value = formatPhoneMask(e.target.value);
  });
  $('#success-close').addEventListener('click', () => {
    closeCart();
  });
  $('#wizard-next').addEventListener('click', () => {
    if (!validateCheckoutStep(state.checkoutStep)) return;
    if (state.checkoutStep === 2) setCheckoutStep(3);
    else setCheckoutStep(state.checkoutStep + 1);
  });
  $('#wizard-back').addEventListener('click', () => setCheckoutStep(state.checkoutStep - 1));
  $('#city-confirm').addEventListener('change', (e) => {
    state.cityConfirmed = e.target.checked;
  });
  const locConfirm = $('#location-confirm');
  if (locConfirm) {
    locConfirm.addEventListener('change', updateLocationContinue);
  }
  const locContinue = $('#location-continue');
  if (locContinue) {
    locContinue.addEventListener('click', () => {
      if (!locConfirm || !locConfirm.checked) return toast('Confirme sua cidade');
      closeLocationGate();
    });
  }
  const regionOpen = $('#region-open');
  if (regionOpen) {
    regionOpen.addEventListener('click', () => openLocationGate({ changing: true }));
  }
  $('#account-open').addEventListener('click', () => openAccount({ entry: false }));
  $('#account-close').addEventListener('click', closeAccount);
  $('#account-logout').addEventListener('click', customerLogout);
  const accGo = $('#account-go');
  if (accGo) accGo.addEventListener('click', closeAccount);
  const accSkip = $('#account-skip');
  if (accSkip) accSkip.addEventListener('click', skipAuth);
  const accCopy = $('#account-copy-ref');
  if (accCopy) accCopy.addEventListener('click', copyReferral);
  const accGate = $('#account-gate');
  if (accGate) {
    accGate.addEventListener('click', (e) => {
      if (e.target === accGate && !state.authEntry) closeAccount();
    });
  }
  onlyDigits($('#acc-pin'), 6);
  onlyDigits($('#acc-reg-pin'), 6);
  onlyDigits($('#acc-reg-pin2'), 6);
  $('#coupon-apply').addEventListener('click', applyCouponCode);
  $('#coupon-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCouponCode();
    }
  });
  $('#cashback-use').addEventListener('change', (e) => {
    state.useCashback = e.target.checked;
    renderCart();
  });
  document.querySelectorAll('.account-tab').forEach((tab) =>
    tab.addEventListener('click', () => setAccountMode(tab.dataset.mode))
  );
  $('#account-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#account-login-btn');
    const phone = $('#acc-phone').value.trim();
    const pin = $('#acc-pin').value;
    if (phone.replace(/\D/g, '').length < 10) return showAccountError('Escreva seu WhatsApp com DDD.');
    if (!/^\d{4,6}$/.test(pin)) return showAccountError('PIN de 4 a 6 dígitos.');
    showAccountError('');
    if (btn) btn.disabled = true;
    try {
      await customerLogin(phone, pin);
    } catch (err) {
      showAccountError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $('#account-register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#account-register-btn');
    const name = $('#acc-reg-name').value.trim();
    const phone = $('#acc-reg-phone').value.trim();
    const pin = $('#acc-reg-pin').value;
    const pin2 = $('#acc-reg-pin2').value;
    if (!name) return showAccountError('Escreva seu nome.');
    if (phone.replace(/\D/g, '').length < 10) return showAccountError('Escreva seu WhatsApp com DDD.');
    if (!/^\d{4,6}$/.test(pin)) return showAccountError('Crie um PIN de 4 a 6 dígitos.');
    if (pin !== pin2) return showAccountError('Os PINs não são iguais.');
    showAccountError('');
    if (btn) btn.disabled = true;
    try {
      await customerRegister({
        name,
        phone,
        address: $('#acc-reg-address').value.trim(),
        referralCode: $('#acc-reg-ref').value.trim(),
        pin,
      });
    } catch (err) {
      showAccountError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $('#order-address').addEventListener('blur', () => {
    const conflict = addressConflictsWithShip($('#order-address').value.trim(), currentShipping());
    if (conflict) toast(conflict.message);
  });
  $('#toast-ask-yes').addEventListener('click', () => {
    const fn = askYesFn;
    closeAsk();
    if (fn) fn();
  });
  $('#toast-ask-no').addEventListener('click', () => {
    const fn = askNoFn;
    closeAsk();
    if (fn) fn();
  });
  ['order-name', 'order-phone', 'order-address', 'order-note'].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveGuest);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeCart();
      if (!state.authEntry) closeAccount();
    }
  });

  /* ---------- init ---------- */
  initAgeGate();
  initScrollFx();
  watchReveals();
  initPwa();
  renderCartBadge();
  renderCartBar();
  loadCatalog();
})();
