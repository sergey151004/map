const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(initialAppState = 'active') {
  const states = [];
  const listeners = new Set();
  const timers = new Map();
  let timerId = 0;
  const watches = [];
  let activeWatches = 0;
  let maximumWatches = 0;
  const control = {
    permission: { status: 'granted', granted: true, canAskAgain: true },
    requested: { status: 'granted', granted: true, canAskAgain: true },
    enabled: true, requests: 0, permissionGate: null, watchGate: null, watchRejects: false,
  };
  const AppState = {
    currentState: initialAppState,
    addEventListener(name, callback) {
      assert.equal(name, 'change');
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
  };
  const Location = {
    Accuracy: { Balanced: 3 },
    getForegroundPermissionsAsync: async () => control.permission,
    requestForegroundPermissionsAsync: async () => {
      control.requests += 1;
      control.permission = control.permissionGate ? await control.permissionGate.promise : control.requested;
      return control.permission;
    },
    hasServicesEnabledAsync: async () => control.enabled,
    watchPositionAsync: async (options, callback, errorCallback) => {
      if (control.watchRejects) throw new Error('Native watch failed');
      assert.equal(options.accuracy, 3);
      assert.equal(options.timeInterval, 5000);
      assert.equal(options.distanceInterval, 5);
      const watch = {
        callback, errorCallback, removed: false,
        remove() {
          assert.equal(watch.removed, false, 'subscription removed twice');
          watch.removed = true;
          activeWatches -= 1;
        },
      };
      activeWatches += 1;
      maximumWatches = Math.max(maximumWatches, activeWatches);
      watches.push(watch);
      if (control.watchGate) await control.watchGate.promise;
      return watch;
    },
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../services/location.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, __DEV__: false,
    require(name) {
      if (name === 'react-native') return { AppState };
      if (name === 'expo-location') return Location;
      throw new Error(name);
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename });
  return {
    control, states, watches, timers, listeners,
    get latest() { return states.at(-1); },
    get maximumWatches() { return maximumWatches; },
    start() { return module.exports.trackForegroundLocation((state) => states.push(state)); },
    appState(value) {
      AppState.currentState = value;
      for (const listener of listeners) listener(value);
    },
    async tick(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); await timer.callback(); }
      }
      await flush();
    },
  };
}

const position = (latitude) => ({ coords: { latitude, longitude: 60.6, accuracy: 100 }, timestamp: 1 });

test('ожидание, обновления координат, active-события без дубликатов, фон и возврат', async () => {
  const f = fixture();
  const tracker = f.start();
  await flush();
  assert.equal(f.latest.status, 'waiting');
  await f.tick(20000);
  assert.match(f.latest.message, /пока не получена/);
  f.watches[0].callback(position(56.8));
  assert.equal(f.latest.status, 'tracking');
  f.watches[0].callback(position(56.9));
  assert.equal(f.latest.position.coords.latitude, 56.9);
  f.appState('active');
  await flush();
  assert.equal(f.watches.length, 1);
  f.appState('background');
  assert.equal(f.latest.status, 'paused');
  assert.equal(f.latest.position, null);
  assert.equal(f.watches[0].removed, true);
  assert.equal(f.timers.size, 0);
  f.watches[0].callback(position(99));
  assert.equal(f.latest.status, 'paused');
  f.appState('active');
  await flush();
  assert.equal(f.watches.length, 2);
  assert.equal(f.maximumWatches, 1);
  tracker.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.watches[1].removed, true);
});

test('отказ не вызывает watch и повторных автоматических запросов', async () => {
  const f = fixture();
  f.control.permission = { status: 'undetermined', granted: false, canAskAgain: true };
  f.control.requested = { status: 'denied', granted: false, canAskAgain: true };
  const tracker = f.start();
  await flush();
  assert.equal(f.control.requests, 1);
  assert.equal(f.latest.status, 'denied');
  assert.equal(f.watches.length, 0);
  f.appState('background'); f.appState('active');
  await flush();
  assert.equal(f.control.requests, 1);
  f.control.requested = { status: 'granted', granted: true, canAskAgain: true };
  tracker.retry();
  await flush();
  assert.equal(f.control.requests, 2);
  assert.equal(f.watches.length, 1);
  tracker.dispose();
});

test('постоянный отказ сообщает о настройках, выключенные сервисы не создают watch', async () => {
  const f = fixture();
  f.control.permission = { status: 'denied', granted: false, canAskAgain: false };
  const tracker = f.start();
  await flush();
  tracker.retry();
  await flush();
  assert.equal(f.latest.status, 'denied');
  assert.equal(f.latest.canAskAgain, false);
  assert.equal(f.control.requests, 0);
  f.control.permission = { status: 'granted', granted: true, canAskAgain: true };
  f.control.enabled = false;
  tracker.retry();
  await flush();
  assert.equal(f.latest.status, 'disabled');
  assert.equal(f.watches.length, 0);
  f.control.enabled = true;
  tracker.retry();
  await flush();
  f.control.enabled = false;
  await f.tick(5000);
  assert.equal(f.latest.status, 'disabled');
  assert.equal(f.watches[0].removed, true);
  tracker.dispose();
});

test('поздний watch после размонтирования удаляется, новый монтаж ждёт очистки', async () => {
  const f = fixture();
  const gate = deferred();
  f.control.watchGate = gate;
  const first = f.start();
  await flush();
  first.dispose();
  const count = f.states.length;
  f.watches[0].callback(position(12));
  assert.equal(f.states.length, count);
  const second = f.start();
  await flush();
  assert.equal(f.watches.length, 1);
  gate.resolve();
  await flush();
  assert.equal(f.watches[0].removed, true);
  assert.equal(f.watches.length, 2);
  assert.equal(f.maximumWatches, 1);
  second.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('фон во время запуска и быстрые повторы не создают пересекающихся подписок', async () => {
  const f = fixture();
  const gate = deferred();
  f.control.watchGate = gate;
  const tracker = f.start();
  await flush();
  f.appState('inactive'); f.appState('active');
  tracker.retry(); tracker.retry();
  await flush();
  assert.equal(f.watches.length, 1);
  gate.resolve();
  await flush();
  assert.equal(f.watches.length, 2);
  assert.equal(f.maximumWatches, 1);
  tracker.dispose();
});

test('завершение запроса разрешения после размонтирования не запускает watch', async () => {
  const f = fixture();
  f.control.permission = { status: 'undetermined', granted: false, canAskAgain: true };
  const gate = deferred();
  f.control.permissionGate = gate;
  const tracker = f.start();
  await flush();
  tracker.dispose();
  const count = f.states.length;
  gate.resolve({ status: 'granted', granted: true, canAskAgain: true });
  await flush();
  assert.equal(f.watches.length, 0);
  assert.equal(f.states.length, count);
});

test('ошибка старта/координат и отзыв разрешения очищают ресурсы, повтор работает', async () => {
  const f = fixture();
  f.control.watchRejects = true;
  const tracker = f.start();
  await flush();
  assert.equal(f.latest.status, 'error');
  assert.equal(f.timers.size, 0);
  f.control.watchRejects = false;
  tracker.retry();
  await flush();
  f.watches[0].errorCallback('Location unavailable');
  await flush();
  assert.equal(f.latest.status, 'error');
  assert.equal(f.watches[0].removed, true);
  tracker.retry();
  await flush();
  f.control.permission = { status: 'denied', granted: false, canAskAgain: false };
  await f.tick(5000);
  assert.equal(f.latest.status, 'denied');
  assert.equal(f.watches[1].removed, true);
  tracker.dispose();
});

test('при старте в фоне до active разрешения не запрашиваются', async () => {
  const f = fixture(null);
  const tracker = f.start();
  await flush();
  assert.equal(f.latest.status, 'paused');
  assert.equal(f.watches.length, 0);
  f.appState('active');
  await flush();
  assert.equal(f.watches.length, 1);
  tracker.dispose();
});
