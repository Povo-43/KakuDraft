const CACHE_NAME = 'kaku-draft-v1';
// キャッシュするファイルのリスト
const ASSETS_TO_CACHE = [
  './',
  './index.html', // あなたのメインのHTMLファイル名に合わせて変更
  './manifest.json',
  // アイコン画像などがあれば追加
  // './icon-192.png',
  // './icon-512.png',
  'https://fonts.googleapis.com/icon?family=Material+Icons'
];

// インストール時にファイルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ネットワーク優先（Network First） or キャッシュ優先（Cache First）
// 執筆アプリなので、基本は「キャッシュがあれば即表示」がストレスなくておすすめ
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
}
                     );
