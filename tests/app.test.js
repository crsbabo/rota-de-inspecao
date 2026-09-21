const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const messagingWorkerSource = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
const legacyWorkerSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const notificationUtils = require('../scripts/notification-utils');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    snapshot() {
      return Object.fromEntries(values);
    }
  };
}

function createElement() {
  return {
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {} },
    getAttribute() { return ''; },
    innerHTML: '',
    innerText: '',
    style: {},
    value: ''
  };
}

function createAppContext(options = {}) {
  const elements = new Map();
  const registerCalls = [];
  const localStorage = options.localStorage || createStorage();
  const sessionStorage = options.sessionStorage || createStorage();

  const notification = {
    permission: options.notificationPermission || 'default',
    requestPermission: async () => options.notificationPermission || 'default'
  };

  const context = vm.createContext({
    alert() {},
    clearTimeout,
    confirm: () => true,
    console,
    Date,
    document: {
      createElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      querySelectorAll() { return []; }
    },
    firebase: {
      apps: [],
      initializeApp() {},
      firestore() { return {}; },
      messaging() { return { onMessage() {}, getToken: async () => 'token' }; }
    },
    Html5Qrcode: function Html5Qrcode() {},
    localStorage,
    navigator: {
      serviceWorker: {
        async register(scriptUrl) {
          registerCalls.push(scriptUrl);
          return { scriptUrl };
        }
      }
    },
    Notification: notification,
    sessionStorage,
    setTimeout,
    window: {
      Notification: notification,
      isSecureContext: options.isSecureContext ?? true,
      location: { protocol: options.protocol || 'https:' },
      addEventListener(type, callback) {
        if (type === 'DOMContentLoaded') context.__domReady = callback;
      }
    },
    __registerCalls: registerCalls
  });

  vm.runInContext(appSource, context, { filename: 'app.js' });
  return context;
}

test('date-only comparisons keep today on the local calendar day', () => {
  const context = createAppContext();

  assert.equal(
    vm.runInContext("isDateOverdue('2026-09-18', new Date(2026, 8, 18, 12))", context),
    false
  );
  assert.equal(
    vm.runInContext("isDateOverdue('2026-09-17', new Date(2026, 8, 18, 12))", context),
    true
  );
  assert.equal(
    vm.runInContext("isDateOverdue('2026-09-19', new Date(2026, 8, 18, 12))", context),
    false
  );
  assert.equal(
    vm.runInContext("formatDateKey(parseDateOnlyLocal('2026-09-18'))", context),
    '2026-09-18'
  );
});

test('notification date uses the Sao Paulo calendar day', () => {
  const instant = new Date('2026-09-22T01:30:00.000Z');
  assert.deepEqual(notificationUtils.getDateInTimeZone(instant), {
    dateKey: '2026-09-21',
    weekday: 'Mon'
  });
});

test('notification selection separates overdue and due-today activities', () => {
  const activities = [
    { id: 'old', nextDueDate: '2026-09-20' },
    { id: 'today', nextDueDate: '2026-09-21' },
    { id: 'future', nextDueDate: '2026-09-22' }
  ];
  const pending = notificationUtils.getPendingActivities(activities, '2026-09-21');
  const summary = notificationUtils.summarizeActivities(pending, '2026-09-21');

  assert.deepEqual(pending.map(activity => activity.id), ['old', 'today']);
  assert.equal(summary.overdue.length, 1);
  assert.equal(summary.dueToday.length, 1);
  assert.equal(summary.total, 2);
});

test('notification delivery keys are stable per token', () => {
  assert.equal(notificationUtils.hashToken('token-a'), notificationUtils.hashToken('token-a'));
  assert.notEqual(notificationUtils.hashToken('token-a'), notificationUtils.hashToken('token-b'));
});

test('browser notification device identifiers are stable and token-specific', () => {
  const context = createAppContext();
  assert.equal(
    vm.runInContext("createNotificationDeviceId('token-a')", context),
    vm.runInContext("createNotificationDeviceId('token-a')", context)
  );
  assert.notEqual(
    vm.runInContext("createNotificationDeviceId('token-a')", context),
    vm.runInContext("createNotificationDeviceId('token-b')", context)
  );
});

test('local file mode explains why notifications cannot be activated', async () => {
  const context = createAppContext({ protocol: 'file:', isSecureContext: false });
  vm.runInContext(`
    currentUser = { username: 'tech', role: 'tecnico' };
    messaging = { getToken: async () => 'token' };
  `, context);

  await vm.runInContext('checkNotificationBanner()', context);

  assert.match(
    context.document.getElementById('notif-status-text').textContent,
    /indisponíveis no arquivo local/
  );
  assert.equal(context.document.getElementById('btn-enable-notifications').style.display, 'none');
});

test('granted browser permission is not shown as active when Firebase registration fails', async () => {
  const context = createAppContext({ notificationPermission: 'granted' });
  vm.runInContext(`
    currentUser = { username: 'tech', role: 'tecnico' };
    useFirebase = true;
    messaging = { getToken: async () => { throw new Error('registration failed'); } };
  `, context);

  await vm.runInContext('checkNotificationBanner()', context);

  const statusText = context.document.getElementById('notif-status-text').textContent;
  assert.doesNotMatch(statusText, /Notificações ativadas/);
  assert.match(statusText, /ainda não foi registrado/);
  assert.equal(context.document.getElementById('btn-enable-notifications').style.display, 'inline-flex');
  assert.equal(context.document.getElementById('btn-enable-notifications').textContent, 'Tentar novamente');
});

test('technician execution offers QR scanning only while keeping the expected code visible', () => {
  const context = createAppContext();

  assert.doesNotMatch(indexSource, /Digitar Código|manual-entry-container|exec-manual-code|handleManualSubmit/);
  assert.match(indexSource, /Código esperado:/);
  assert.equal(vm.runInContext("typeof showManualEntry", context), 'undefined');
  assert.equal(vm.runInContext("typeof handleManualSubmit", context), 'undefined');
});

test('an invalid scanned QR code cannot complete the activity', async () => {
  const context = createAppContext();
  vm.runInContext(`
    currentUser = { username: 'tech', name: 'Técnico', role: 'tecnico' };
    currentExecutingActivity = {
      id: 'a1',
      title: 'Inspeção',
      qrCode: 'EQ-01',
      periodicity: 7,
      nextDueDate: '2026-09-21'
    };
    activitiesList = [currentExecutingActivity];
    historyList = [];
    saveActivities = async () => { throw new Error('should not save'); };
    addHistoryRecord = async () => { throw new Error('should not add history'); };
  `, context);

  const completed = await vm.runInContext("validateAndExecute('WRONG-CODE')", context);

  assert.equal(completed, false);
  assert.equal(vm.runInContext('historyList.length', context), 0);
  assert.equal(vm.runInContext("activitiesList[0].nextDueDate", context), '2026-09-21');
  assert.equal(context.document.getElementById('scanner-feedback').className, 'badge badge-danger');
});

test('camera access failure only offers a retry and cannot complete the activity', async () => {
  const context = createAppContext();
  vm.runInContext(`
    Html5Qrcode = function Html5Qrcode() {
      this.start = async () => { throw new Error('camera blocked'); };
    };
    currentExecutingActivity = { id: 'a1', qrCode: 'EQ-01' };
    activitiesList = [currentExecutingActivity];
    historyList = [];
  `, context);

  await vm.runInContext('startScanner()', context);

  const feedback = context.document.getElementById('scanner-feedback');
  assert.equal(context.document.getElementById('btn-start-scanner').style.display, 'block');
  assert.equal(feedback.className, 'badge badge-danger');
  assert.match(feedback.innerText, /Verifique a permissão e tente novamente/);
  assert.equal(vm.runInContext('historyList.length', context), 0);
});

test('a new activity uses the selected first inspection date', async () => {
  const context = createAppContext();
  const values = {
    'activity-id': '',
    'activity-title': 'Inspeção programada',
    'activity-description': 'Verificar equipamento',
    'activity-periodicity': '7',
    'activity-first-date': '2026-10-05',
    'activity-qrcode': 'EQ-01'
  };

  for (const [id, value] of Object.entries(values)) {
    context.document.getElementById(id).value = value;
  }

  vm.runInContext(`
    activitiesList = [];
    saveActivities = async () => {};
    loadAdminActivities = () => {};
  `, context);

  await vm.runInContext('saveActivityForm({ preventDefault() {} })', context);

  assert.equal(vm.runInContext('activitiesList.length', context), 1);
  assert.equal(vm.runInContext('activitiesList[0].firstDueDate', context), '2026-10-05');
  assert.equal(vm.runInContext('activitiesList[0].nextDueDate', context), '2026-10-05');
  assert.equal(vm.runInContext('activitiesList[0].periodicity', context), 7);
});

test('after the first execution, the next date follows the configured periodicity', async () => {
  const context = createAppContext();
  context.setTimeout = callback => callback();
  context.document.getElementById('exec-comment').value = '';

  vm.runInContext(`
    currentUser = { username: 'tech', name: 'Técnico', role: 'tecnico' };
    activitiesList = [{
      id: 'a1',
      title: 'Inspeção',
      qrCode: 'EQ-01',
      periodicity: 7,
      firstDueDate: '2026-10-05',
      lastExecuted: null,
      nextDueDate: '2026-10-05'
    }];
    currentExecutingActivity = activitiesList[0];
    addHistoryRecord = async () => {};
    saveActivities = async () => {};
    loadTechnicianActivities = () => {};
    showPage = () => {};
  `, context);

  await vm.runInContext("validateAndExecute('EQ-01')", context);

  assert.equal(
    vm.runInContext('activitiesList[0].lastExecuted', context),
    vm.runInContext('formatDateKey(new Date())', context)
  );
  assert.equal(
    vm.runInContext('activitiesList[0].nextDueDate', context),
    vm.runInContext('getFutureDate(7)', context)
  );
});

test('Firebase user deletion removes the document and updates assignments in one batch', async () => {
  const context = createAppContext();
  const operations = [];
  const dbMock = {
    batch() {
      return {
        delete(ref) { operations.push(['delete', ref.path]); },
        set(ref, data) { operations.push(['set', ref.path, data]); },
        async commit() { operations.push(['commit']); }
      };
    },
    collection(collectionName) {
      return {
        doc(id) {
          return { path: `${collectionName}/${id}` };
        }
      };
    }
  };

  context.__dbMock = dbMock;
  context.__reloads = 0;
  vm.runInContext(`
    db = __dbMock;
    useFirebase = true;
    usersList = [
      { username: 'admin', role: 'admin' },
      { username: 'tech', role: 'tecnico' }
    ];
    activitiesList = [
      { id: 'a1', assignedTo: ['tech'], title: 'A' },
      { id: 'a2', assignedTo: ['other'], title: 'B' }
    ];
    loadAdminUsers = () => { __reloads += 1; };
  `, context);

  await vm.runInContext("deleteUser('tech')", context);

  assert.deepEqual(operations.map(operation => operation.slice(0, 2)), [
    ['delete', 'users/tech'],
    ['set', 'activities/a1'],
    ['commit']
  ]);
  assert.deepEqual(Array.from(operations[1][2].assignedTo), []);
  assert.equal(operations[1][2].appSecretKey, 'sulcorte_inspec_2026');
  assert.equal(vm.runInContext('usersList.length', context), 1);
  assert.equal(vm.runInContext("activitiesList[0].assignedTo.includes('tech')", context), false);
  assert.equal(context.__reloads, 1);
});

test('Firebase activity deletion targets the activity document', async () => {
  const context = createAppContext();
  const operations = [];
  const dbMock = {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            async delete() { operations.push(['delete', `${collectionName}/${id}`]); }
          };
        }
      };
    }
  };

  context.__dbMock = dbMock;
  context.__reloads = 0;
  vm.runInContext(`
    db = __dbMock;
    useFirebase = true;
    activitiesList = [{ id: 'a1' }, { id: 'a2' }];
    loadAdminActivities = () => { __reloads += 1; };
  `, context);

  await vm.runInContext("deleteActivity('a1')", context);

  assert.deepEqual(operations, [['delete', 'activities/a1']]);
  assert.equal(vm.runInContext('activitiesList.length', context), 1);
  assert.equal(vm.runInContext("activitiesList[0].id", context), 'a2');
  assert.equal(context.__reloads, 1);
});

test('admin session loads activities before opening the initial dashboard', async () => {
  const sessionStorage = createStorage({
    logged_user: JSON.stringify({ username: 'admin', role: 'admin' })
  });
  const context = createAppContext({ sessionStorage });
  context.__calls = [];

  vm.runInContext(`
    initDatabase = async () => {};
    registerAppServiceWorker = async () => ({});
    updateHeader = () => {};
    loadAdminUsers = () => __calls.push('users');
    loadAdminActivities = () => __calls.push('activities');
    showPage = page => __calls.push(page);
  `, context);

  await context.__domReady();

  assert.deepEqual(Array.from(context.__calls), ['users', 'activities', 'admin-activities']);
});

test('the app reuses one combined service worker registration', async () => {
  const context = createAppContext();

  const [first, second] = await Promise.all([
    vm.runInContext('registerAppServiceWorker()', context),
    vm.runInContext('registerAppServiceWorker()', context)
  ]);

  assert.equal(first, second);
  assert.deepEqual(context.__registerCalls, ['./firebase-messaging-sw.js']);
});

test('the combined worker registers cache lifecycle and background messaging handlers', () => {
  const listeners = new Map();
  const importedScripts = [];
  let backgroundMessageHandler = null;
  const context = vm.createContext({
    caches: {},
    console,
    fetch() {},
    firebase: {
      initializeApp() {},
      messaging() {
        return {
          onBackgroundMessage(handler) { backgroundMessageHandler = handler; }
        };
      }
    },
    importScripts(...urls) { importedScripts.push(...urls); },
    self: {
      addEventListener(type, handler) { listeners.set(type, handler); },
      clients: {}
    }
  });

  vm.runInContext(messagingWorkerSource, context, { filename: 'firebase-messaging-sw.js' });

  assert.deepEqual(Array.from(listeners.keys()).sort(), [
    'activate',
    'fetch',
    'install',
    'notificationclick'
  ]);
  assert.equal(typeof backgroundMessageHandler, 'function');
  assert.equal(importedScripts.length, 2);
});

test('legacy sw.js delegates to the combined worker', () => {
  const importedScripts = [];
  const context = vm.createContext({
    importScripts(...urls) { importedScripts.push(...urls); }
  });

  vm.runInContext(legacyWorkerSource, context, { filename: 'sw.js' });

  assert.deepEqual(importedScripts, ['./firebase-messaging-sw.js']);
});
