/* Service worker da loja: faz o site abrir como app e funcionar mesmo com internet ruim.
   Regras: o painel (/admin) e as respostas privadas NUNCA são guardadas. */

const VERSION = 'gs-v24';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const SHELL_FILES = [
  '/',
  '/css/base.css?v=17',
  '/css/store.css?v=24',
  '/js/app.js?v=28',
  '/img/logo.png',
  '/img/logo-160.png',
  '/img/icon-192.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isPrivate(url) {
  return url.pathname === '/admin' || url.pathname.startsWith('/admin/');
}

/** Guarda no cache só o que for seguro e deu certo. */
async function put(cacheName, request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const cache = await caches.open(cacheName);
  cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // fontes e afins ficam com o navegador
  if (isPrivate(url)) return;

  // Catálogo: tenta a internet, mas mostra o último catálogo salvo se estiver offline
  if (url.pathname === '/api/public/store') {
    event.respondWith(
      fetch(request)
        .then((res) => put(RUNTIME, request, res))
        .catch(() => caches.match(request))
        .then((res) => res || new Response(JSON.stringify({ settings: {}, categories: [], products: [] }), { headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // resto da API sempre direto do servidor

  // Navegação: internet primeiro, com a página salva como reserva
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => put(SHELL, request, res))
        .catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error())
    );
    return;
  }

  // Arquivos e fotos: usa o cache e atualiza por trás
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => put(url.pathname.startsWith('/uploads/') ? RUNTIME : SHELL, request, res))
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* Avisos de pedido novo (inscritos pelo painel). */
self.addEventListener('push', (event) => {
  let data = { title: 'Novo pedido', body: 'Abra o painel para ver', url: '/admin' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      const text = event.data && event.data.text();
      if (text) data.body = text;
    } catch {
      /* ignore */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Novo pedido', {
      body: data.body || '',
      icon: '/img/icon-192.png',
      badge: '/img/favicon-32.png',
      data: { url: data.url || '/admin' },
      tag: data.orderId ? `order-${data.orderId}` : 'order-new',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/admin') && 'focus' in client) {
          client.focus();
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
