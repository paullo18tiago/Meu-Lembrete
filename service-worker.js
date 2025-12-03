const CACHE_NAME = 'lembretes-v1';
const urlsToCache = [
  './',
  './index.html'
];

// Instalar Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Ativar Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceptar requisições
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

// Receber mensagens do app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_REMINDERS') {
    checkRemindersInBackground();
  }
});

// Verificar lembretes em segundo plano
function checkRemindersInBackground() {
  // Buscar lembretes do localStorage não é possível no service worker
  // Então vamos usar a API de notificações quando recebermos comando do app
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'REQUEST_REMINDERS'
      });
    });
  });
}

// Mostrar notificação
self.addEventListener('notificationclick', event => {
  const action = event.action;
  const reminderId = event.notification.data ? event.notification.data.reminderId : null;
  
  event.notification.close();
  
  if (action === 'snooze' && reminderId) {
    // Adiar 5 minutos
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        // Enviar mensagem para todos os clientes (apps abertos)
        clientList.forEach(client => {
          client.postMessage({
            type: 'SNOOZE_REMINDER',
            reminderId: reminderId,
            minutes: 5
          });
        });
        
        // Se não há clientes abertos, abrir o app
        if (clientList.length === 0) {
          return clients.openWindow('./').then(client => {
            // Aguardar um pouco para o app carregar
            setTimeout(() => {
              client.postMessage({
                type: 'SNOOZE_REMINDER',
                reminderId: reminderId,
                minutes: 5
              });
            }, 1000);
          });
        }
      })
    );
  } else if (action === 'complete' && reminderId) {
    // Concluir lembrete
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        clientList.forEach(client => {
          client.postMessage({
            type: 'COMPLETE_REMINDER',
            reminderId: reminderId
          });
        });
        
        if (clientList.length === 0) {
          return clients.openWindow('./').then(client => {
            setTimeout(() => {
              client.postMessage({
                type: 'COMPLETE_REMINDER',
                reminderId: reminderId
              });
            }, 1000);
          });
        }
      })
    );
  } else {
    // Clique normal na notificação - abrir app
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(clientList => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('./');
        }
      })
    );
  }
});

// Manter service worker ativo
self.addEventListener('sync', event => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkRemindersInBackground());
  }
});

// Agendar verificação periódica em segundo plano
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-reminders-periodic') {
    event.waitUntil(checkRemindersInBackground());
  }
});

// Alarme para verificar lembretes
let alarmTimeout;

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_ALARM') {
    const { reminderId, timeUntilReminder } = event.data;
    
    // Limpar alarme anterior
    if (alarmTimeout) {
      clearTimeout(alarmTimeout);
    }
    
    // Agendar novo alarme
    alarmTimeout = setTimeout(() => {
      // Enviar mensagem para o app verificar lembretes
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'CHECK_NOW'
          });
        });
      });
      
      // Se não houver clientes abertos, mostrar notificação diretamente
      if (clients.length === 0) {
        self.registration.showNotification('⏰ Lembrete', {
          body: 'Você tem um lembrete pendente!',
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          vibrate: [200, 100, 200, 100, 200, 100, 200],
          requireInteraction: true,
          tag: 'reminder-' + reminderId,
          data: { reminderId: reminderId }
        });
      }
    }, timeUntilReminder);
  }
});
