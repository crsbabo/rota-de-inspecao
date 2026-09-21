/* Application Logic for Rota de Inspeção PWA */

// Global State
let currentUser = null;
let activitiesList = [];
let usersList = [];
let historyList = [];
let html5QrScanner = null;
let currentExecutingActivity = null;
let qrScanProcessing = false;

// Firebase configuration state
let db = null;
let useFirebase = false;
let appServiceWorkerRegistrationPromise = null;

// =====================================================
// FIREBASE CONFIG — conectado automaticamente em
// qualquer dispositivo sem necessidade de configuração
// =====================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAGv6HsPs35R4mUXPqhpLkizy1dNRpkkuU",
  authDomain: "rotas-de-inspecao.firebaseapp.com",
  projectId: "rotas-de-inspecao",
  storageBucket: "rotas-de-inspecao.firebasestorage.app",
  messagingSenderId: "917565341973",
  appId: "1:917565341973:web:326999b01b419b031c291c"
};

// Chave secreta de proteção das regras do Firestore (Opção A)
const APP_SECRET_KEY = 'sulcorte_inspec_2026';

// VAPID Key para Firebase Cloud Messaging (Push Notifications)
const FCM_VAPID_KEY = 'BM790p-_0RTCfUGid5jR817oiY53axShuSrB6wAqR6L_Dfjosgqb5_KQiO-Uy5hKBnzXcPl3rk9DeqLmRCSMazU';

// FCM Messaging instance
let messaging = null;

// Default Mock Data
const DEFAULT_USERS = [
  { username: 'admin', password: '123', name: 'Administrador', role: 'admin', assignments: [] },
  { username: 'cristiano', password: '123', name: 'Cristiano Sbabo', role: 'tecnico', assignments: [] }
];

const DEFAULT_ACTIVITIES = [
  { 
    id: 'act-1', 
    title: 'Inspeção do Compressor Principal', 
    description: '1. Verificar nível de óleo do cárter.\n2. Purgar condensado do reservatório de ar.\n3. Checar ruídos anormais e temperatura de trabalho.\n4. Confirmar se a pressão está regulada entre 6 e 8 bar.', 
    periodicity: 7, // em dias
    qrCode: 'COMP-01',
    assignedTo: ['cristiano'], // usernames dos técnicos
    lastExecuted: null,
    firstDueDate: getFutureDate(0),
    nextDueDate: getFutureDate(0) // Disponível hoje
  },
  { 
    id: 'act-2', 
    title: 'Lubrificação das Guias do Torno', 
    description: '1. Limpar cavacos e resíduos das guias lineares.\n2. Aplicar óleo lubrificante específico nas guias.\n3. Verificar nível do reservatório do lubrificador automático.', 
    periodicity: 3, 
    qrCode: 'TORNO-02',
    assignedTo: ['cristiano'],
    lastExecuted: null,
    firstDueDate: getFutureDate(1),
    nextDueDate: getFutureDate(1) // Disponível amanhã
  }
];

// Helper: Calculate future date
function getFutureDate(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  d.setHours(0,0,0,0);
  return formatDateKey(d);
}

// Date-only values are business dates, not UTC timestamps. Constructing
// `new Date('YYYY-MM-DD')` interprets the value as UTC and shifts it to the
// previous day in Brazil, which made activities due today appear overdue.
function parseDateOnlyLocal(dateStr) {
  if (!dateStr) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDateOverdue(dateStr, referenceDate = new Date()) {
  const dueDate = parseDateOnlyLocal(dateStr);
  if (!dueDate) return false;

  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

// ----------------------------------------------------
// DATABASE & STORAGE LAYER (LocalStorage / Firebase)
// ----------------------------------------------------

// Inicializa Firebase automaticamente com config embutida
function loadFirebaseConfig() {
  try {
    // Verifica se já foi inicializado anteriormente
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    db = firebase.firestore();
    useFirebase = true;
    console.log("Firebase Firestore conectado automaticamente!");

    // Initialize FCM Messaging
    try {
      messaging = firebase.messaging();
      console.log('Firebase Messaging inicializado.');

      // Escutar mensagens quando o aplicativo estiver aberto em primeiro plano
      messaging.onMessage((payload) => {
        console.log('Mensagem Push recebida em 1º plano:', payload);
        const title = payload.notification?.title || payload.data?.title || '⚠️ Inspeção Pendente';
        const body = payload.notification?.body || payload.data?.body || 'Você possui inspeções de manutenção pendentes.';

        if (Notification.permission === 'granted') {
          try {
            new Notification(title, { body: body, icon: './icon.svg' });
          } catch (e) {
            console.warn('Erro ao criar Notification em 1º plano:', e);
          }
        }

        alert(`🔔 NOTIFICAÇÃO PUSH RECEBIDA:\n\n${title}\n${body}`);
      });
    } catch (msgErr) {
      console.warn('Firebase Messaging não disponível neste navegador:', msgErr.message);
      messaging = null;
    }

    const statusEl = document.getElementById('db-status');
    if (statusEl) statusEl.innerHTML = '<span class="badge badge-success">ONLINE</span>';
    return true;
  } catch (e) {
    console.error("Erro ao inicializar Firebase. Usando LocalStorage.", e);
    useFirebase = false;
    const statusEl = document.getElementById('db-status');
    if (statusEl) statusEl.innerHTML = '<span class="badge badge-warning">LOCAL</span>';
    return false;
  }
}

// Check and Initialize Storage
async function initDatabase() {
  loadFirebaseConfig();
  
  if (useFirebase) {
    try {
      // Sync from Firebase
      await syncDataFromFirebase();
    } catch (e) {
      console.error("Erro ao sincronizar com Firebase. Usando fallbacks.", e);
      useFirebase = false;
      document.getElementById('db-status').innerHTML = '<span class="badge badge-warning">LOCAL</span>';
      alert("Erro ao conectar com o Firebase:\n" + e.message + "\n\nO aplicativo continuará funcionando temporariamente em modo Local (LocalStorage). Verifique se as Regras de Segurança (Security Rules) do Firestore estão configuradas para permitir gravação.");
      initLocalStorageFallback();
    }
  } else {
    initLocalStorageFallback();
  }
}

function initLocalStorageFallback() {
  if (!localStorage.getItem('inspec_users')) {
    localStorage.setItem('inspec_users', JSON.stringify(DEFAULT_USERS));
  }
  if (!localStorage.getItem('inspec_activities')) {
    localStorage.setItem('inspec_activities', JSON.stringify(DEFAULT_ACTIVITIES));
  }
  if (!localStorage.getItem('inspec_history')) {
    localStorage.setItem('inspec_history', JSON.stringify([]));
  }
  
  usersList = JSON.parse(localStorage.getItem('inspec_users'));
  activitiesList = JSON.parse(localStorage.getItem('inspec_activities'));
  historyList = JSON.parse(localStorage.getItem('inspec_history'));
}

async function syncDataFromFirebase() {
  // Load Users - filter by security key
  const usersSnapshot = await db.collection('users')
    .where('appSecretKey', '==', APP_SECRET_KEY)
    .get();
  if (usersSnapshot.empty) {
    // Seed default users to Firebase
    for (let u of DEFAULT_USERS) {
      const docData = { ...u, appSecretKey: APP_SECRET_KEY };
      await db.collection('users').doc(u.username).set(docData);
    }
    usersList = [...DEFAULT_USERS];
  } else {
    usersList = usersSnapshot.docs.map(doc => {
      const data = doc.data();
      delete data.appSecretKey;
      return data;
    });
  }

  // Load Activities - filter by security key
  const actSnapshot = await db.collection('activities')
    .where('appSecretKey', '==', APP_SECRET_KEY)
    .get();
  if (actSnapshot.empty) {
    for (let act of DEFAULT_ACTIVITIES) {
      const docData = { ...act, appSecretKey: APP_SECRET_KEY };
      await db.collection('activities').doc(act.id).set(docData);
    }
    activitiesList = [...DEFAULT_ACTIVITIES];
  } else {
    activitiesList = actSnapshot.docs.map(doc => {
      const data = doc.data();
      delete data.appSecretKey;
      return data;
    });
  }

  // Load History - filter by security key (without ordering to avoid Firestore Index errors)
  const histSnapshot = await db.collection('history')
    .where('appSecretKey', '==', APP_SECRET_KEY)
    .get();
  
  // Map and sort in memory by timestamp descending
  historyList = histSnapshot.docs.map(doc => {
    const data = doc.data();
    delete data.appSecretKey;
    return data;
  });
  historyList.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// Generic Save functions
async function saveUsers() {
  try {
    if (useFirebase) {
      for (let u of usersList) {
        const docData = { ...u, appSecretKey: APP_SECRET_KEY };
        await db.collection('users').doc(u.username).set(docData);
      }
    } else {
      localStorage.setItem('inspec_users', JSON.stringify(usersList));
    }
  } catch (e) {
    console.error("Erro ao salvar usuários:", e);
    alert("Erro ao salvar usuário no Firebase:\n" + e.message + "\n\nPor favor, configure as regras de segurança (Security Rules) do seu Firestore para permitir escrita pública.");
    throw e;
  }
}

async function saveActivities() {
  try {
    if (useFirebase) {
      for (let act of activitiesList) {
        const docData = { ...act, appSecretKey: APP_SECRET_KEY };
        await db.collection('activities').doc(act.id).set(docData);
      }
    } else {
      localStorage.setItem('inspec_activities', JSON.stringify(activitiesList));
    }
  } catch (e) {
    console.error("Erro ao salvar atividades:", e);
    alert("Erro ao salvar atividade no Firebase:\n" + e.message + "\n\nPor favor, configure as regras de segurança (Security Rules) do seu Firestore para permitir escrita pública.");
    throw e;
  }
}

async function addHistoryRecord(record) {
  historyList.unshift(record);
  try {
    if (useFirebase) {
      const docData = { ...record, appSecretKey: APP_SECRET_KEY };
      await db.collection('history').add(docData);
    } else {
      localStorage.setItem('inspec_history', JSON.stringify(historyList));
    }
  } catch (e) {
    console.error("Erro ao salvar histórico:", e);
    alert("Erro ao salvar registro de histórico no Firebase:\n" + e.message + "\n\nPor favor, configure as regras de segurança (Security Rules) do seu Firestore para permitir escrita pública.");
    throw e;
  }
}

// ----------------------------------------------------
// ROUTING & NAVIGATION
// ----------------------------------------------------
function showPage(pageId) {
  // If it's an admin sub-page
  if (pageId.startsWith('admin-')) {
    // 1. Ensure the parent admin dashboard is active, hide other top-level pages
    document.querySelectorAll('.page').forEach(page => {
      if (page.id === 'admin-dashboard') {
        page.classList.add('active');
      } else {
        page.classList.remove('active');
      }
    });
    
    // 2. Manage active states on admin sub-pages
    document.querySelectorAll('.admin-sub-page').forEach(subPage => {
      if (subPage.id === pageId) {
        subPage.classList.add('active');
      } else {
        subPage.classList.remove('active');
      }
    });
    
    // Manage sidebar buttons
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      btn.classList.remove('active');
      if (btn.getAttribute('onclick').includes(pageId)) {
        btn.classList.add('active');
      }
    });
  } else {
    // It's a top-level page (login-page, tech-home, tech-execute)
    document.querySelectorAll('.page').forEach(page => {
      if (page.id === pageId) {
        page.classList.add('active');
      } else {
        page.classList.remove('active');
      }
    });
  }

  // Stopping scanner if leaving execution screen
  if (pageId !== 'tech-execute' && html5QrScanner) {
    stopScanner();
  }
}

function updateHeader() {
  const header = document.getElementById('app-header');
  if (!currentUser) {
    header.style.display = 'none';
    return;
  }
  
  header.style.display = 'flex';
  
  const nameEl = document.getElementById('logged-user-name');
  const badgeEl = document.getElementById('logged-user-badge');

  if (currentUser.role === 'admin') {
    badgeEl.style.display = 'flex';
    badgeEl.className = 'user-badge admin';
    badgeEl.innerText = 'Administrador';
    nameEl.style.display = 'none';
    nameEl.innerText = '';
  } else {
    badgeEl.style.display = 'none';
    badgeEl.innerText = '';
    nameEl.style.display = 'none';
    nameEl.innerText = '';
  }
  
  const configBtn = document.getElementById('header-config-btn');
  if (configBtn) {
    configBtn.style.display = 'none';
  }
}

async function logout() {
  const userLeaving = currentUser;
  if (userLeaving && userLeaving.role === 'tecnico') {
    await unregisterCurrentNotificationDevice(userLeaving.username);
  }

  currentUser = null;
  sessionStorage.removeItem('logged_user');
  updateHeader();
  showPage('login-page');
  
  // Reset form inputs
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
}

// ----------------------------------------------------
// AUTHENTICATION LOGIC
// ----------------------------------------------------
async function handleLogin(e) {
  e.preventDefault();
  const userIn = document.getElementById('login-username').value.trim().toLowerCase();
  const passIn = document.getElementById('login-password').value;
  const errorMsg = document.getElementById('login-error');

  errorMsg.style.display = 'none';

  const user = usersList.find(u => u.username === userIn && u.password === passIn);

  if (user) {
    currentUser = user;
    sessionStorage.setItem('logged_user', JSON.stringify(user));
    updateHeader();
    
    if (user.role === 'admin') {
      loadAdminUsers();
      loadAdminActivities();
      showPage('admin-activities');
    } else {
      loadTechnicianActivities();
      showPage('tech-home');
      checkNotificationBanner();
    }
  } else {
    errorMsg.innerText = 'Usuário ou senha incorretos.';
    errorMsg.style.display = 'block';
  }
}

// ----------------------------------------------------
// ADMIN: USER MANAGEMENT
// ----------------------------------------------------
function loadAdminUsers() {
  const container = document.getElementById('users-cards-grid');
  container.innerHTML = '';

  usersList.forEach(user => {
    // Don't show delete options for primary 'admin'
    const isPrimaryAdmin = user.username === 'admin';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title">${user.name}</div>
          <div class="card-meta">@${user.username}</div>
        </div>
        <span class="badge ${user.role === 'admin' ? 'badge-warning' : 'badge-info'}">
          ${user.role === 'admin' ? 'Admin' : 'Técnico'}
        </span>
      </div>
      <div class="card-body">
        <p>Senha de acesso: <code>${user.password}</code></p>
      </div>
      <div class="card-actions" style="${isPrimaryAdmin ? 'display:none;' : ''}">
        <button class="btn btn-secondary btn-sm" onclick="openUserModal('${user.username}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser('${user.username}')">Excluir</button>
      </div>
    `;
    container.innerHTML += card.outerHTML;
  });
}

function openUserModal(username = '') {
  const modal = document.getElementById('user-modal');
  const title = document.getElementById('user-modal-title');
  
  // Clear fields
  document.getElementById('user-username').value = '';
  document.getElementById('user-username').disabled = false;
  document.getElementById('user-name').value = '';
  document.getElementById('user-password').value = '';
  document.getElementById('user-role').value = 'tecnico';
  
  if (username) {
    title.innerText = 'Editar Usuário';
    const user = usersList.find(u => u.username === username);
    if (user) {
      document.getElementById('user-username').value = user.username;
      document.getElementById('user-username').disabled = true; // Username is primary key
      document.getElementById('user-name').value = user.name;
      document.getElementById('user-password').value = user.password;
      document.getElementById('user-role').value = user.role;
    }
  } else {
    title.innerText = 'Novo Usuário';
  }
  
  modal.classList.add('active');
}

function closeUserModal() {
  document.getElementById('user-modal').classList.remove('active');
}

async function saveUserForm(e) {
  e.preventDefault();
  const username = document.getElementById('user-username').value.trim().toLowerCase();
  const name = document.getElementById('user-name').value.trim();
  const password = document.getElementById('user-password').value;
  const role = document.getElementById('user-role').value;

  if (!username || !name || !password) {
    alert("Por favor, preencha todos os campos obrigatórios.");
    return;
  }

  const existingIndex = usersList.findIndex(u => u.username === username);

  if (existingIndex > -1) {
    // Edit
    usersList[existingIndex].name = name;
    usersList[existingIndex].password = password;
    usersList[existingIndex].role = role;
  } else {
    // New
    usersList.push({ username, name, password, role, assignments: [] });
  }

  await saveUsers();
  loadAdminUsers();
  closeUserModal();
}

async function deleteUser(username) {
  if (username === 'admin') {
    alert("O usuário administrador principal não pode ser excluído.");
    return;
  }
  if (confirm(`Tem certeza que deseja excluir o usuário @${username}?`)) {
    const nextUsers = usersList.filter(u => u.username !== username);
    const nextActivities = activitiesList.map(act => ({
      ...act,
      assignedTo: (act.assignedTo || []).filter(u => u !== username)
    }));

    try {
      if (useFirebase) {
        // Delete the user and clean assignments atomically so a partial
        // failure cannot leave a removed user assigned to an activity.
        const batch = db.batch();
        batch.delete(db.collection('users').doc(username));

        nextActivities.forEach((act, index) => {
          const previousAssignments = activitiesList[index].assignedTo || [];
          if (previousAssignments.includes(username)) {
            batch.set(
              db.collection('activities').doc(act.id),
              { ...act, appSecretKey: APP_SECRET_KEY }
            );
          }
        });

        await batch.commit();
      } else {
        localStorage.setItem('inspec_users', JSON.stringify(nextUsers));
        localStorage.setItem('inspec_activities', JSON.stringify(nextActivities));
      }

      usersList = nextUsers;
      activitiesList = nextActivities;
      loadAdminUsers();
    } catch (e) {
      console.error('Erro ao excluir usuário:', e);
      alert('Erro ao excluir usuário:\n' + e.message);
    }
  }
}

// ----------------------------------------------------
// ADMIN: ACTIVITY MANAGEMENT
// ----------------------------------------------------
function loadAdminActivities() {
  const container = document.getElementById('activities-cards-grid');
  container.innerHTML = '';

  activitiesList.forEach(act => {
    // Map technician usernames to names
    const assignedNames = (act.assignedTo || []).map(username => {
      const u = usersList.find(user => user.username === username);
      return u ? u.name : username;
    }).join(', ') || 'Nenhum técnico';

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title">${act.title}</div>
          <div class="card-meta">A cada ${act.periodicity} dias • QR: <strong>${act.qrCode}</strong></div>
        </div>
      </div>
      <div class="card-body">
        <p style="white-space: pre-line; margin-bottom: 0.75rem;">${act.description}</p>
        <div style="font-size: 0.8rem; color: var(--text-secondary);">
          <strong>Atribuído a:</strong> ${assignedNames}
        </div>
        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem;">
          <strong>Próxima Inspeção:</strong> ${act.nextDueDate ? formatDateBR(act.nextDueDate) : 'Pendente'}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="openActivityModal('${act.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteActivity('${act.id}')">Excluir</button>
      </div>
    `;
    container.innerHTML += card.outerHTML;
  });
}

function openActivityModal(id = '') {
  const modal = document.getElementById('activity-modal');
  const title = document.getElementById('activity-modal-title');
  const techContainer = document.getElementById('activity-tech-checkboxes');
  const firstDateInput = document.getElementById('activity-first-date');
  const firstDateHelp = document.getElementById('activity-first-date-help');
  
  // Render technicians checklist
  techContainer.innerHTML = '';
  usersList.filter(u => u.role === 'tecnico').forEach(t => {
    techContainer.innerHTML += `
      <label class="checkbox-item">
        <input type="checkbox" name="assignedTechs" value="${t.username}">
        <span>${t.name} (@${t.username})</span>
      </label>
    `;
  });

  // Clear fields
  document.getElementById('activity-id').value = '';
  document.getElementById('activity-title').value = '';
  document.getElementById('activity-description').value = '';
  document.getElementById('activity-periodicity').value = '';
  firstDateInput.value = getFutureDate(0);
  firstDateInput.disabled = false;
  firstDateInput.required = true;
  firstDateHelp.innerText = 'Após a primeira execução, as próximas datas serão calculadas pela periodicidade.';
  document.getElementById('activity-qrcode').value = '';

  if (id) {
    title.innerText = 'Editar Atividade';
    const act = activitiesList.find(a => a.id === id);
    if (act) {
      document.getElementById('activity-id').value = act.id;
      document.getElementById('activity-title').value = act.title;
      document.getElementById('activity-description').value = act.description;
      document.getElementById('activity-periodicity').value = act.periodicity;
      document.getElementById('activity-qrcode').value = act.qrCode;

      if (act.lastExecuted) {
        // The recurrence cycle has already started, so its next date must keep
        // following the last execution instead of being reset by this form.
        firstDateInput.value = act.firstDueDate || '';
        firstDateInput.disabled = true;
        firstDateInput.required = false;
        firstDateHelp.innerText = 'O ciclo já foi iniciado. A próxima inspeção continua sendo calculada a partir da última execução.';
      } else {
        firstDateInput.value = act.firstDueDate || act.nextDueDate || getFutureDate(0);
      }

      // Select assigned techs
      const checkboxes = document.querySelectorAll('input[name="assignedTechs"]');
      checkboxes.forEach(cb => {
        if (act.assignedTo && act.assignedTo.includes(cb.value)) {
          cb.checked = true;
        }
      });
    }
  } else {
    title.innerText = 'Nova Atividade';
  }

  modal.classList.add('active');
}

function closeActivityModal() {
  document.getElementById('activity-modal').classList.remove('active');
}

async function saveActivityForm(e) {
  e.preventDefault();
  const id = document.getElementById('activity-id').value;
  const title = document.getElementById('activity-title').value.trim();
  const description = document.getElementById('activity-description').value.trim();
  const periodicity = parseInt(document.getElementById('activity-periodicity').value);
  const firstDueDate = document.getElementById('activity-first-date').value;
  const qrCode = document.getElementById('activity-qrcode').value.trim();

  // Get selected techs
  const assignedTo = [];
  document.querySelectorAll('input[name="assignedTechs"]:checked').forEach(cb => {
    assignedTo.push(cb.value);
  });

  const existingActivity = id ? activitiesList.find(a => a.id === id) : null;
  const cycleAlreadyStarted = Boolean(existingActivity && existingActivity.lastExecuted);

  if (!title || !periodicity || !qrCode || (!cycleAlreadyStarted && !firstDueDate)) {
    alert("Por favor, preencha os campos obrigatórios (Título, Periodicidade, Primeira Inspeção e Código QR).");
    return;
  }

  if (firstDueDate && !parseDateOnlyLocal(firstDueDate)) {
    alert('Informe uma data válida para a primeira inspeção.');
    return;
  }

  if (id) {
    // Edit
    const idx = activitiesList.findIndex(a => a.id === id);
    if (idx > -1) {
      activitiesList[idx].title = title;
      activitiesList[idx].description = description;
      activitiesList[idx].periodicity = periodicity;
      activitiesList[idx].qrCode = qrCode;
      activitiesList[idx].assignedTo = assignedTo;
      // Before the first execution, the admin can reschedule the starting
      // date. Once executed, recurrence remains anchored to lastExecuted.
      if (!activitiesList[idx].lastExecuted) {
        activitiesList[idx].firstDueDate = firstDueDate;
        activitiesList[idx].nextDueDate = firstDueDate;
      }
    }
  } else {
    // New
    const newId = 'act-' + Date.now();
    activitiesList.push({
      id: newId,
      title,
      description,
      periodicity,
      qrCode,
      assignedTo,
      lastExecuted: null,
      firstDueDate,
      nextDueDate: firstDueDate
    });
  }

  await saveActivities();
  loadAdminActivities();
  closeActivityModal();
}

async function deleteActivity(id) {
  if (confirm("Tem certeza que deseja excluir esta atividade de inspeção?")) {
    const nextActivities = activitiesList.filter(a => a.id !== id);

    try {
      if (useFirebase) {
        await db.collection('activities').doc(id).delete();
      } else {
        localStorage.setItem('inspec_activities', JSON.stringify(nextActivities));
      }

      activitiesList = nextActivities;
      loadAdminActivities();
    } catch (e) {
      console.error('Erro ao excluir atividade:', e);
      alert('Erro ao excluir atividade:\n' + e.message);
    }
  }
}

// ----------------------------------------------------
// ADMIN: HISTORY LOGS
// ----------------------------------------------------
function loadAdminHistory() {
  const tbody = document.getElementById('history-table-body');
  tbody.innerHTML = '';

  if (historyList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">Nenhum histórico registrado.</td></tr>';
    return;
  }

  historyList.forEach(hist => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(hist.timestamp)}</td>
      <td><strong>${hist.activityTitle}</strong></td>
      <td>${hist.techName}</td>
      <td style="font-style: italic; color: #cbd5e1;">"${hist.comment || '-'}"</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// TECHNICIAN: HOME & FILTERING
// ----------------------------------------------------
function loadTechnicianActivities() {
  const container = document.getElementById('tech-activities-grid');
  container.innerHTML = '';

  // Filter activities assigned to the logged-in technician
  let myActivities = activitiesList.filter(act => 
    act.assignedTo && act.assignedTo.includes(currentUser.username)
  );

  // Apply filters
  const dateFilter = document.getElementById('filter-date').value;
  const periodFilter = document.getElementById('filter-period').value;

  if (dateFilter) {
    // Filter for a specific date (is next due date on or before selected date?)
    const targetDate = parseDateOnlyLocal(dateFilter);
    myActivities = myActivities.filter(act => {
      if (!act.nextDueDate) return true;
      const due = parseDateOnlyLocal(act.nextDueDate);
      return due && targetDate ? due <= targetDate : true;
    });
  } else if (periodFilter && periodFilter !== 'all') {
    const today = new Date();
    today.setHours(0,0,0,0);
    const limitDate = new Date();
    limitDate.setHours(0,0,0,0);

    if (periodFilter === 'today') {
      // Limit to today
      limitDate.setDate(today.getDate());
    } else if (periodFilter === 'week') {
      // Next 7 days
      limitDate.setDate(today.getDate() + 7);
    } else if (periodFilter === 'month') {
      // Next 30 days
      limitDate.setDate(today.getDate() + 30);
    }

    myActivities = myActivities.filter(act => {
      if (!act.nextDueDate) return true;
      const due = parseDateOnlyLocal(act.nextDueDate);
      return due ? due <= limitDate : true;
    });
  }

  if (myActivities.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-secondary);">Nenhuma atividade pendente para os filtros selecionados.</div>';
    return;
  }

  // Sort by nextDueDate
  myActivities.sort((a,b) => new Date(a.nextDueDate) - new Date(b.nextDueDate));

  myActivities.forEach(act => {
    // Check if overdue
    const isOverdue = isDateOverdue(act.nextDueDate);
    
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title">${act.title}</div>
          <div class="card-meta">A cada ${act.periodicity} dias</div>
        </div>
        <span class="badge ${isOverdue ? 'badge-danger' : 'badge-success'}">
          ${isOverdue ? 'Atrasado' : 'No prazo'}
        </span>
      </div>
      <div class="card-body">
        <p style="white-space: pre-line; margin-bottom: 0.75rem;">${act.description.substring(0, 120)}${act.description.length > 120 ? '...' : ''}</p>
        <div style="font-size: 0.85rem; font-weight: 600; color: ${isOverdue ? '#ef4444' : '#60a5fa'};">
          Vence em: ${formatDateBR(act.nextDueDate)}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" onclick="openExecutionPage('${act.id}')">Executar Inspeção</button>
      </div>
    `;
    container.innerHTML += card.outerHTML;
  });
}

function applyTechFilters() {
  loadTechnicianActivities();
}

function clearTechFilters() {
  document.getElementById('filter-date').value = '';
  document.getElementById('filter-period').value = 'all';
  loadTechnicianActivities();
}

// ----------------------------------------------------
// TECHNICIAN: EXECUTE ACTIVITY & QR CODE
// ----------------------------------------------------
function openExecutionPage(id) {
  const act = activitiesList.find(a => a.id === id);
  if (!act) return;

  currentExecutingActivity = act;

  document.getElementById('exec-activity-title').innerText = act.title;
  document.getElementById('exec-instruction').innerText = act.description;
  document.getElementById('exec-qrcode-expected').innerText = act.qrCode;
  document.getElementById('exec-comment').value = '';
  qrScanProcessing = false;

  // Setup UI
  document.getElementById('scanner-feedback').style.display = 'none';
  document.getElementById('qr-scanner-visual').style.display = 'flex';
  document.getElementById('btn-start-scanner').style.display = 'block';

  showPage('tech-execute');
}

async function startScanner() {
  if (html5QrScanner || qrScanProcessing) return;

  const startButton = document.getElementById('btn-start-scanner');
  startButton.style.display = 'none';
  const feedback = document.getElementById('scanner-feedback');
  feedback.style.display = 'none';

  try {
    if (typeof Html5Qrcode !== 'function') {
      throw new Error('QR_READER_UNAVAILABLE');
    }

    // Initialize HTML5 QR Code Scanner
    html5QrScanner = new Html5Qrcode("qr-reader");

    const config = {
      fps: 10,
      qrbox: { width: 250, height: 250 }
    };

    await html5QrScanner.start(
      { facingMode: "environment" },
      config,
      onScanSuccess,
      onScanFailure
    );
  } catch (err) {
    console.error("Erro ao iniciar câmera: ", err);
    html5QrScanner = null;
    startButton.style.display = 'block';
    feedback.className = 'badge badge-danger';
    feedback.innerText = err && err.message === 'QR_READER_UNAVAILABLE'
      ? 'O leitor de QR Code não carregou. Atualize a página e tente novamente.'
      : 'Não foi possível acessar a câmera. Verifique a permissão e tente novamente.';
    feedback.style.display = 'inline-block';
  }
}

function stopScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => {
      html5QrScanner = null;
      document.getElementById('btn-start-scanner').style.display = 'block';
    }).catch(err => {
      console.error("Falha ao desligar câmera: ", err);
    });
  }
}

async function onScanSuccess(decodedText, decodedResult) {
  if (qrScanProcessing) return;
  qrScanProcessing = true;

  console.log(`Scan result: ${decodedText}`, decodedResult);
  stopScanner();

  const completed = await validateAndExecute(decodedText);
  if (!completed) qrScanProcessing = false;
}

function onScanFailure(error) {
  // Silent logs to avoid flooding console, as it queries every frame
}

async function validateAndExecute(scannedCode) {
  const expectedCode = currentExecutingActivity.qrCode;
  const feedback = document.getElementById('scanner-feedback');

  if (scannedCode === expectedCode) {
    feedback.className = 'badge badge-success';
    feedback.innerText = 'Código QR validado com sucesso! Registrando inspeção...';
    feedback.style.display = 'inline-block';

    const comment = document.getElementById('exec-comment').value.trim();
    
    // Create history entry
    const historyEntry = {
      timestamp: new Date().toISOString(),
      activityId: currentExecutingActivity.id,
      activityTitle: currentExecutingActivity.title,
      techUsername: currentUser.username,
      techName: currentUser.name,
      comment: comment
    };

    await addHistoryRecord(historyEntry);

    // Update activity execution times
    const idx = activitiesList.findIndex(a => a.id === currentExecutingActivity.id);
    if (idx > -1) {
      const today = new Date();
      activitiesList[idx].lastExecuted = formatDateKey(today);
      // Next Due Date = Today + Periodicity
      activitiesList[idx].nextDueDate = getFutureDate(activitiesList[idx].periodicity);
    }

    await saveActivities();

    setTimeout(() => {
      alert("Atividade concluída com sucesso!");
      loadTechnicianActivities();
      showPage('tech-home');
    }, 1000);
    return true;

  } else {
    feedback.className = 'badge badge-danger';
    feedback.innerText = `Código inválido. Lido: "${scannedCode}". Esperado: "${expectedCode}".`;
    feedback.style.display = 'inline-block';
    return false;
  }
}



// ----------------------------------------------------
// FCM PUSH NOTIFICATIONS
// ----------------------------------------------------

/**
 * Updates the notification status section on the technician page.
 * Always visible — shows current status and enable button when needed.
 */
function setNotificationBannerState(iconValue, message, color, buttonLabel = null) {
  const icon = document.getElementById('notif-status-icon');
  const text = document.getElementById('notif-status-text');
  const btn = document.getElementById('btn-enable-notifications');
  if (!icon || !text || !btn) return;

  icon.textContent = iconValue;
  text.textContent = message;
  text.style.color = color;
  btn.textContent = buttonLabel || 'Ativar Notificações';
  btn.style.display = buttonLabel ? 'inline-flex' : 'none';
}

function isNotificationEnvironmentSupported() {
  const isLocalFile = window.location && window.location.protocol === 'file:';
  const isExplicitlyInsecure = window.isSecureContext === false;
  return !isLocalFile && !isExplicitlyInsecure;
}

async function checkNotificationBanner() {
  const section = document.getElementById('notification-section');
  const icon = document.getElementById('notif-status-icon');
  const text = document.getElementById('notif-status-text');
  const btn = document.getElementById('btn-enable-notifications');
  
  if (!section || !icon || !text || !btn) return;
  
  // Only show for technicians
  if (!currentUser || currentUser.role !== 'tecnico') {
    section.style.display = 'none';
    return;
  }
  
  section.style.display = 'block';

  if (!isNotificationEnvironmentSupported()) {
    setNotificationBannerState(
      '⚠️',
      'Notificações indisponíveis no arquivo local. Abra a versão publicada do aplicativo.',
      '#f59e0b'
    );
    return;
  }

  // Check if browser supports notifications
  if (!('Notification' in window)) {
    setNotificationBannerState('🚫', 'Seu navegador não suporta notificações push.', 'var(--text-secondary)');
    return;
  }

  // Check if messaging is available
  if (!messaging) {
    setNotificationBannerState('⚠️', 'Firebase Messaging não disponível. Verifique a conexão.', '#f59e0b');
    return;
  }

  if (Notification.permission === 'granted') {
    setNotificationBannerState('⏳', 'Confirmando o cadastro deste aparelho...', 'var(--text-secondary)');
    const registered = await registerFcmToken(false);
    if (registered) {
      setNotificationBannerState('✅', 'Notificações ativadas — alertas nos dias úteis.', '#22c55e');
    } else {
      setNotificationBannerState(
        '⚠️',
        'Permissão concedida, mas o aparelho ainda não foi registrado.',
        '#f59e0b',
        'Tentar novamente'
      );
    }
  } else if (Notification.permission === 'denied') {
    setNotificationBannerState('🔕', 'Notificações bloqueadas. Ative nas configurações do navegador.', '#ef4444');
  } else {
    setNotificationBannerState('🔔', 'Receba alertas de inspeções pendentes.', 'var(--text-secondary)', 'Ativar Notificações');
  }
}

/**
 * Called when technician clicks "Ativar Notificações".
 * Requests browser permission and saves FCM token to Firestore.
 */
async function requestNotificationPermission() {
  if (!isNotificationEnvironmentSupported()) {
    await checkNotificationBanner();
    alert('Abra a versão publicada do aplicativo para ativar as notificações.');
    return;
  }
  if (!messaging) {
    alert('Notificações Push não são suportadas neste navegador.');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotificationBannerState('⏳', 'Registrando este aparelho...', 'var(--text-secondary)');
      const registered = await registerFcmToken(true);
      if (registered) {
        setNotificationBannerState('✅', 'Notificações ativadas — alertas nos dias úteis.', '#22c55e');
        alert('✅ Notificações ativadas! Você receberá alertas de inspeções pendentes nos dias úteis.');
      } else {
        setNotificationBannerState(
          '⚠️',
          'Permissão concedida, mas o aparelho ainda não foi registrado.',
          '#f59e0b',
          'Tentar novamente'
        );
      }
    } else {
      await checkNotificationBanner();
      alert('Permissão de notificação negada. Você pode ativar novamente nas configurações do seu navegador.');
    }
  } catch (err) {
    console.error('Erro ao solicitar permissão de notificação:', err);
    alert('Erro ao solicitar permissão: ' + err.message);
  }
}

/**
 * Builds a stable Firestore-safe identifier without exposing the FCM token in
 * the document path. Two independent hashes make collisions very unlikely.
 */
function createNotificationDeviceId(token) {
  let hashA = 2166136261;
  let hashB = 5381;
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 16777619);
    hashB = Math.imul(hashB, 33) ^ code;
  }
  return `device-${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Gets the FCM token for this device and associates it with the current user.
 * The token-keyed document is overwritten when another user signs in on the
 * same browser, preventing one device from belonging to two users.
 */
async function registerFcmToken(showErrors = true) {
  if (!messaging || !useFirebase || !currentUser) return false;
  try {
    let swReg = null;
    if ('serviceWorker' in navigator) {
      swReg = await registerAppServiceWorker();
    }

    const tokenOptions = { vapidKey: FCM_VAPID_KEY };
    if (swReg) {
      tokenOptions.serviceWorkerRegistration = swReg;
    }

    const token = await messaging.getToken(tokenOptions);
    if (token) {
      console.log('FCM Token registrado:', token);
      const deviceId = createNotificationDeviceId(token);
      const updatedAt = new Date().toISOString();

      await db.collection('notificationDevices').doc(deviceId).set({
        token,
        username: currentUser.username,
        updatedAt,
        appSecretKey: APP_SECRET_KEY
      });

      await db.collection('users').doc(currentUser.username).set({
        fcmToken: token,
        fcmTokenUpdatedAt: updatedAt,
        appSecretKey: APP_SECRET_KEY
      }, { merge: true });

      const duplicateUsers = await db.collection('users').where('fcmToken', '==', token).get();
      const duplicateBatch = db.batch();
      let hasDuplicates = false;
      duplicateUsers.forEach(doc => {
        if (doc.id !== currentUser.username) {
          duplicateBatch.set(doc.ref, { fcmToken: null, fcmTokenUpdatedAt: null }, { merge: true });
          hasDuplicates = true;
        }
      });
      if (hasDuplicates) await duplicateBatch.commit();

      localStorage.setItem('notification_device_id', deviceId);
      localStorage.setItem('notification_device_user', currentUser.username);
      console.log('FCM Token salvo no Firestore com sucesso.');
      return true;
    } else {
      console.warn('Nenhum FCM Token obtido. Verifique o Service Worker e a VAPID Key.');
      if (showErrors) {
        alert('⚠️ O navegador concedeu a permissão, mas o token de notificação não pôde ser gerado.');
      }
      return false;
    }
  } catch (err) {
    console.error('Erro ao obter/salvar FCM Token:', err);
    if (showErrors) alert('⚠️ Erro ao registrar notificações: ' + err.message);
    return false;
  }
}

/**
 * Explicit logout removes only this browser's association. Other devices for
 * the same technician continue receiving notifications.
 */
async function unregisterCurrentNotificationDevice(username) {
  if (!useFirebase || !db) return;

  const deviceId = localStorage.getItem('notification_device_id');
  const deviceUser = localStorage.getItem('notification_device_user');
  if (!deviceId || deviceUser !== username) return;

  try {
    await db.collection('notificationDevices').doc(deviceId).delete();
    await db.collection('users').doc(username).set({
      fcmToken: null,
      fcmTokenUpdatedAt: null,
      appSecretKey: APP_SECRET_KEY
    }, { merge: true });
    localStorage.removeItem('notification_device_id');
    localStorage.removeItem('notification_device_user');
  } catch (error) {
    console.warn('Não foi possível desvincular as notificações deste aparelho:', error.message);
  }
}

/**
 * Returns the next business day (Mon-Fri) date string from a given date.
 * Used to determine which day a weekend-due notification should fire.
 * @param {Date} date
 * @returns {string} YYYY-MM-DD
 */
function getNextBusinessDay(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 6) d.setDate(d.getDate() + 2); // Sat -> Mon
  else if (day === 0) d.setDate(d.getDate() + 1); // Sun -> Mon
  return formatDateKey(d);
}

function registerAppServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!appServiceWorkerRegistrationPromise) {
    appServiceWorkerRegistrationPromise = navigator.serviceWorker
      .register('./firebase-messaging-sw.js')
      .catch(error => {
        appServiceWorkerRegistrationPromise = null;
        throw error;
      });
  }
  return appServiceWorkerRegistrationPromise;
}

// ----------------------------------------------------
// HELPER FUNCTIONS
// ----------------------------------------------------
function formatDateBR(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatDateTime(isoString) {
  if (!isoString) return '-';
  const d = new Date(isoString);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

// ----------------------------------------------------
// INITIALIZATION ON LOAD
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Service Worker Registration
  if ('serviceWorker' in navigator) {
    registerAppServiceWorker()
      .then(reg => console.log('Service Worker registrado com sucesso!', reg))
      .catch(err => console.error('Erro ao registrar Service Worker:', err));
  }

  // Database setup
  await initDatabase();

  // Check Session storage for auto-login
  const savedUser = sessionStorage.getItem('logged_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    updateHeader();
    if (currentUser.role === 'admin') {
      loadAdminUsers();
      loadAdminActivities();
      showPage('admin-activities');
    } else {
      loadTechnicianActivities();
      showPage('tech-home');
      checkNotificationBanner();
    }
  } else {
    logout();
  }

  // Bind Form Submits
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('user-form').addEventListener('submit', saveUserForm);
  document.getElementById('activity-form').addEventListener('submit', saveActivityForm);
});
