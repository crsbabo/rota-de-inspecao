// scripts/enviar-notificacoes.js
// Executado pelo GitHub Actions todo dia útil às 07:35 BRT
// Envia Push Notifications via FCM para técnicos com inspeções pendentes

const admin = require('firebase-admin');

// Carrega credenciais do Secret do GitHub (variável de ambiente segura)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

const APP_SECRET_KEY = 'sulcorte_inspec_2026';

async function main() {
  const hoje = new Date();
  // Ajusta para horário de Brasília (UTC-3)
  const hojeUTC3 = new Date(hoje.getTime() - 3 * 60 * 60 * 1000);
  const diaSemana = hojeUTC3.getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb
  const hojeStr = hojeUTC3.toISOString().split('T')[0];

  console.log(`▶️  Executando verificação para ${hojeStr} (dia da semana: ${diaSemana})`);

  // Se hoje for Segunda-feira, inclui Sábado e Domingo anteriores
  const datasParaVerificar = [hojeStr];
  if (diaSemana === 1) {
    const sabado = new Date(hojeUTC3);
    sabado.setDate(hojeUTC3.getDate() - 2);
    const domingo = new Date(hojeUTC3);
    domingo.setDate(hojeUTC3.getDate() - 1);
    datasParaVerificar.push(sabado.toISOString().split('T')[0]);
    datasParaVerificar.push(domingo.toISOString().split('T')[0]);
    console.log(`📅 Segunda-feira: verificando também ${datasParaVerificar.slice(1).join(' e ')}`);
  }

  // Buscar todas as atividades do Firestore
  const activitiesSnap = await db
    .collection('activities')
    .where('appSecretKey', '==', APP_SECRET_KEY)
    .get();

  if (activitiesSnap.empty) {
    console.log('ℹ️  Nenhuma atividade encontrada no banco.');
    return;
  }

  // Filtrar atividades pendentes (vencidas ou que vencem nas datas verificadas)
  const pendentes = activitiesSnap.docs
    .map(d => d.data())
    .filter(a => a.nextDueDate && datasParaVerificar.some(d => a.nextDueDate <= d));

  console.log(`📋 Atividades pendentes encontradas: ${pendentes.length}`);

  if (pendentes.length === 0) {
    console.log('✅ Nenhuma atividade pendente. Nenhuma notificação enviada.');
    return;
  }

  // Agrupar atividades por técnico responsável
  const porTecnico = {};
  for (const atividade of pendentes) {
    const tecnicos = atividade.assignedTo || [];
    for (const tecnico of tecnicos) {
      if (!porTecnico[tecnico]) porTecnico[tecnico] = [];
      porTecnico[tecnico].push(atividade.title);
    }
  }

  // Buscar técnicos com FCM Token registrado
  const usersSnap = await db
    .collection('users')
    .where('appSecretKey', '==', APP_SECRET_KEY)
    .where('role', '==', 'tecnico')
    .get();

  let totalEnviados = 0;
  const erros = [];

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();

    if (!user.fcmToken) {
      console.log(`⏭️  ${user.username}: sem FCM Token cadastrado (notificações não ativadas).`);
      continue;
    }
    if (!porTecnico[user.username]) {
      console.log(`✅ ${user.username}: sem pendências para hoje.`);
      continue;
    }

    const atividades = porTecnico[user.username];
    const quantidade = atividades.length;
    const listaStr = atividades.slice(0, 3).join(', ') +
      (quantidade > 3 ? ` e mais ${quantidade - 3} atividade(s)...` : '');

    const titulo = `⚠️ Inspeção Pendente (${quantidade} ${quantidade === 1 ? 'atividade' : 'atividades'})`;

    const mensagem = {
      token: user.fcmToken,
      notification: {
        title: titulo,
        body: listaStr,
      },
      webpush: {
        notification: {
          icon: 'https://crsbabo.github.io/rota-de-inspecao/icon.svg',
          badge: 'https://crsbabo.github.io/rota-de-inspecao/icon.svg',
          requireInteraction: true,
          tag: 'inspecao-diaria',
          vibrate: [200, 100, 200],
        },
        fcmOptions: {
          link: 'https://crsbabo.github.io/rota-de-inspecao/',
        },
      },
    };

    try {
      await messaging.send(mensagem);
      console.log(`📱 Notificação enviada para ${user.name || user.username}: "${listaStr}"`);
      totalEnviados++;
    } catch (err) {
      console.error(`❌ Erro ao enviar para ${user.username}:`, err.message);
      erros.push(user.username);

      // Se o token expirou/inválido, remove do Firestore para evitar erros futuros
      if (err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token') {
        await db.collection('users').doc(user.username).update({ fcmToken: null });
        console.log(`🗑️  Token inválido removido para ${user.username}.`);
      }
    }
  }

  console.log(`\n🏁 Concluído: ${totalEnviados} notificação(ões) enviada(s). Erros: ${erros.length > 0 ? erros.join(', ') : 'nenhum'}.`);
}

main().catch(err => {
  console.error('💥 Erro fatal no script:', err);
  process.exit(1);
});
