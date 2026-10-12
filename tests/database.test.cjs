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
  };
}

test('точная схема, foreign_keys до транзакции, CRUD, параметры и каскад', async () => {
  const db = connection();
  const api = loadLayer(async () => db);
  await api.initDatabase();
  try {
    assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 1);
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
  for (const version of [-1, 0, 2]) {
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
