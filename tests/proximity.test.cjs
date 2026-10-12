const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, __DEV__: false, require: (name) => dependencies[name] });
  return exports;
}
const { calculateDistance } = load('utils/calculateDistance.ts');
const flush = () => new Promise(setImmediate);
const origin = { latitude: 0, longitude: 0 };
const far = { latitude: 1, longitude: 1 };
const marker = (id = 1) => ({ id, ...origin });

function fixture(distance = calculateDistance) {
  const sends = [];
  const removals = [];
  const errors = [];
  let removalFails = false;
  const { createProximityManager, PROXIMITY_THRESHOLD } = load('services/proximity.ts', {
    '../utils/calculateDistance': { calculateDistance: distance },
    './notifications': {
      showMarkerNotification: (id) => new Promise((resolve, reject) => sends.push({ id, resolve, reject })),
      removeNotification: async (id) => {
        removals.push(id);
        return removalFails ? { ok: false, message: 'remove failed' } : { ok: true };
      },
    },
  });
  return {
    manager: createProximityManager((message) => errors.push(message)),
    sends, removals, errors, PROXIMITY_THRESHOLD,
    failRemoval: (value) => { removalFails = value; },
  };
}

test('Haversine returns meters for identical, known, date-line and antipodal coordinates', () => {
  assert.equal(calculateDistance(56, 60, 56, 60), 0);
  assert.ok(Math.abs(calculateDistance(0, 0, 0, 1) - 111194.9266) < 0.01);
  assert.ok(Math.abs(calculateDistance(0, 179.999, 0, -179.999) - 222.38985) < 0.01);
  assert.ok(Math.abs(calculateDistance(0, 0, 0, 180) - Math.PI * 6371000) < 0.01);
  assert.equal(calculateDistance(10, 20, 30, 40), calculateDistance(30, 40, 10, 20));
});

test('100 meters is inclusive; repeated updates cannot duplicate a pending or active notification', async () => {
  const f = fixture((latitude) => latitude);
  assert.equal(f.PROXIMITY_THRESHOLD, 100);
  f.manager.update({ latitude: 100.001, longitude: 0 }, [marker()]);
  assert.equal(f.sends.length, 0);
  f.manager.update({ latitude: 100, longitude: 0 }, [marker()]);
  for (let i = 0; i < 10; i++) f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  f.sends[0].resolve({ ok: true, notificationId: 'first' });
  await flush();
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  f.manager.update({ latitude: 101, longitude: 0 }, [marker()]);
  await flush();
  assert.deepEqual(f.removals, ['first']);
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 2);
  f.manager.dispose();
});

test('marker changes are evaluated without a new GPS fix; markers send independently', async () => {
  const f = fixture();
  f.manager.update(origin, [marker()]);
  f.manager.update(origin, [marker(), marker(2)]);
  assert.deepEqual(f.sends.map((send) => send.id), [1, 2]);
  // First send is still pending; the second completes and is independently removed.
  f.sends[1].resolve({ ok: true, notificationId: 'second' });
  await flush();
  f.manager.update(origin, [marker()]);
  await flush();
  assert.deepEqual(f.removals, ['second']);
  f.manager.update(origin, [{ id: 1, ...far }]);
  f.sends[0].resolve({ ok: true, notificationId: 'first' });
  await flush();
  assert.deepEqual(f.removals, ['second', 'first']);
});

test('exit or deletion during send removes its late result', async () => {
  for (const deleted of [false, true]) {
    const f = fixture();
    f.manager.update(origin, [marker()]);
    f.manager.update(deleted ? origin : far, deleted ? [] : [marker()]);
    f.sends[0].resolve({ ok: true, notificationId: 'late' });
    await flush();
    assert.deepEqual(f.removals, ['late']);
    assert.equal(f.sends.length, 1);
  }
});

test('exit and reentry during send removes old result and sends once for the new visit', async () => {
  const f = fixture();
  f.manager.update(origin, [marker()]);
  f.manager.update(far, [marker()]);
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  f.sends[0].resolve({ ok: true, notificationId: 'old-visit' });
  await flush();
  assert.deepEqual(f.removals, ['old-visit']);
  assert.equal(f.sends.length, 2);
  f.sends[1].resolve({ ok: true, notificationId: 'new-visit' });
  await flush();
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 2);
});

test('failures and rejection unlock future attempts, with no immediate retry loop', async () => {
  const f = fixture();
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: false, reason: 'denied', message: 'permission denied' });
  await flush();
  assert.equal(f.sends.length, 1);
  assert.equal(f.errors.at(-1), 'permission denied');
  f.manager.update(origin, [marker()]);
  f.sends[1].reject(new Error('native failure'));
  await flush();
  assert.equal(f.sends.length, 2);
  f.manager.retry();
  f.sends[2].resolve({ ok: true, notificationId: 'recovered' });
  await flush();
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 3);
});

test('loss of position preserves visit; deletion is still processed and no new sends start', async () => {
  const f = fixture();
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: true, notificationId: 'active' });
  await flush();
  f.manager.update(null, [marker(), marker(2)]);
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.removals.length, 0);
  f.manager.update(null, []);
  await flush();
  assert.deepEqual(f.removals, ['active']);
});

test('failed removal can be retried without losing the notification ID', async () => {
  const f = fixture();
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: true, notificationId: 'cleanup' });
  await flush();
  f.failRemoval(true);
  f.manager.update(far, [marker()]);
  await flush();
  assert.equal(f.errors.at(-1), 'remove failed');
  f.failRemoval(false);
  f.manager.retry();
  await flush();
  assert.deepEqual(f.removals, ['cleanup', 'cleanup']);
  f.manager.retry();
  assert.equal(f.removals.length, 2);
});

test('dispose removes active and late notifications and ignores future updates', async () => {
  const f = fixture();
  f.manager.update(origin, [marker(), marker(2)]);
  f.sends[0].resolve({ ok: true, notificationId: 'active' });
  await flush();
  f.manager.dispose();
  f.sends[1].resolve({ ok: true, notificationId: 'late' });
  await flush();
  assert.deepEqual(f.removals, ['active', 'late']);
  f.manager.update(origin, [marker()]);
  f.manager.retry();
  assert.equal(f.sends.length, 2);
});
