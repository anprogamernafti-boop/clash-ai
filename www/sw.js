/* Clash AI — service worker : l'app doit s'ouvrir même sans réseau.
   Stratégie : on met le shell en cache, et on ne cache JAMAIS les appels d'API
   (la photo envoyée à un modèle distant ne doit pas finir dans le cache).
   ⚠️ LE NOM DU CACHE DOIT CHANGER À CHAQUE LIVRAISON : c'est lui qui invalide l'ancienne copie.
   L'oublier donne exactement le symptôme « la mise à jour n'est pas partie » : le site est bien
   déployé, mais le navigateur ressert l'ancien fichier. */
const CACHE = 'clashai-v15';
const SHELL = ['./', './index.html', './pay-mode.js', './billing-client.js', './referral-client.js', './manifest.webmanifest',
               './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'];
const API_HOSTS = ['generativelanguage.googleapis.com', 'api.openai.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                                   // jamais de cache sur un POST
  const host = (() => { try { return new URL(req.url).host; } catch (_) { return ''; } })();
  if (API_HOSTS.indexOf(host) !== -1) return;                          // les appels d'IA ne sont pas mis en cache
  /* Nos propres workers (proxy IA, parrainage, activation, narration, compteurs) : jamais mis en
     cache — une réponse d'API périmée donnerait des résultats faux. */
  if (/\.workers\.dev$/i.test(host)) return;
  /* La PAGE elle-même est demandée en ignorant le cache HTTP : un navigateur peut sinon servir un
     index.html périmé, et l'utilisateur croit que la livraison n'est pas passée. */
  const page = req.mode === 'navigate';
  const reseau = page ? fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }) : fetch(req);
  e.respondWith(
    reseau.then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
