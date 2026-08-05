// scripts/enviar-notificacoes.js
// Executado pelo GitHub Actions todo dia útil às 07:35 BRT
// Envia Push Notifications via FCM para técnicos com inspeções pendentes

const admin = require('firebase-admin');

// Carrega credenciais do Secret do GitHub
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

async function main() {
  const hoje = new Date();
  const hojeUTC3 = new Date(hoje.getTime() - 3 * 60 * 60 * 1000);
  const diaSemana = hojeUTC3.getDay();
  const hojeStr = hojeUTC3.toISOString().split('T')[0];

  console.log(`▶️  Executando verificação para a data: ${hojeStr} (dia da semana: ${diaSemana})`);

  // 1. Buscar todos os usuários
  const usersSnap = await db.collection('users').get();
  console.log(`👥 Total de usuários no Firestore: ${usersSnap.size}`);

  const tecnicosComToken = [];
  usersSnap.forEach(doc => {
    const data = doc.data();
    console.log(`  👤 Usuário '${doc.id}': fcmToken=${data.fcmToken ? 'PRESENTE (' + data.fcmToken.substring(0, 15) + '...)' : 'AUSENTE'}`);
    if (data.fcmToken) {
      tecnicosComToken.push({ username: doc.id, ...data });
    }
  });

  if (tecnicosComToken.length === 0) {
    console.log('⚠️ Nenhum técnico com FCM Token cadastrado no banco.');
    return;
  }

  // 2. Buscar atividades
  const activitiesSnap = await db.collection('activities').get();
  console.log(`📋 Total de atividades no Firestore: ${activitiesSnap.size}`);

  const datasParaVerificar = [hojeStr];
  if (diaSemana === 1) {
    const sabado = new Date(hojeUTC3);
    sabado.setDate(hojeUTC3.getDate() - 2);
    const domingo = new Date(hojeUTC3);
    domingo.setDate(hojeUTC3.getDate() - 1);
    datasParaVerificar.push(sabado.toISOString().split('T')[0]);
    datasParaVerificar.push(domingo.toISOString().split('T')[0]);
  }

  const pendentes = activitiesSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => a.nextDueDate && datasParaVerificar.some(d => a.nextDueDate <= d));

  console.log(`📌 Atividades pendentes identificadas: ${pendentes.length}`);

  const porTecnico = {};
  for (const atividade of pendentes) {
    const tecnicos = atividade.assignedTo || [];
    for (const tecnico of tecnicos) {
      if (!porTecnico[tecnico]) porTecnico[tecnico] = [];
      porTecnico[tecnico].push(atividade.title || 'Inspeção');
    }
  }

  // 3. Enviar notificação para cada técnico cadastrado
  let totalEnviados = 0;
  for (const tecnico of tecnicosComToken) {
    const atividades = porTecnico[tecnico.username] || [];
    const quantidade = atividades.length;

    let titulo = `⚠️ Inspeção Pendente (${quantidade} ${quantidade === 1 ? 'atividade' : 'atividades'})`;
    let texto = atividades.slice(0, 3).join(', ') + (quantidade > 3 ? ` e mais ${quantidade - 3}...` : '');

    // Se não houver atividades vencidas especificamente hoje, envia notificação de confirmação
    if (quantidade === 0) {
      titulo = `🔔 Rota de Inspeção: Sistema Ativo`;
      texto = `Você está registrado para receber alertas de inspeção diários às 07:35h.`;
    }

    console.log(`🚀 Enviando Push para '${tecnico.username}' -> "${titulo}"`);

    const mensagem = {
      token: tecnico.fcmToken,
      notification: {
        title: titulo,
        body: texto,
      },
      data: {
        title: titulo,
        body: texto,
        url: 'https://crsbabo.github.io/rota-de-inspecao/'
      },
      webpush: {
        notification: {
          title: titulo,
          body: texto,
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
      const response = await messaging.send(mensagem);
      console.log(`✅ FCM aceito! ID da mensagem: ${response}`);
      totalEnviados++;
    } catch (err) {
      console.error(`❌ Erro FCM ao enviar para ${tecnico.username}:`, err.message);
      if (err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token') {
        await db.collection('users').doc(tecnico.username).update({ fcmToken: null });
        console.log(`🗑️ Token inválido removido para ${tecnico.username}.`);
      }
    }
  }

  console.log(`\n🏁 Concluído: ${totalEnviados} notificação(ões) enviada(s).`);
}

main().catch(err => {
  console.error('💥 Erro fatal no script:', err);
  process.exit(1);
});
