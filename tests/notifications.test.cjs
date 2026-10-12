const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(os = 'android') {
  const calls = [];
  const state = {
    permission: { status: 'undetermined', granted: false, canAskAgain: true },
    response: { status: 'granted', granted: true, canAskAgain: true },
    blocked: false, sendError: false, cancelError: false, handler: null,
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
      return 'notification-123';
    },
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
    require: (name) => name === 'react-native' ? { Platform: { OS: os } } : api,
  });
  return { service: exports, calls, state };
}

test('foreground handler, Android channel before permission, immediate send and exact ID removal', async () => {
  const { service, calls, state } = fixture();
  const behavior = await state.handler.handleNotification();
  assert.equal(behavior.shouldShowBanner, true);
  assert.equal(behavior.shouldShowList, true);
  assert.equal(behavior.shouldPlaySound, true);
  const result = await service.showMarkerNotification(42);
  assert.equal(result.notificationId, 'notification-123');
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
