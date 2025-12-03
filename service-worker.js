const CACHE_NAME = 'lembretes-v2';
const urlsToCache = [
  './',
  './index.html'
];

let remindersData = [];

// Instalar Service Worker
self.addEventListener('install', event => {
  console.log('[SW] Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Ativar Service Worker
self.addEventListener('activate', event => {
  console.log('[SW] Ativando...');
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
      .catch(() => caches.match('./index.html'))
  );
});

// Receber mensagens do app principal
self.addEventListener('message', event => {
  console.log('[SW] Mensagem recebida:', event.data.type);
  
  if (event.data && event.data.type === 'UPDATE_REMINDERS') {
    remindersData = event.data.reminders;
    console.log('[SW] Lembretes atualizados:', remindersData.length);
    scheduleNextCheck();
  }
  
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const reminder = event.data.reminder;
    showNotification(reminder);
  }
  
  if (event.data && event.data.type === 'APP_READY') {
    console.log('[SW] App está pronto');
  }
});

// Mostrar notificação
function showNotification(reminder) {
  console.log('[SW] Mostrando notificação:', reminder.title);
  
  const options = {
    body: reminder.description || 'Hora do seu lembrete!',
    icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="45" fill="%23667eea"/%3E%3Ctext x="50" y="70" font-size="60" text-anchor="middle" fill="white"%3E📝%3C/text%3E%3C/svg%3E',
    badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="45" fill="%23667eea"/%3E%3Ctext x="50" y="70" font-size="60" text-anchor="middle" fill="white"%3E🔔%3C/text%3E%3C/svg%3E',
    vibrate: [200, 100, 200, 100, 200, 100, 200],
    requireInteraction: true,
    silent: false,
    tag: 'reminder-' + reminder.id,
    renotify: true,
    data: { 
      reminderId: reminder.id,
      url: './'
    },
    actions: [
      { action: 'complete', title: '✓ Concluir', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext x="50" y="70" font-size="60" text-anchor="middle"%3E✓%3C/text%3E%3C/svg%3E' },
      { action: 'snooze', title: '⏰ Adiar 5min', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext x="50" y="70" font-size="60" text-anchor="middle"%3E⏰%3C/text%3E%3C/svg%3E' }
    ]
  };
  
  return self.registration.showNotification('⏰ ' + reminder.title, options);
}

// Clique na notificação
self.addEventListener('notificationclick', event => {
  console.log('[SW] Clique na notificação:', event.action);
  const reminderId = event.notification.data ? event.notification.data.reminderId : null;
  
  event.notification.close();
  
  if (event.action === 'snooze' && reminderId) {
    // Adiar 5 minutos
    event.waitUntil(
      notifyApp('SNOOZE_REMINDER', { reminderId: reminderId, minutes: 5 })
    );
  } else if (event.action === 'complete' && reminderId) {
    // Concluir lembrete
    event.waitUntil(
      notifyApp('COMPLETE_REMINDER', { reminderId: reminderId })
    );
  } else {
    // Clique normal - abrir app
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        // Se já existe uma janela aberta, focar nela
        for (let client of clientList) {
          if (client.url.includes(self.registration.scope) && 'focus' in client) {
            return client.focus();
          }
        }
        // Se não, abrir nova janela
        if (clients.openWindow) {
          return clients.openWindow('./');
        }
      })
    );
  }
});

// Notificar o app principal
function notifyApp(type, data) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    if (clientList.length > 0) {
      // App está aberto - enviar mensagem
      clientList.forEach(client => {
        client.postMessage({ type: type, ...data });
      });
    } else {
      // App está fechado - abrir e enviar mensagem
      return clients.openWindow('./').then(client => {
        return new Promise(resolve => {
          setTimeout(() => {
            client.postMessage({ type: type, ...data });
            resolve();
          }, 1000);
        });
      });
    }
  });
}

// Agendar próxima verificação
function scheduleNextCheck() {
  if (remindersData.length === 0) return;
  
  const now = new Date().getTime();
  let nextCheck = null;
  
  remindersData.forEach(reminder => {
    if (reminder.nextExecutions) {
      reminder.nextExecutions.forEach(exec => {
        const execTime = new Date(exec.time).getTime();
        if (execTime > now && (!nextCheck || execTime < nextCheck)) {
          nextCheck = execTime;
        }
      });
    }
  });
  
  if (nextCheck) {
    const delay = nextCheck - now;
    console.log('[SW] Próxima verificação em:', Math.round(delay / 1000), 'segundos');
  }
}

// Verificar lembretes periodicamente
setInterval(() => {
  if (remindersData.length === 0) return;
  
  const now = new Date();
  console.log('[SW] Verificando lembretes...', now.toLocaleTimeString());
  
  remindersData.forEach(reminder => {
    if (reminder.completed) return;
    
    if (reminder.nextExecutions) {
      reminder.nextExecutions.forEach(execution => {
        const execTime = new Date(execution.time);
        if (!execution.notified && execTime <= now) {
          console.log('[SW] Lembrete vencido encontrado:', reminder.title);
          execution.notified = true;
          showNotification(reminder);
          
          // Notificar app se estiver aberto
          clients.matchAll({ type: 'window' }).then(clientList => {
            clientList.forEach(client => {
              client.postMessage({
                type: 'REMINDER_TRIGGERED',
                reminderId: reminder.id
              });
            });
          });
        }
      });
    }
  });
}, 10000); // Verificar a cada 10 segundos

console.log('[SW] Service Worker carregado e ativo!');
