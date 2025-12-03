const CACHE_NAME = 'lembretes-v2';
const urlsToCache = [
  './',
  './index.html'
];

let storedReminders = [];
let checkInterval = null;
let wakeLock = null;

// Instalar Service Worker
self.addEventListener('install', event => {
  console.log('🔧 SW: Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Ativar Service Worker
self.addEventListener('activate', event => {
  console.log('✅ SW: Ativando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
  
  // Iniciar verificação periódica imediatamente
  startPeriodicCheck();
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
  console.log('📨 SW: Mensagem recebida:', event.data.type);
  
  if (event.data && event.data.type === 'UPDATE_REMINDERS') {
    storedReminders = event.data.reminders || [];
    console.log('📝 SW: Lembretes atualizados:', storedReminders.length);
    
    // Reiniciar verificação com novos lembretes
    startPeriodicCheck();
    
  } else if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    // Mostrar notificação imediatamente
    showNotification(event.data.reminder);
    
  } else if (event.data && event.data.type === 'CLOSE_NOTIFICATION') {
    // Fechar notificação específica
    const reminderId = event.data.reminderId;
    const tag = 'reminder-' + reminderId;
    
    self.registration.getNotifications({ tag: tag }).then(notifications => {
      notifications.forEach(notification => {
        console.log('🚫 SW: Fechando notificação:', tag);
        notification.close();
      });
    });
    
  } else if (event.data && event.data.type === 'KEEP_ALIVE') {
    // Responder ao ping de keep-alive
    event.ports[0].postMessage({ type: 'ALIVE' });
  }
});

// Iniciar verificação periódica em segundo plano
function startPeriodicCheck() {
  // Limpar intervalo anterior
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  
  // Verificar a cada 5 segundos (ainda mais frequente)
  checkInterval = setInterval(() => {
    checkRemindersInBackground();
  }, 5000);
  
  // Verificar imediatamente
  checkRemindersInBackground();
  
  // Manter uma verificação extra a cada 30 segundos como backup
  setInterval(() => {
    checkRemindersInBackground();
  }, 30000);
  
  console.log('⏰ SW: Verificação periódica iniciada (5s + backup 30s)');
}

// Verificar lembretes em segundo plano
function checkRemindersInBackground() {
  if (!storedReminders || storedReminders.length === 0) {
    return;
  }
  
  const now = new Date();
  
  storedReminders.forEach(reminder => {
    if (reminder.completed) return;
    
    // Compatibilidade retroativa
    if (!reminder.nextExecutions && reminder.time) {
      const reminderTime = new Date(reminder.time);
      if (!reminder.notified && reminderTime <= now) {
        console.log('🔔 SW: Lembrete vencido (antigo):', reminder.title);
        showNotification(reminder);
        notifyApp(reminder.id);
      }
      return;
    }
    
    // Novo sistema com múltiplos horários
    if (reminder.nextExecutions) {
      reminder.nextExecutions.forEach(execution => {
        const execTime = new Date(execution.time);
        if (!execution.notified && execTime <= now) {
          console.log('🔔 SW: Lembrete vencido (novo):', reminder.title);
          showNotification(reminder);
          notifyApp(reminder.id);
        }
      });
    }
  });
}

// Mostrar notificação nativa
function showNotification(reminder) {
  const options = {
    body: reminder.description || 'Hora do seu lembrete!',
    icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="45" fill="%23667eea"/%3E%3Ctext x="50" y="75" font-size="60" text-anchor="middle" fill="white"%3E📝%3C/text%3E%3C/svg%3E',
    badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="45" fill="%23667eea"/%3E%3Ctext x="50" y="75" font-size="60" text-anchor="middle" fill="white"%3E🔔%3C/text%3E%3C/svg%3E',
    vibrate: [300, 100, 300, 100, 300, 100, 300],
    requireInteraction: true, // CRÍTICO: mantém a notificação até o usuário interagir
    tag: 'reminder-' + reminder.id,
    renotify: true, // Notifica novamente mesmo se já existir
    silent: false,
    data: { 
      reminderId: reminder.id,
      timestamp: Date.now()
    },
    actions: [
      { action: 'complete', title: '✓ Concluir' },
      { action: 'snooze', title: '⏰ +5min' }
    ]
  };
  
  // Fechar notificação anterior do mesmo lembrete antes de mostrar nova
  self.registration.getNotifications({ tag: 'reminder-' + reminder.id }).then(notifications => {
    notifications.forEach(n => n.close());
  }).then(() => {
    // Mostrar nova notificação
    return self.registration.showNotification('⏰ ' + reminder.title, options);
  }).then(() => {
    console.log('✅ SW: Notificação exibida:', reminder.title);
    
    // Agendar re-notificação após 3 minutos se não interagir (backup)
    setTimeout(() => {
      self.registration.getNotifications({ tag: 'reminder-' + reminder.id }).then(notifications => {
        if (notifications.length > 0) {
          // Notificação ainda está lá, re-notificar
          self.registration.showNotification('⏰ LEMBRETE: ' + reminder.title, options);
          console.log('🔁 SW: Re-notificação enviada:', reminder.title);
        }
      });
    }, 3 * 60 * 1000);
  }).catch(err => {
    console.error('❌ SW: Erro ao exibir notificação:', err);
  });
}

// Notificar o app sobre lembrete disparado
function notifyApp(reminderId) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'REMINDER_TRIGGERED',
        reminderId: reminderId
      });
    });
  });
}

// Tratar cliques na notificação
self.addEventListener('notificationclick', event => {
  console.log('👆 SW: Clique na notificação:', event.action);
  
  const reminderId = event.notification.data ? event.notification.data.reminderId : null;
  event.notification.close();
  
  if (event.action === 'snooze' && reminderId) {
    console.log('⏰ SW: Adiando lembrete:', reminderId);
    
    // Enviar mensagem para o app adiar E fechar modal
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        if (clientList.length > 0) {
          // App está aberto - enviar mensagem
          clientList.forEach(client => {
            client.postMessage({
              type: 'SNOOZE_REMINDER',
              reminderId: reminderId,
              minutes: 5,
              closeModal: true // IMPORTANTE: fechar modal quando vier da notificação
            });
          });
        } else {
          // App está fechado - abrir e enviar mensagem
          return self.clients.openWindow('/').then(client => {
            setTimeout(() => {
              client.postMessage({
                type: 'SNOOZE_REMINDER',
                reminderId: reminderId,
                minutes: 5,
                closeModal: true
              });
            }, 1000);
          });
        }
      })
    );
    
  } else if (event.action === 'complete' && reminderId) {
    console.log('✅ SW: Concluindo lembrete:', reminderId);
    
    // Enviar mensagem para o app concluir E fechar modal
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        if (clientList.length > 0) {
          // App está aberto - enviar mensagem
          clientList.forEach(client => {
            client.postMessage({
              type: 'COMPLETE_REMINDER',
              reminderId: reminderId,
              closeModal: true // IMPORTANTE: fechar modal quando vier da notificação
            });
          });
        } else {
          // App está fechado - abrir e enviar mensagem
          return self.clients.openWindow('/').then(client => {
            setTimeout(() => {
              client.postMessage({
                type: 'COMPLETE_REMINDER',
                reminderId: reminderId,
                closeModal: true
              });
            }, 1000);
          });
        }
      })
    );
    
  } else {
    // Clique normal - apenas abrir o app
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clientList => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
      })
    );
  }
});

// Manter SW ativo usando Background Sync API
self.addEventListener('sync', event => {
  console.log('🔄 SW: Background sync:', event.tag);
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkRemindersInBackground());
  }
});

// Periodic Background Sync (se disponível)
self.addEventListener('periodicsync', event => {
  console.log('🔄 SW: Periodic sync:', event.tag);
  if (event.tag === 'check-reminders-periodic') {
    event.waitUntil(checkRemindersInBackground());
  }
});

// Push notification (mesmo sem servidor push, ajuda a manter o SW vivo)
self.addEventListener('push', event => {
  console.log('📬 SW: Push recebido');
  event.waitUntil(checkRemindersInBackground());
});

// Manter o SW vivo com múltiplas estratégias
setInterval(() => {
  fetch('/?keepalive=' + Date.now()).catch(() => {});
}, 25000); // A cada 25 segundos

// Estratégia adicional: auto-mensagem a cada 15 segundos
setInterval(() => {
  self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
    if (clients.length > 0) {
      checkRemindersInBackground();
    }
  });
}, 15000);

// Estratégia 3: Re-registrar periodicsync a cada 5 minutos
setInterval(async () => {
  try {
    await self.registration.sync.register('check-reminders');
  } catch (err) {
    console.log('⚠️ Sync re-register falhou:', err);
  }
}, 5 * 60 * 1000);

console.log('🚀 SW: Service Worker carregado com estratégias de sobrevivência');
