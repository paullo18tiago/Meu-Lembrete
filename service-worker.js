const CACHE_NAME = 'lembretes-v3';
const urlsToCache = [
  './',
  './index.html'
];

let storedReminders = [];
let checkInterval = null;
let wakeLock = null;

// Cache local para lembretes (IndexedDB seria ideal, mas vamos usar variável global)
const DB_NAME = 'reminders-db';
const DB_VERSION = 1;
let db = null;

// Inicializar IndexedDB para persistir lembretes no SW
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      console.log('✅ SW: IndexedDB inicializado');
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('reminders')) {
        db.createObjectStore('reminders', { keyPath: 'id' });
        console.log('✅ SW: ObjectStore criado');
      }
    };
  });
}

// Carregar lembretes do IndexedDB
async function loadRemindersFromDB() {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['reminders'], 'readonly');
    const store = transaction.objectStore('reminders');
    const request = store.getAll();
    
    request.onsuccess = () => {
      storedReminders = request.result || [];
      console.log('📥 SW: Lembretes carregados do DB:', storedReminders.length);
      
      if (storedReminders.length > 0) {
        console.log('📋 SW: IDs dos lembretes:', storedReminders.map(r => `${r.id} (${r.title})`).join(', '));
      }
      
      resolve(storedReminders);
    };
    
    request.onerror = () => reject(request.error);
  });
}

// Salvar lembretes no IndexedDB E localStorage
async function saveRemindersToDB(reminders) {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['reminders'], 'readwrite');
    const store = transaction.objectStore('reminders');
    
    // Limpar store
    store.clear();
    
    // Adicionar todos os lembretes
    reminders.forEach(reminder => {
      store.put(reminder);
    });
    
    transaction.oncomplete = async () => {
      console.log('💾 SW: Lembretes salvos no DB');
      
      // TAMBÉM salvar no localStorage para sincronizar com o app
      try {
        // Buscar todos os clients (abas abertas do app)
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        
        if (clients.length > 0) {
          // Se há clients abertos, pedir para eles salvarem no localStorage
          clients.forEach(client => {
            client.postMessage({
              type: 'SYNC_REMINDERS_TO_LOCALSTORAGE',
              reminders: reminders
            });
          });
          console.log('📤 SW: Pedido de sincronização enviado aos clients');
        }
      } catch (err) {
        console.log('⚠️ SW: Erro ao sincronizar com clients:', err);
      }
      
      resolve();
    };
    
    transaction.onerror = () => reject(transaction.error);
  });
}

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
    Promise.all([
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          })
        );
      }),
      initDB().then(() => loadRemindersFromDB())
    ]).then(() => {
      self.clients.claim();
      // Iniciar verificação periódica imediatamente
      startPeriodicCheck();
    })
  );
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
    
    // Salvar no IndexedDB para persistir
    saveRemindersToDB(storedReminders).then(() => {
      // Reiniciar verificação com novos lembretes
      startPeriodicCheck();
    });
    
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
    
  } else if (event.data && event.data.type === 'DEBUG_REQUEST') {
    // Responder com lembretes para debug
    loadRemindersFromDB().then(() => {
      event.ports[0].postMessage({ 
        type: 'DEBUG_RESPONSE',
        reminders: storedReminders
      });
    });
  }
});

// Iniciar verificação periódica em segundo plano
function startPeriodicCheck() {
  // Limpar intervalo anterior
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  
  // Carregar lembretes do DB antes de iniciar
  loadRemindersFromDB().then(() => {
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
  });
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

// Tratar cliques na notificação - PROCESSAR DIRETO NO SW
self.addEventListener('notificationclick', event => {
  console.log('👆 SW: Clique na notificação:', event.action);
  
  const reminderId = event.notification.data ? event.notification.data.reminderId : null;
  event.notification.close();
  
  if (event.action === 'snooze' && reminderId) {
    console.log('⏰ SW: Adiando lembrete DIRETO no SW:', reminderId);
    
    // PROCESSAR ADIAR DIRETO NO SERVICE WORKER (não depende do app)
    event.waitUntil(
      snoozeReminderInSW(reminderId, 5).then(() => {
        // Notificar o app SE estiver aberto
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
          if (clientList.length > 0) {
            clientList.forEach(client => {
              client.postMessage({
                type: 'SNOOZE_REMINDER',
                reminderId: reminderId,
                minutes: 5,
                closeModal: true
              });
            });
          }
        });
      })
    );
    
  } else if (event.action === 'complete' && reminderId) {
    console.log('✅ SW: Concluindo lembrete DIRETO no SW:', reminderId);
    
    // PROCESSAR CONCLUSÃO DIRETO NO SERVICE WORKER
    event.waitUntil(
      completeReminderInSW(reminderId).then(() => {
        // Notificar o app SE estiver aberto
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
          if (clientList.length > 0) {
            clientList.forEach(client => {
              client.postMessage({
                type: 'COMPLETE_REMINDER',
                reminderId: reminderId,
                closeModal: true
              });
            });
          }
        });
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

// Adiar lembrete DIRETO no Service Worker (sem depender do app)
async function snoozeReminderInSW(reminderId, minutes) {
  console.log('⏰ SW: Processando adiar:', reminderId, minutes, 'min');
  
  // Carregar lembretes do DB
  await loadRemindersFromDB();
  
  const reminder = storedReminders.find(r => r.id === reminderId);
  if (!reminder) {
    console.log('❌ SW: Lembrete não encontrado:', reminderId);
    console.log('📋 SW: Lembretes disponíveis:', storedReminders.map(r => r.id));
    return;
  }
  
  console.log('📝 SW: Lembrete ANTES de adiar:', JSON.stringify(reminder, null, 2));
  
  // Adiar todas as execuções pendentes
  if (!reminder.nextExecutions && reminder.time) {
    // Formato antigo
    const oldTime = new Date(reminder.time);
    const newTime = new Date(reminder.time);
    newTime.setMinutes(newTime.getMinutes() + minutes);
    reminder.time = newTime;
    reminder.notified = false;
    
    console.log('⏰ SW: Formato antigo - De', oldTime.toLocaleTimeString(), 'para', newTime.toLocaleTimeString());
  } else if (reminder.nextExecutions) {
    // Novo formato
    reminder.nextExecutions = reminder.nextExecutions.map(exec => {
      const execTime = new Date(exec.time);
      if (execTime <= new Date()) {
        const oldTime = new Date(exec.time);
        const newTime = new Date(exec.time);
        newTime.setMinutes(newTime.getMinutes() + minutes);
        
        console.log('⏰ SW: Execução adiada - De', oldTime.toLocaleTimeString(), 'para', newTime.toLocaleTimeString());
        
        return {
          ...exec,
          time: newTime,
          notified: false
        };
      }
      return exec;
    });
  }
  
  console.log('📝 SW: Lembrete DEPOIS de adiar:', JSON.stringify(reminder, null, 2));
  
  // Salvar no DB (isso também sincroniza com localStorage via mensagem)
  await saveRemindersToDB(storedReminders);
  
  console.log('✅ SW: Lembrete adiado e salvo no DB + enviado para sincronização');
  
  // Reagendar verificação
  startPeriodicCheck();
}

// Concluir lembrete DIRETO no Service Worker
async function completeReminderInSW(reminderId) {
  console.log('✅ SW: Processando conclusão:', reminderId);
  
  // Carregar lembretes do DB
  await loadRemindersFromDB();
  
  const reminder = storedReminders.find(r => r.id === reminderId);
  if (!reminder) {
    console.log('❌ SW: Lembrete não encontrado:', reminderId);
    return;
  }
  
  // Verificar se tem recorrência
  if (!reminder.schedules || !reminder.nextExecutions) {
    // Formato antigo ou sem recorrência - apenas marcar como concluído
    reminder.completed = true;
  } else {
    // Novo sistema: Recalcular todas as próximas execuções
    let hasMoreExecutions = false;
    
    reminder.nextExecutions = reminder.schedules.map((schedule, index) => {
      const currentExec = reminder.nextExecutions.find(e => e.scheduleIndex === index);
      
      // Se já passou, calcular próxima
      if (currentExec && new Date(currentExec.time) <= new Date()) {
        const nextTime = calculateNextRecurrenceForSchedule(schedule, new Date(currentExec.time));
        
        if (nextTime) {
          hasMoreExecutions = true;
          return {
            scheduleIndex: index,
            time: nextTime,
            notified: false
          };
        }
      } else if (currentExec) {
        // Ainda não passou, manter
        hasMoreExecutions = true;
        return currentExec;
      }
      
      return null;
    }).filter(e => e !== null);
    
    if (!hasMoreExecutions) {
      reminder.completed = true;
    }
  }
  
  // Salvar no DB
  await saveRemindersToDB(storedReminders);
  
  console.log('✅ SW: Lembrete processado e salvo no DB');
  
  // Reagendar verificação
  startPeriodicCheck();
}

// Calcular próxima recorrência (copiado do index.html)
function calculateNextRecurrenceForSchedule(schedule, currentTime) {
  if (schedule.scheduleType === 'specific') {
    if (schedule.recurrenceType === 'none') return null;
    
    const nextTime = getNextRecurrence(currentTime, schedule.recurrenceType);
    if (schedule.recurrenceEnd && nextTime > new Date(schedule.recurrenceEnd)) {
      return null;
    }
    return nextTime;
    
  } else if (schedule.scheduleType === 'interval') {
    const nextTime = new Date(currentTime);
    
    if (schedule.intervalUnit === 'minutes') {
      nextTime.setMinutes(nextTime.getMinutes() + schedule.intervalValue);
    } else if (schedule.intervalUnit === 'hours') {
      nextTime.setHours(nextTime.getHours() + schedule.intervalValue);
    } else if (schedule.intervalUnit === 'days') {
      nextTime.setDate(nextTime.getDate() + schedule.intervalValue);
    }
    
    if (schedule.intervalEnd && nextTime > new Date(schedule.intervalEnd)) {
      return null;
    }
    return nextTime;
    
  } else if (schedule.scheduleType === 'complex') {
    return calculateNextComplexTime(schedule);
  }
  
  return null;
}

// Calcular próxima recorrência simples
function getNextRecurrence(currentDate, type) {
  const next = new Date(currentDate);
  
  switch(type) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
  }
  
  return next;
}

// Calcular próximo horário complexo
function calculateNextComplexTime(schedule) {
  const now = new Date();
  
  if (schedule.type === 'time') {
    return new Date(schedule.time);
  } else if (schedule.type === 'daily') {
    const [hours, minutes] = schedule.time.split(':');
    const next = new Date();
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  } else if (schedule.type === 'weekly') {
    const [hours, minutes] = schedule.time.split(':');
    const currentDay = now.getDay();
    
    let daysUntilNext = 7;
    for (let day of schedule.weekdays.sort()) {
      const diff = day - currentDay;
      if (diff > 0 || (diff === 0 && now.getHours() * 60 + now.getMinutes() < parseInt(hours) * 60 + parseInt(minutes))) {
        daysUntilNext = diff > 0 ? diff : 0;
        break;
      }
    }
    
    if (daysUntilNext === 7) {
      daysUntilNext = 7 - currentDay + schedule.weekdays[0];
    }
    
    const next = new Date(now);
    next.setDate(next.getDate() + daysUntilNext);
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    return next;
  } else if (schedule.type === 'monthly') {
    const [hours, minutes] = schedule.time.split(':');
    const next = new Date();
    next.setDate(schedule.day);
    next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }
  
  return new Date();
}

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
