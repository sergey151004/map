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

async function fixture(distance = calculateDistance, options = {}) {
  const sends = [];
  const removals = [];
  const errors = [];
  let removalFails = false;
  const control = { restoreFails: false, ...options };
  const { createProximityManager, PROXIMITY_THRESHOLD } = load('services/proximity.ts', {
    '../utils/calculateDistance': { calculateDistance: distance },
    './notifications': {
      getMarkerNotifications: async () => {
        if (control.restoreFails) throw new Error('restore failed');
        if (control.restoreGate) await control.restoreGate;
        return control.existing ?? [];
      },
      showMarkerNotification: (id) => new Promise((resolve, reject) => sends.push({ id, resolve, reject })),
      removeNotification: async (id) => {
        removals.push(id);
        return removalFails ? { ok: false, message: 'remove failed' } : { ok: true };
      },
    },
  });
  const manager = createProximityManager((message) => errors.push(message));
  if (!control.deferStart) {
    manager.update(null, (control.existing ?? []).map((item) => marker(item.markerId)));
    await flush();
  }
  return {
    manager: {
      ...manager,
      update(position, markers) {
        manager.update(position ? { accuracy: 10, timestamp: Date.now(), ...position } : null, markers);
      },
    },
    control,
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
  const f = await fixture((_latitude, longitude) => longitude);
  assert.equal(f.PROXIMITY_THRESHOLD, 100);
  f.manager.update({ latitude: 0, longitude: 100.001 }, [marker()]);
  assert.equal(f.sends.length, 0);
  f.manager.update({ latitude: 0, longitude: 100 }, [marker()]);
  for (let i = 0; i < 10; i++) f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  f.sends[0].resolve({ ok: true, notificationId: 'first' });
  await flush();
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 1);
  f.manager.update({ latitude: 0, longitude: 151 }, [marker()]);
  await flush();
  assert.deepEqual(f.removals, ['first']);
  f.manager.update(origin, [marker()]);
  assert.equal(f.sends.length, 2);
  f.manager.dispose();
});

test('marker changes are evaluated without a new GPS fix; markers send independently', async () => {
  const f = await fixture();
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
    const f = await fixture();
    f.manager.update(origin, [marker()]);
    f.manager.update(deleted ? origin : far, deleted ? [] : [marker()]);
    f.sends[0].resolve({ ok: true, notificationId: 'late' });
    await flush();
    assert.deepEqual(f.removals, ['late']);
    assert.equal(f.sends.length, 1);
  }
});

test('exit and reentry during send removes old result and sends once for the new visit', async () => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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

test('reentry waits for failed old notification removal; other markers remain independent', async () => {
  const f = await fixture();
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: true, notificationId: 'old' });
  await flush();
  f.failRemoval(true);
  f.manager.update(far, [marker()]);
  await flush();
  f.manager.update(origin, [marker(), marker(2)]);
  await flush();
  assert.deepEqual(f.sends.map((send) => send.id), [1, 2]);
  f.failRemoval(false);
  f.manager.retry();
  await flush();
  assert.deepEqual(f.sends.map((send) => send.id), [1, 2, 1]);
});

test('restart restores the shown notification without a duplicate and removes it on exit', async () => {
  const first = await fixture();
  first.manager.update(origin, [marker()]);
  first.sends[0].resolve({ ok: true, notificationId: 'previous-session' });
  await flush();
  // Модель принудительного завершения: dispose не вызывается ОС.
  const restarted = await fixture(calculateDistance, { existing: [
    { markerId: 1, notificationId: 'previous-session', timestamp: Date.now(), presented: true },
  ] });
  restarted.manager.update(origin, [marker()]);
  assert.equal(restarted.sends.length, 0);
  assert.equal(restarted.removals.length, 0);
  restarted.manager.update(far, [marker()]);
  await flush();
  assert.deepEqual(restarted.removals, ['previous-session']);
});

test('GPS oscillation across 100 meters does not end the visit; inaccurate fixes are ignored', async () => {
  const f = await fixture();
  const atDistance = (meters, accuracy = 10) => ({ latitude: meters / 6371000 * 180 / Math.PI, longitude: 0, accuracy });
  f.manager.update(atDistance(99), [marker()]);
  f.sends[0].resolve({ ok: true, notificationId: 'near' });
  await flush();
  f.manager.update(atDistance(101), [marker()]);
  await flush();
  assert.deepEqual(f.removals, []);
  f.manager.update(atDistance(99), [marker()]);
  assert.equal(f.sends.length, 1);
  f.manager.update(atDistance(200, 300), [marker()]);
  assert.equal(f.removals.length, 0);
  f.manager.update(atDistance(151), [marker()]);
  await flush();
  assert.deepEqual(f.removals, ['near']);
  f.manager.update(atDistance(99, 300), [marker()]);
  assert.equal(f.sends.length, 1);
  f.manager.update(atDistance(99), [marker()]);
  assert.equal(f.sends.length, 2);
});

test('stale, future, missing accuracy and invalid coordinates cannot send or clear a visit', async () => {
  const f = await fixture();
  for (const fix of [
    { ...origin, timestamp: Date.now() - 30_001 },
    { ...origin, timestamp: Date.now() + 60_000 },
    { ...origin, accuracy: null }, { ...origin, accuracy: -1 },
    { ...origin, accuracy: 51 }, { ...origin, latitude: NaN },
    { ...origin, latitude: 91 }, { ...origin, longitude: 181 },
  ]) f.manager.update(fix, [marker()]);
  assert.equal(f.sends.length, 0);
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: true, notificationId: 'keep' });
  await flush();
  f.manager.update({ ...far, timestamp: Date.now() - 60_000 }, [marker()]);
  assert.equal(f.removals.length, 0);
  f.manager.update(null, []);
  await flush();
  assert.deepEqual(f.removals, ['keep']);
});

test('restoration gates sends and uses latest markers; orphaned, duplicate and scheduled IDs are removed', async () => {
  let release;
  const f = await fixture(calculateDistance, {
    deferStart: true, restoreGate: new Promise((resolve) => { release = resolve; }),
    existing: [
      { markerId: 1, notificationId: 'shown', presented: true },
      { markerId: 1, notificationId: 'duplicate', presented: true },
      { markerId: 2, notificationId: 'deleted-marker', presented: true },
      { markerId: 3, notificationId: 'scheduled', presented: false },
    ],
  });
  f.manager.update(origin, [marker(), marker(2), marker(3)]);
  assert.equal(f.sends.length, 0);
  f.manager.update(origin, [marker(), marker(3)]);
  release();
  await flush();
  assert.deepEqual(f.removals.sort(), ['deleted-marker', 'duplicate', 'scheduled']);
  assert.deepEqual(f.sends.map((send) => send.id), [3]);
});

test('failed restoration blocks sends until retry succeeds', async () => {
  const f = await fixture(calculateDistance, { restoreFails: true });
  f.manager.update(origin, [marker()]);
  await flush();
  assert.equal(f.sends.length, 0);
  assert.match(f.errors.at(-1), /восстановить/);
  f.control.restoreFails = false;
  f.manager.retry();
  await flush();
  assert.equal(f.sends.length, 1);
});

test('failed presentation is cleaned up and permits a later retry without an immediate loop', async () => {
  const f = await fixture();
  f.manager.update(origin, [marker()]);
  f.sends[0].resolve({ ok: false, reason: 'error', notificationId: 'failed', message: 'not shown' });
  await flush();
  assert.deepEqual(f.removals, ['failed']);
  assert.equal(f.sends.length, 1);
  assert.equal(f.errors.at(-1), 'not shown');
  f.manager.retry();
  assert.equal(f.sends.length, 2);
});
