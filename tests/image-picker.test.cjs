const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

async function fixture(os = 'android') {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    async execAsync(sql) { sqlite.exec(sql); },
    async runAsync(sql, ...params) { return sqlite.prepare(sql).run(...params); },
    async getFirstAsync(sql, ...params) { return sqlite.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, ...params) { return sqlite.prepare(sql).all(...params); },
    async withTransactionAsync(action) {
      sqlite.exec('BEGIN');
      try { await action(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async closeAsync() { sqlite.close(); },
  };
  const success = { canceled: false, assets: [{ uri: 'file:///picker/selected.jpg' }] };
  const state = { pending: null, result: success, reads: 0, launches: 0, saveFails: false, launch: null, savedSources: [] };
  function loadSession() {
    const cache = new Map();
    function load(filename) {
      if (cache.has(filename)) return cache.get(filename);
      const module = { exports: {} };
      cache.set(filename, module.exports);
      const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      vm.runInNewContext(code, {
        module, exports: module.exports, __DEV__: false,
        require(name) {
          if (name === 'expo-sqlite') return { openDatabaseAsync: async () => db };
          if (name === 'react-native') return { Platform: { OS: os } };
          if (name === 'expo-image-picker') return {
            async getPendingResultAsync() {
              state.reads++;
              const result = state.pending;
              state.pending = null;
              return result;
            },
            async launchImageLibraryAsync() {
              state.launches++;
              assert.ok(await db.getFirstAsync('SELECT * FROM pending_image_pick'));
              return state.launch ? state.launch() : state.result;
            },
          };
          if (name === './saveMarkerImage') return {
            async saveMarkerImage(database, markerId, sourceUri) {
              if (state.saveFails) throw new Error('save failed');
              state.savedSources.push(sourceUri);
              await database.runAsync('INSERT INTO marker_images (marker_id, uri) VALUES (?, ?)', markerId, 'marker-photos/photo-1-abc.jpg');
            },
          };
          return load(path.resolve(path.dirname(filename), `${name}.ts`));
        },
      }, { filename });
      return module.exports;
    }
    return {
      ...load(path.resolve('database/schema.ts')),
      ...load(path.resolve('services/imagePicker.ts')),
    };
  }
  const service = loadSession();
  await service.initDatabase();
  await db.execAsync('INSERT INTO markers (id, latitude, longitude) VALUES (1, 0, 0), (2, 1, 1)');
  return {
    db, state, service, success, loadSession,
    async pending(markerId = 2) {
      await db.runAsync('INSERT INTO pending_image_pick (id, token, marker_id) VALUES (1, ?, ?)', 'saved-request', markerId);
    },
    photos: () => db.getAllAsync('SELECT * FROM marker_images'),
  };
}

test('the target is persisted before the picker opens; retry does not reopen or duplicate', async () => {
  const f = await fixture();
  try {
    const task = f.service.createImagePickTask(2);
    await task(f.db);
    await task(f.db);
    assert.equal(f.state.launches, 1);
    assert.equal((await f.photos()).length, 1);
    assert.equal((await f.photos())[0].marker_id, 2);
    assert.equal(await f.db.getFirstAsync('SELECT * FROM pending_image_pick'), null);
  } finally { await f.db.closeAsync(); }
});

test('recreated Android activity recovers into the original marker exactly once', async () => {
  const f = await fixture();
  try {
    await f.pending(2);
    f.state.pending = f.success;
    const restarted = f.loadSession();
    await restarted.recoverPendingImagePick(f.db);
    await restarted.recoverPendingImagePick(f.db);
    assert.equal(f.state.launches, 0);
    assert.equal((await f.photos()).length, 1);
    assert.equal((await f.photos())[0].marker_id, 2);
    assert.deepEqual(f.state.savedSources, ['file:///picker/selected.jpg']);
  } finally { await f.db.closeAsync(); }
});

test('cancellation, no result and native errors clear the request without adding an image', async () => {
  for (const result of [null, { canceled: true, assets: null }, { code: 'picker_error', message: 'failed' }, { canceled: false, assets: [] }]) {
    const f = await fixture();
    try {
      await f.pending();
      f.state.pending = result;
      if (result && !result.canceled) await assert.rejects(f.service.recoverPendingImagePick(f.db));
      else await f.service.recoverPendingImagePick(f.db);
      assert.equal(await f.db.getFirstAsync('SELECT * FROM pending_image_pick'), null);
      assert.equal((await f.photos()).length, 0);
      await f.service.recoverPendingImagePick(f.db);
    } finally { await f.db.closeAsync(); }
  }
});

test('a result without its request or for a deleted marker is discarded', async () => {
  const f = await fixture();
  try {
    await f.pending();
    await f.db.runAsync('DELETE FROM markers WHERE id = ?', 2);
    f.state.pending = f.success;
    await f.service.recoverPendingImagePick(f.db);
    assert.equal((await f.photos()).length, 0);
    assert.equal(await f.db.getFirstAsync('SELECT * FROM pending_image_pick'), null);
  } finally { await f.db.closeAsync(); }
});

test('a consumed native result remains recoverable after a save error and another JS restart', async () => {
  const f = await fixture();
  try {
    await f.pending();
    f.state.pending = f.success;
    f.state.saveFails = true;
    await assert.rejects(f.service.recoverPendingImagePick(f.db), (error) => /save failed/.test(error.cause.message));
    assert.equal((await f.photos()).length, 0);
    assert.equal((await f.db.getFirstAsync('SELECT source_uri FROM pending_image_pick')).source_uri, 'file:///picker/selected.jpg');
    assert.equal(f.state.pending, null);
    f.state.saveFails = false;
    await f.loadSession().recoverPendingImagePick(f.db);
    assert.equal((await f.photos()).length, 1);
    assert.equal(f.state.reads, 1);
  } finally { await f.db.closeAsync(); }
});

test('normal save retries the same photo; transaction rollback cannot duplicate the INSERT', async () => {
  const f = await fixture();
  try {
    await f.db.execAsync(`CREATE TRIGGER block_consumption BEFORE DELETE ON pending_image_pick
      BEGIN SELECT RAISE(ABORT, 'consume failed'); END;`);
    const task = f.service.createImagePickTask(1);
    await assert.rejects(task(f.db), /consume failed/);
    assert.equal((await f.photos()).length, 0);
    assert.ok(await f.db.getFirstAsync('SELECT source_uri FROM pending_image_pick'));
    await f.db.execAsync('DROP TRIGGER block_consumption');
    await task(f.db);
    assert.equal(f.state.launches, 1);
    assert.equal((await f.photos()).length, 1);
  } finally { await f.db.closeAsync(); }
});

test('startup recovery does not consume the result of a currently open picker', async () => {
  const f = await fixture();
  let release;
  try {
    f.state.launch = () => new Promise((resolve) => { release = resolve; });
    const picking = f.service.createImagePickTask(1)(f.db);
    await new Promise(setImmediate);
    const reads = f.state.reads;
    await f.service.recoverPendingImagePick(f.db);
    assert.equal(f.state.reads, reads);
    await assert.rejects(f.service.createImagePickTask(2)(f.db), /уже открыт/);
    release(f.success);
    await picking;
    assert.equal((await f.photos()).length, 1);
  } finally { await f.db.closeAsync(); }
});

test('iOS uses the normal picker and never asks for the Android pending result', async () => {
  const f = await fixture('ios');
  try {
    await f.service.createImagePickTask(1)(f.db);
    assert.equal(f.state.reads, 0);
    assert.equal((await f.photos()).length, 1);
  } finally { await f.db.closeAsync(); }
});

test('unrecoverable pending photo can be discarded without deleting saved photos or markers', async () => {
  const f = await fixture();
  try {
    await f.service.createImagePickTask(1)(f.db);
    await f.pending(2);
    f.state.pending = f.success;
    f.state.saveFails = true;
    await assert.rejects(f.service.recoverPendingImagePick(f.db));
    await f.service.discardPendingImagePick(f.db);
    await f.service.recoverPendingImagePick(f.db);
    assert.equal((await f.photos()).length, 1);
    assert.equal((await f.db.getAllAsync('SELECT * FROM markers')).length, 2);
    assert.equal(await f.db.getFirstAsync('SELECT * FROM pending_image_pick'), null);
  } finally { await f.db.closeAsync(); }
});
