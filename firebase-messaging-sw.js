// Firebase Cloud Messaging Service Worker (Background Push Notifications)
importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyAGv6HsPs35R4mUXPqhpLkizy1dNRpkkuU",
  authDomain: "rotas-de-inspecao.firebaseapp.com",
  projectId: "rotas-de-inspecao",
  storageBucket: "rotas-de-inspecao.firebasestorage.app",
  messagingSenderId: "917565341973",
  appId: "1:917565341973:web:326999b01b419b031c291c"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

// Handle background messages when app is closed or in background
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Mensagem recebida em segundo plano:', payload);

  const title = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || 'Rota de Inspeção';
  const options = {
    body: (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || 'Você possui inspeções de manutenção pendentes.',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: 'inspecao-push-notification',
    data: payload.data || {}
  };

  self.registration.showNotification(title, options);
});

// Click notification to focus/open the PWA app window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});
