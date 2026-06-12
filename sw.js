/* Service Worker — לוח שנה ותזכורות */
const APP_URL = './index.html';
const ICON = './icon-192.png';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// קבלת התראת Push (עובד גם כשהאפליקציה ברקע / סגורה)
self.addEventListener('push', (event) => {
  let data = { title: 'תזכורת', body: 'יש לך תזכורת קרובה', tag: 'reminder' };
  try {
    if (event.data) {
      const j = event.data.json();
      data = Object.assign(data, j);
    }
  } catch (e) { /* payload לא תקין — נשתמש בברירת מחדל */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      icon: ICON,
      badge: ICON,
      tag: data.tag || 'reminder',
      dir: 'rtl',
      lang: 'he',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: APP_URL }
    })
  );
});

// לחיצה על ההתראה — פותחת/ממקדת את האפליקציה
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(event.notification.data?.url || APP_URL);
  })());
});
