const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, readFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Выполняем настоящий код слоя данных на настоящем SQLite из Node.js.
// Адаптер заменяет только нативный мост Expo; проверка на телефоне нужна отдельно.
function connection(filename = ':memory:', failSql) {
  const sqlite = new DatabaseSync(filename, { enableForeignKeyConstraints: false });
  const db = {
    closed: false,
    async execAsync(sql) {
      if (sql === 'BEGIN') {
        assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      }
      if (failSql?.(sql)) throw new Error('Injected transaction failure');
      sqlite.exec(sql);
    },
    async runAsync(sql, ...params) {
      const result = sqlite.prepare(sql).run(...params);
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async getFirstAsync(sql, ...params) {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async getAllAsync(sql, ...params) {
      return sqlite.prepare(sql).all(...params);
    },
    async withTransactionAsync(action) {
      try {
        await db.execAsync('BEGIN');
        await action();
        await db.execAsync('COMMIT');
      } catch (error) {
        await db.execAsync('ROLLBACK');
        throw error;
      }
    },
    async closeAsync() { sqlite.close(); db.closed = true; },
  };
  return db;
}

function loadLayer(openDatabaseAsync) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, __DEV__: false,
      console: { info() { assert.fail('Production log'); }, warn() { assert.fail('Production log'); } },
      require(name) {
        if (name === 'expo-sqlite') return { openDatabaseAsync };
        return load(path.resolve(path.dirname(filename), `${name}.ts`));
      },
    }, { filename });
    return module.exports;
  }
  return {
    ...load(path.resolve(__dirname, '../database/schema.ts')),
    ...load(path.resolve(__dirname, '../database/operations.ts')),
    ...load(path.resolve(__dirname, '../database/connection.ts')),
    ...load(path.resolve(__dirname, '../services/createDataTask.ts')),
  };
}

test('точная схема, foreign_keys до транзакции, CRUD, параметры и каскад', async () => {
  const db = connection();
  const api = loadLayer(async () => db);
  await api.initDatabase();
  try {
    assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 2);
    for (const [table, names, types] of [
      ['markers', ['id', 'latitude', 'longitude', 'created_at'], ['INTEGER', 'REAL', 'REAL', 'DATETIME']],
      ['marker_images', ['id', 'marker_id', 'uri', 'created_at'], ['INTEGER', 'INTEGER', 'TEXT', 'DATETIME']],
    ]) {
      const columns = await db.getAllAsync(`PRAGMA table_info(${table})`);
      assert.deepEqual(columns.map((c) => c.name), names);
      assert.deepEqual(columns.map((c) => c.type), types);
      assert.deepEqual(columns.map((c) => c.notnull), [0, 1, 1, 0]);
      assert.equal(columns[0].pk, 1);
      assert.equal(columns[3].dflt_value, 'CURRENT_TIMESTAMP');
      const definition = await db.getFirstAsync('SELECT sql FROM sqlite_master WHERE name = ?', table);
      assert.match(definition.sql, /AUTOINCREMENT/);
    }
    const fk = await db.getFirstAsync('PRAGMA foreign_key_list(marker_images)');
    assert.equal(fk.table, 'markers');
    assert.equal(fk.from, 'marker_id');
    assert.equal(fk.to, 'id');
    assert.equal(fk.on_delete, 'CASCADE');

    const a = await api.addMarker(db, 56.8, 60.6);
    const b = await api.addMarker(db, 57.1, 61.2);
    assert.equal(typeof a, 'number');
    assert.notEqual(a, b);
    const uri = "file:///photo's.jpg'); DROP TABLE markers; --";
    await api.addImage(db, a, uri);
    await api.addImage(db, a, 'file:///second.jpg');
    await api.addImage(db, b, 'file:///other.jpg');
    const photos = await api.getMarkerImages(db, a);
    assert.equal(photos.length, 2);
    assert.equal(photos[0].uri, uri);
    assert.equal(photos[0].markerId, a);
    assert.match(photos[0].createdAt, /^\d{4}-\d{2}-\d{2} /);
    assert.equal((await api.getMarkers(db))[0].latitude, 56.8);

    await api.deleteImage(db, photos[0].id);
    assert.equal((await api.getMarkerImages(db, a)).length, 1);
    await api.deleteMarker(db, a);
    assert.equal((await api.getMarkerImages(db, a)).length, 0);
    assert.equal((await api.getMarkerImages(db, b)).length, 1);
    assert.equal((await api.getMarkers(db)).length, 1);
    await assert.rejects(api.addImage(db, a, 'orphan'), (e) => /FOREIGN KEY/.test(e.cause.message));
    await assert.rejects(api.addImage(db, b, null), (e) => /NOT NULL/.test(e.cause.message));
    assert.equal((await api.getMarkerImages(db, b)).length, 1);

    // Если каскад не удался, сам маркер тоже не должен исчезнуть.
    await db.execAsync(`CREATE TRIGGER block_image_delete BEFORE DELETE ON marker_images
      BEGIN SELECT RAISE(ABORT, 'blocked cascade'); END;`);
    await assert.rejects(api.deleteMarker(db, b), (e) => /blocked cascade/.test(e.cause.message));
    assert.equal((await api.getMarkers(db))[0].id, b);
    assert.equal((await api.getMarkerImages(db, b)).length, 1);
  } finally { await db.closeAsync(); }
});

test('повторная инициализация сохраняет строки и счётчик ID на диске', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'map-sqlite-'));
  const filename = path.join(directory, 'test.db');
  const api = loadLayer(async () => connection(filename));
  let db;
  try {
    db = await api.initDatabase();
    const id = await api.addMarker(db, 1, 2);
    await api.addImage(db, id, 'saved-photo');
    const before = JSON.stringify(await api.getMarkers(db));
    await db.closeAsync();
    db = await api.initDatabase();
    assert.equal(JSON.stringify(await api.getMarkers(db)), before);
    assert.equal((await api.getMarkerImages(db, id))[0].uri, 'saved-photo');
    assert.ok(await api.addMarker(db, 3, 4) > id);
  } finally {
    if (db && !db.closed) await db.closeAsync();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});

test('ошибка транзакции откатывает обе таблицы и версию, файл не сбрасывается', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'map-sqlite-'));
  const filename = path.join(directory, 'test.db');
  const db = connection(filename, (sql) => sql === 'PRAGMA user_version = 1;');
  const api = loadLayer(async () => db);
  await assert.rejects(api.initDatabase(), (e) => /Injected/.test(e.cause.message));
  assert.equal(db.closed, true);
  const check = connection(filename);
  try {
    assert.equal((await check.getFirstAsync('PRAGMA user_version')).user_version, 0);
    assert.equal((await check.getAllAsync("SELECT name FROM sqlite_master WHERE name IN ('markers', 'marker_images')")).length, 0);
  } finally { await check.closeAsync(); unlinkSync(filename); rmdirSync(directory); }
});

test('слишком новая версия и конфликт схемы не удаляют существующие данные', async () => {
  for (const version of [-1, 0, 3]) {
    const directory = mkdtempSync(path.join(tmpdir(), 'map-sqlite-'));
    const filename = path.join(directory, 'test.db');
    const db = connection(filename);
    await db.execAsync(`CREATE TABLE markers (note TEXT); INSERT INTO markers VALUES ('keep'); PRAGMA user_version = ${version};`);
    const api = loadLayer(async () => db);
    await assert.rejects(api.initDatabase());
    assert.equal(db.closed, true);
    const check = connection(filename);
    try {
      assert.equal((await check.getFirstAsync('SELECT note FROM markers')).note, 'keep');
      assert.equal((await check.getFirstAsync('PRAGMA user_version')).user_version, version);
    } finally { await check.closeAsync(); unlinkSync(filename); rmdirSync(directory); }
  }
});

test('ошибки открытия и запросов сохраняют исходную причину', async () => {
  const cause = new Error('Cannot open database');
  const api = loadLayer(async () => { throw cause; });
  await assert.rejects(api.initDatabase(), (e) => e.cause === cause);
  const db = connection();
  await assert.rejects(api.getMarkers(db), (e) => /no such table/.test(e.cause.message));
  await db.closeAsync();
});

test('одно соединение, последовательные запросы и закрытие после активного запроса', async () => {
  const opened = [];
  const api = loadLayer(async () => {
    assert.ok(opened.every((db) => db.closed));
    const db = connection();
    opened.push(db);
    return db;
  });
  const owner = api.createDatabaseConnection();
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const first = owner.run(async (db) => {
    started();
    await gate;
    assert.equal(db.closed, false);
    return api.addMarker(db, 1, 2);
  });
  await began;
  const second = owner.run((db) => api.getMarkers(db));
  const closing = owner.close();
  const reopened = owner.run((db) => api.getMarkers(db));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, false);
  release();
  assert.equal(await first, 1);
  assert.equal((await second).length, 1);
  await closing;
  assert.equal((await reopened).length, 0);
  assert.equal(opened.length, 2);
  await owner.close();
  assert.ok(opened.every((db) => db.closed));
});

test('повтор чтения после успешной записи не создаёт дубликат', async () => {
  const db = connection();
  const api = loadLayer(async () => db);
  await api.initDatabase();
  let attempts = 0;
  const task = api.createDataTask(
    (database) => api.addMarker(database, 10, 20),
    async () => { if (++attempts === 1) throw new Error('refresh failed'); },
  );
  await assert.rejects(task(db), /refresh failed/);
  assert.equal(await task(db), 1);
  assert.equal((await api.getMarkers(db)).length, 1);
  await db.closeAsync();
});

test('неудачный запрос не ломает очередь, инициализацию можно повторить', async () => {
  let attempts = 0;
  const api = loadLayer(async () => {
    if (++attempts === 1) throw new Error('open failed');
    return connection();
  });
  const owner = api.createDatabaseConnection();
  await assert.rejects(owner.run(api.getMarkers));
  const id = await owner.run((db) => api.addMarker(db, 1, 2));
  await assert.rejects(owner.run((db) => api.addImage(db, id + 1, 'orphan')));
  assert.equal((await owner.run(api.getMarkers)).length, 1);
  await owner.close();
});

// Снимок схемы версии 1: проверяем обновление уже существующей базы.
async function createVersionOne(db) {
  await db.execAsync(`
    CREATE TABLE markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE marker_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marker_id INTEGER NOT NULL,
      uri TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (marker_id) REFERENCES markers (id) ON DELETE CASCADE
    );
    INSERT INTO markers (id, latitude, longitude) VALUES (7, 56.8, 60.6);
    PRAGMA user_version = 1;
  `);
}

test('новые фотографии хранятся относительно документов, без корня контейнера', async () => {
  const db = connection();
  const api = loadLayer(async () => db);
  await api.initDatabase();
  try {
    const id = await api.addMarker(db, 1, 2);
    await api.addImage(db, id, 'file:///old/Documents/marker-photos/photo-123-abc.jpg');
    const row = await db.getFirstAsync('SELECT uri FROM marker_images');
    assert.equal(row.uri, 'marker-photos/photo-123-abc.jpg');
    assert.equal((await api.getMarkerImages(db, id))[0].uri, row.uri);
    assert.equal((await api.getAllImages(db))[0].uri, row.uri);
  } finally { await db.closeAsync(); }
});

test('миграция v1 → v2 сохраняет строки, связи и даты; повторное открытие ничего не меняет', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'map-migration-'));
  const filename = path.join(directory, 'test.db');
  const api = loadLayer(async () => connection(filename));
  let db = connection(filename);
  try {
    await createVersionOne(db);
    const uris = [
      'file:///var/mobile/Containers/Data/Application/OLD/Documents/marker-photos/photo-123-abc.jpg',
      'file:///data/user/0/host.exp.exponent/files/ExperienceData/%40user%2Fapp/marker-photos/photo-124-def',
      'marker-photos/photo-125-ghi.png',
      'file:///gallery/original.jpg',
      'content://media/external/images/123',
      "file:///gallery/photo's.jpg",
      'file:///old/Documents/marker-photos/foreign.txt',
    ];
    for (const [index, uri] of uris.entries()) {
      await db.runAsync('INSERT INTO marker_images (marker_id, uri, created_at) VALUES (?, ?, ?)',
        7, uri, index === 0 ? null : '2026-10-12 12:34:56');
    }
    const before = await db.getAllAsync('SELECT * FROM marker_images ORDER BY id');
    const markersBefore = await db.getAllAsync('SELECT * FROM markers');
    await db.closeAsync();
    db = await api.initDatabase();
    const after = await db.getAllAsync('SELECT * FROM marker_images ORDER BY id');
    assert.deepEqual(after.map((row) => ({ ...row })), before.map((row, index) => ({
      ...row, uri: index < 2 ? `marker-photos/${uris[index].split('/').at(-1)}` : row.uri,
    })));
    assert.deepEqual(await db.getAllAsync('SELECT * FROM markers'), markersBefore);
    assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 2);
    assert.equal((await db.getFirstAsync('PRAGMA foreign_keys')).foreign_keys, 1);
    assert.equal((await db.getAllAsync('PRAGMA foreign_key_check')).length, 0);
    await db.closeAsync();
    db = await api.initDatabase();
    assert.deepEqual(await db.getAllAsync('SELECT * FROM marker_images ORDER BY id'), after);
    await api.deleteMarker(db, 7);
    assert.equal((await api.getAllImages(db)).length, 0);
  } finally {
    if (!db.closed) await db.closeAsync();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});

test('ошибка миграции откатывает все URI и версию, повтор завершается успешно', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'map-migration-'));
  const filename = path.join(directory, 'test.db');
  let db = connection(filename);
  try {
    await createVersionOne(db);
    for (const uri of [
      'file:///old/Documents/marker-photos/photo-123-abc.jpg',
      'file:///old/Documents/marker-photos/photo-124-def.png',
    ]) {
      await db.runAsync('INSERT INTO marker_images (marker_id, uri) VALUES (?, ?)', 7, uri);
    }
    const before = await db.getAllAsync('SELECT * FROM marker_images ORDER BY id');
    await db.closeAsync();
    db = connection(filename, (sql) => sql === 'PRAGMA user_version = 2;');
    const failingApi = loadLayer(async () => db);
    await assert.rejects(failingApi.initDatabase(), (error) => /Injected/.test(error.cause.message));
    assert.equal(db.closed, true);
    db = connection(filename);
    assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 1);
    assert.deepEqual(await db.getAllAsync('SELECT * FROM marker_images ORDER BY id'), before);
    const api = loadLayer(async () => db);
    await api.initDatabase();
    assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 2);
    assert.ok((await api.getAllImages(db)).every((row) => row.uri.startsWith('marker-photos/')));
  } finally {
    if (!db.closed) await db.closeAsync();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});
