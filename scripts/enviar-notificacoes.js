// Executado pelo GitHub Actions em tentativas redundantes nos dias úteis.
// O Firestore impede reenvios da mesma notificação no mesmo dia.

const admin = require('firebase-admin');
const {
  getDateInTimeZone,
  getPendingActivities,
  hashToken,
  summarizeActivities
} = require('./notification-utils');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

async function loadRecipients(usersSnapshot) {
  const candidates = [];

  usersSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.fcmToken) {
      candidates.push({
        username: doc.id,
        token: data.fcmToken,
        updatedAt: data.fcmTokenUpdatedAt || '',
        source: 'legacy',
        ref: doc.ref
      });
    }
  });

  const devicesSnapshot = await db.collection('notificationDevices').get();
  devicesSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.token && data.username) {
      candidates.push({
        username: data.username,
        token: data.token,
        updatedAt: data.updatedAt || '',
        source: 'device',
        ref: doc.ref
      });
    }
  });

  // A token represents one physical browser. Device records take priority over
  // legacy user fields, and the most recently updated owner wins.
  candidates.sort((left, right) => {
    if (left.source !== right.source) return left.source === 'device' ? 1 : -1;
    return left.updatedAt.localeCompare(right.updatedAt);
  });

  const byToken = new Map();
  for (const candidate of candidates) byToken.set(candidate.token, candidate);
  return [...byToken.values()];
}

async function claimDelivery(deliveryRef, details) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(deliveryRef);
    if (snapshot.exists) return false;
    transaction.create(deliveryRef, {
      ...details,
      status: 'sending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  });
}

async function clearInvalidRecipient(recipient) {
  if (recipient.source === 'device') {
    await recipient.ref.delete();
    return;
  }
  await recipient.ref.set({ fcmToken: null, fcmTokenUpdatedAt: null }, { merge: true });
}

async function main() {
  const { dateKey: todayKey, weekday } = getDateInTimeZone();
  const testUsername = (process.env.TEST_USERNAME || '').trim().toLowerCase();
  const isTest = Boolean(testUsername);
  console.log(`▶️ Executando verificação para ${todayKey} (${weekday}, America/Sao_Paulo)`);
  if (isTest) console.log(`🧪 Modo de teste direcionado para '${testUsername}'.`);

  const [usersSnapshot, activitiesSnapshot] = await Promise.all([
    db.collection('users').get(),
    db.collection('activities').get()
  ]);

  const recipients = await loadRecipients(usersSnapshot);
  const allActivities = activitiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const pending = getPendingActivities(allActivities, todayKey);
  console.log(`👥 Destinos únicos: ${recipients.length}`);
  console.log(`📌 Atividades de hoje ou atrasadas: ${pending.length}`);

  const byTechnician = {};
  for (const activity of pending) {
    for (const username of activity.assignedTo || []) {
      if (!byTechnician[username]) byTechnician[username] = [];
      byTechnician[username].push(activity);
    }
  }

  let sent = 0;
  let skipped = 0;

  for (const recipient of recipients) {
    if (isTest && recipient.username.toLowerCase() !== testUsername) continue;

    const activities = byTechnician[recipient.username] || [];
    if (!isTest && activities.length === 0) continue;

    const summary = summarizeActivities(activities, todayKey);
    let title = summary.overdue.length > 0
      ? `⚠️ Inspeções pendentes (${summary.total})`
      : `📅 Inspeções programadas para hoje (${summary.total})`;
    const names = activities.slice(0, 3).map(activity => activity.title || 'Inspeção');
    const detail = summary.overdue.length > 0
      ? `${summary.overdue.length} em atraso e ${summary.dueToday.length} para hoje. `
      : '';
    let body = detail + names.join(', ') + (summary.total > 3 ? ` e mais ${summary.total - 3}...` : '');

    if (isTest) {
      title = summary.total > 0 ? `🧪 TESTE — ${title}` : '🧪 TESTE — Rota de Inspeção';
      body = summary.total > 0
        ? body
        : 'Simulação do alerta matinal. No momento não há atividades pendentes para este usuário.';
    }

    const tokenHash = hashToken(recipient.token);
    const deliveryRef = db.collection('notificationDeliveries')
      .doc(`${todayKey}_${tokenHash}`);
    if (!isTest) {
      const claimed = await claimDelivery(deliveryRef, {
        dateKey: todayKey,
        username: recipient.username,
        tokenHash,
        activityIds: activities.map(activity => activity.id)
      });

      if (!claimed) {
        skipped++;
        console.log(`↩️ Envio já processado hoje para '${recipient.username}'.`);
        continue;
      }
    }

    const message = {
      token: recipient.token,
      notification: { title, body },
      data: {
        title,
        body,
        url: 'https://crsbabo.github.io/rota-de-inspecao/'
      },
      webpush: {
        notification: {
          title,
          body,
          icon: 'https://crsbabo.github.io/rota-de-inspecao/icon.svg',
          badge: 'https://crsbabo.github.io/rota-de-inspecao/icon.svg',
          requireInteraction: true,
          tag: `inspecao-diaria-${todayKey}`,
          vibrate: [200, 100, 200]
        },
        fcmOptions: { link: 'https://crsbabo.github.io/rota-de-inspecao/' }
      }
    };

    try {
      const messageId = await messaging.send(message);
      if (!isTest) {
        await deliveryRef.set({
          status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          messageId
        }, { merge: true });
      }
      sent++;
      console.log(`✅ FCM aceitou o envio para '${recipient.username}'.`);
    } catch (error) {
      if (!isTest) await deliveryRef.delete();
      console.error(`❌ Erro FCM para '${recipient.username}':`, error.message);
      if (error.code === 'messaging/registration-token-not-registered' ||
          error.code === 'messaging/invalid-registration-token') {
        await clearInvalidRecipient(recipient);
        console.log(`🗑️ Destino inválido removido para '${recipient.username}'.`);
      }
    }
  }

  if (isTest && sent === 0) {
    throw new Error(`Nenhum aparelho registrado foi encontrado para '${testUsername}'.`);
  }

  console.log(`🏁 Concluído: ${sent} enviado(s), ${skipped} duplicado(s) evitado(s).`);
}

main().catch(error => {
  console.error('💥 Erro fatal no script:', error);
  process.exit(1);
});
