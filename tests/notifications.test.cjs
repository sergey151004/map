const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(os = 'android') {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const state = {
    permission: { status: 'undetermined', granted: false, canAskAgain: true },
    response: { status: 'granted', granted: true, canAskAgain: true },
    blocked: false, sendError: false, cancelError: false, handler: null,
    presentation: 'success', presented: [], scheduled: [],
  };
  const api = {
    AndroidImportance: { HIGH: 4, NONE: 0 },
    IosAuthorizationStatus: { PROVISIONAL: 3, EPHEMERAL: 4 },
    setNotificationHandler: (handler) => { state.handler = handler; },
    setNotificationChannelAsync: async () => { calls.push('channel'); },
    getNotificationChannelAsync: async () => ({ importance: state.blocked ? 0 : 4 }),
    getPermissionsAsync: async () => state.permission,
    requestPermissionsAsync: async () => {
      calls.push('request');
      state.permission = state.response;
      return state.permission;
    },
    scheduleNotificationAsync: async (input) => {
      calls.push(input);
      if (state.sendError) throw new Error('send failed');
      if (state.presentation === 'success') state.handler.handleSuccess(input.identifier);
      if (state.presentation === 'error') state.handler.handleError(input.identifier, new Error('presentation failed'));
      return input.identifier;
    },
    getPresentedNotificationsAsync: async () => state.presented,
    getAllScheduledNotificationsAsync: async () => state.scheduled,
    cancelScheduledNotificationAsync: async (id) => {
      calls.push(['cancel', id]);
      if (state.cancelError) throw new Error('cancel failed');
    },
    dismissNotificationAsync: async (id) => { calls.push(['dismiss', id]); },
  };
  const source = ts.transpileModule(fs.readFileSync('services/notifications.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, __DEV__: false,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    require: (name) => name === 'react-native' ? { Platform: { OS: os } } : api,
  });
  return { service: exports, calls, state, timers, tick() { for (const callback of [...timers.values()]) callback(); } };
}

test('foreground handler, Android channel before permission, immediate send and exact ID removal', async () => {
  const { service, calls, state } = fixture();
  const behavior = await state.handler.handleNotification();
  assert.equal(behavior.shouldShowBanner, true);
  assert.equal(behavior.shouldShowList, true);
  assert.equal(behavior.shouldPlaySound, true);
  const result = await service.showMarkerNotification(42);
  assert.match(result.notificationId, /^map-marker-42-/);
  assert.deepEqual(calls.slice(0, 2), ['channel', 'request']);
  const input = calls[2];
  assert.equal(input.content.title, 'Вы рядом с меткой!');
  assert.match(input.content.body, /42/);
  assert.equal(input.trigger.channelId, 'marker-alerts');
  assert.equal(input.trigger.seconds, undefined);
  assert.equal((await service.removeNotification(result.notificationId)).ok, true);
  assert.deepEqual(calls.slice(-2), [['cancel', result.notificationId], ['dismiss', result.notificationId]]);
});

test('concurrent calls share one permission request; denial never schedules or reprompts', async () => {
  const { service, calls, state } = fixture();
  state.response = { status: 'denied', granted: false, canAskAgain: true };
  const results = await Promise.all([service.showMarkerNotification(1), service.showMarkerNotification(2)]);
  assert.ok(results.every((result) => result.reason === 'denied'));
  await service.showMarkerNotification(1);
  assert.equal(calls.filter((call) => call === 'request').length, 1);
  assert.ok(calls.every((call) => typeof call === 'string'));
  state.permission = { status: 'granted', granted: true };
  assert.equal((await service.showMarkerNotification(1)).ok, true);
});

test('blocked channel and sending errors return failures; deletion still attempts dismiss after cancel failure', async () => {
  const { service, calls, state } = fixture();
  state.blocked = true;
  assert.equal((await service.showMarkerNotification(1)).reason, 'denied');
  state.blocked = false;
  state.sendError = true;
  assert.equal((await service.showMarkerNotification(1)).reason, 'error');
  state.sendError = false;
  assert.equal((await service.showMarkerNotification(1)).ok, true);
  state.cancelError = true;
  assert.equal((await service.removeNotification('only-this-id')).ok, false);
  assert.deepEqual(calls.at(-1), ['dismiss', 'only-this-id']);
});

test('iOS provisional permission allows immediate delivery without another prompt or Android channel', async () => {
  const { service, calls, state } = fixture('ios');
  state.permission = { status: 'granted', granted: false, ios: { status: 3 } };
  assert.equal((await service.showMarkerNotification(7)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, null);
});

test('scheduling alone is not success; a later presentation error is returned with its ID', async () => {
  const f = fixture();
  f.state.presentation = 'manual';
  let completed = false;
  const showing = f.service.showMarkerNotification(1).then((result) => { completed = true; return result; });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  const input = f.calls.find((call) => call.identifier);
  f.state.handler.handleError(input.identifier, new Error('timeout'));
  const result = await showing;
  assert.equal(result.ok, false);
  assert.equal(result.notificationId, input.identifier);
  assert.equal(f.timers.size, 0);
  f.state.presentation = 'success';
  assert.equal((await f.service.showMarkerNotification(1)).ok, true);
});

test('early handler failure is not lost; missing callback falls back to the presented list', async () => {
  const f = fixture();
  f.state.presentation = 'error';
  assert.equal((await f.service.showMarkerNotification(1)).ok, false);
  f.state.presentation = 'manual';
  for (const present of [false, true]) {
    const showing = f.service.showMarkerNotification(1);
    await new Promise(setImmediate);
    const input = f.calls.filter((call) => call.identifier).at(-1);
    f.state.presented = present ? [{ request: { identifier: input.identifier } }] : [];
    f.tick();
    assert.equal((await showing).ok, present);
    assert.equal(f.timers.size, 0);
  }
});

test('restoration includes owned and legacy notifications, deduplicates IDs and ignores unrelated ones', async () => {
  const f = fixture();
  const own = (identifier, markerId) => ({ identifier, content: { data: { markerId, scope: 'map-project/proximity-v1' } } });
  const legacy = { identifier: 'legacy', content: { title: 'Вы рядом с меткой!', body: 'Рядом сохранённая метка №2.', data: { markerId: 2 } } };
  f.state.scheduled = [own('same', 1), own('pending', 3)];
  f.state.presented = [
    { request: own('same', 1), date: 100 }, { request: legacy, date: 200 },
    { request: { identifier: 'foreign', content: { data: { markerId: 9 } } } },
    { request: own('invalid', -1) },
    { request: { ...legacy, identifier: 'other-scope', content: { ...legacy.content, data: { markerId: 2, scope: 'other' } } } },
  ];
  const results = await f.service.getMarkerNotifications();
  assert.deepEqual(Array.from(results, (item) => item.notificationId).sort(), ['legacy', 'pending', 'same']);
  assert.equal(results.find((item) => item.notificationId === 'same').presented, true);
  assert.equal(results.find((item) => item.notificationId === 'pending').presented, false);
});
