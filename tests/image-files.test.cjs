const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const vm = require('node:vm');
const ts = require('typescript');

// Нативный File/Directory заменён адаптером к временным файлам Node.js.
// Исполняется настоящий код сервисов; UI и нативный мост требуют проверки в Expo Go.
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'map-photos-'));
  const options = { copyFails: false, deleteFails: false, emptyCopy: false, copyGate: null, onCopyStarted: null };
  function joinParts(parts) {
    const first = typeof parts[0] === 'string' ? parts[0] : parts[0].uri;
    return pathToFileURL(path.resolve(fileURLToPath(first), ...parts.slice(1))).href;
  }
  class Directory {
    constructor(...parts) { this.uri = joinParts(parts); }
    get exists() { return fs.existsSync(fileURLToPath(this.uri)); }
    create() { fs.mkdirSync(fileURLToPath(this.uri), { recursive: true }); }
    list() {
      return fs.readdirSync(fileURLToPath(this.uri), { withFileTypes: true }).map((entry) =>
        entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name));
    }
  }
  class File {
    constructor(...parts) { this.uri = joinParts(parts); }
    get name() { return path.basename(fileURLToPath(this.uri)); }
    get extension() { return path.extname(this.name); }
    get parentDirectory() { return new Directory(pathToFileURL(path.dirname(fileURLToPath(this.uri))).href); }
    get exists() { return fs.existsSync(fileURLToPath(this.uri)); }
    get size() { return fs.statSync(fileURLToPath(this.uri)).size; }
    async copy(destination) {
      options.onCopyStarted?.();
      if (options.copyGate) await options.copyGate;
      await fs.promises.copyFile(fileURLToPath(this.uri), fileURLToPath(destination.uri));
      if (options.emptyCopy) fs.truncateSync(fileURLToPath(destination.uri), 0);
      if (options.copyFails) throw new Error('copy failed after partial write');
    }
    delete() {
      if (options.deleteFails) throw new Error('delete failed');
      fs.unlinkSync(fileURLToPath(this.uri));
    }
  }
  const documents = new Directory(pathToFileURL(path.join(root, 'documents')).href);
  documents.create();
  const source = pathToFileURL(path.join(root, 'source.jpg')).href;
  fs.writeFileSync(fileURLToPath(source), 'test image bytes');
  const rows = [];
  let insertFails = false;
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
        if (name === 'expo-file-system') return { File, Directory, Paths: { document: documents } };
        return load(path.resolve(path.dirname(filename), `${name}.ts`));
      },
    }, { filename });
    return module.exports;
  }
  const files = load(path.resolve(__dirname, '../services/imageFiles.ts'));
  const saving = load(path.resolve(__dirname, '../services/saveMarkerImage.ts'));
  const db = {
    async runAsync(_sql, markerId, savedUri) {
      if (insertFails) throw new Error('insert failed');
      assert.match(savedUri, /^marker-photos\/photo-/);
      assert.ok(fs.statSync(fileURLToPath(files.resolveImageUri(savedUri))).size > 0);
      rows.push({ markerId, uri: savedUri });
    },
  };
  return {
    ...files, ...saving, source, rows, options, documents, db,
    setInsertFailure(value) { insertFails = value; },
    photos() { return new Directory(documents, 'marker-photos').list(); },
    relocateDocuments() {
      const previous = fileURLToPath(documents.uri);
      const destination = path.join(root, 'relocated-documents');
      assert.equal(path.dirname(previous), root);
      assert.equal(path.dirname(destination), root);
      // Моделируем перенос файлов без rename каталога, запрещённого Windows sandbox.
      const previousPhotos = path.join(previous, 'marker-photos');
      const nextPhotos = path.join(destination, 'marker-photos');
      fs.mkdirSync(nextPhotos, { recursive: true });
      for (const name of fs.readdirSync(previousPhotos)) {
        fs.copyFileSync(path.join(previousPhotos, name), path.join(nextPhotos, name));
        fs.unlinkSync(path.join(previousPhotos, name));
      }
      fs.rmdirSync(previousPhotos);
      fs.rmdirSync(previous);
      documents.uri = pathToFileURL(destination).href;
    },
    cleanup() {
      // Только точные файлы внутри созданной тестом папки; без рекурсивного удаления.
      const folder = path.join(fileURLToPath(documents.uri), 'marker-photos');
      if (fs.existsSync(folder)) {
        for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
        fs.rmdirSync(folder);
      }
      fs.rmdirSync(fileURLToPath(documents.uri));
      fs.unlinkSync(fileURLToPath(source));
      fs.rmdirSync(root);
    },
  };
}

test('копии уникальны, в БД попадают только существующие файлы; оригинал не удаляется', async () => {
  const f = fixture();
  try {
    await f.saveMarkerImage(f.db, 1, f.source);
    await f.saveMarkerImage(f.db, 2, f.source);
    assert.equal(f.rows.length, 2);
    assert.notEqual(f.rows[0].uri, f.rows[1].uri);
    f.removeUnusedImageCopies([f.rows[1].uri]);
    assert.equal(f.photos().length, 1);
    assert.ok(fs.existsSync(fileURLToPath(f.resolveImageUri(f.rows[1].uri))));
    f.removeImageCopy(f.source);
    assert.ok(fs.existsSync(fileURLToPath(f.source)));
    f.removeUnusedImageCopies([]);
    assert.equal(f.photos().length, 0);
  } finally { f.cleanup(); }
});

test('сбой копирования не создаёт запись, сбой INSERT удаляет копию', async () => {
  const f = fixture();
  try {
    f.options.copyFails = true;
    await assert.rejects(f.saveMarkerImage(f.db, 1, f.source), (error) => /copy failed/.test(error.cause.message));
    assert.equal(f.rows.length, 0);
    assert.equal(f.photos().length, 0);
    f.options.copyFails = false;
    f.setInsertFailure(true);
    await assert.rejects(f.saveMarkerImage(f.db, 1, f.source));
    assert.equal(f.rows.length, 0);
    assert.equal(f.photos().length, 0);
  } finally { f.cleanup(); }
});

test('очистка повторяется после ошибки и сохраняет используемые и чужие файлы', async () => {
  const f = fixture();
  try {
    await f.saveMarkerImage(f.db, 1, f.source);
    f.setInsertFailure(true);
    f.options.deleteFails = true;
    await assert.rejects(f.saveMarkerImage(f.db, 1, f.source));
    assert.equal(f.photos().length, 2);
    await assert.rejects(async () => f.removeUnusedImageCopies(f.rows.map((row) => row.uri)));
    f.options.deleteFails = false;
    const foreign = path.join(fileURLToPath(f.documents.uri), 'marker-photos', 'foreign.txt');
    fs.writeFileSync(foreign, 'keep');
    f.removeUnusedImageCopies(f.rows.map((row) => row.uri));
    assert.equal(f.photos().length, 2);
    assert.ok(fs.existsSync(foreign));
    assert.ok(fs.existsSync(fileURLToPath(f.resolveImageUri(f.rows[0].uri))));
  } finally { f.cleanup(); }
});

test('сохранение ждёт завершения копирования перед INSERT', async () => {
  const f = fixture();
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  f.options.copyGate = new Promise((resolve) => { release = resolve; });
  f.options.onCopyStarted = started;
  const saving = f.saveMarkerImage(f.db, 1, f.source);
  try {
    await began;
    assert.equal(f.rows.length, 0);
    assert.equal(f.photos().length, 0);
    release();
    await saving;
    assert.equal(f.rows.length, 1);
    assert.equal(f.photos().length, 1);
  } finally { release(); await saving.catch(() => undefined); f.cleanup(); }
});

test('пустая копия не записывается в БД и удаляется', async () => {
  const f = fixture();
  try {
    f.options.emptyCopy = true;
    await assert.rejects(f.saveMarkerImage(f.db, 1, f.source));
    assert.equal(f.rows.length, 0);
    assert.equal(f.photos().length, 0);
  } finally { f.cleanup(); }
});

test('смена корня документов сохраняет фото: относительные и старые абсолютные пути', async () => {
  const f = fixture();
  try {
    await f.saveMarkerImage(f.db, 1, f.source);
    await f.saveMarkerImage(f.db, 2, f.source);
    await f.copyImageToDocuments(f.source); // Копия без записи в БД должна удалиться.
    const relative = f.rows[0].uri;
    const oldAbsolute = f.resolveImageUri(f.rows[1].uri);
    const oldRelativeResolved = f.resolveImageUri(relative);
    f.relocateDocuments();
    f.removeUnusedImageCopies([relative, oldAbsolute]);
    assert.equal(f.photos().length, 2);
    assert.notEqual(f.resolveImageUri(relative), oldRelativeResolved);
    assert.notEqual(f.resolveImageUri(oldAbsolute), oldAbsolute);
    for (const stored of [relative, oldAbsolute]) {
      assert.equal(fs.readFileSync(fileURLToPath(f.resolveImageUri(stored)), 'utf8'), 'test image bytes');
    }
    f.removeUnusedImageCopies([]);
    assert.equal(f.photos().length, 0);
  } finally { f.cleanup(); }
});

test('чужие URI и обход каталога не разрешаются как фотографии приложения', () => {
  const f = fixture();
  try {
    for (const uri of [
      f.source,
      'file:///gallery/photo-123-abc.jpg',
      'content://media/marker-photos/photo-123-abc.jpg',
      'https://example.com/marker-photos/photo-123-abc.jpg',
      'marker-photos/../photo-123-abc.jpg',
      'marker-photos/photo-123-abc.jpg/extra',
      'marker-photos/foreign.txt',
      'marker-photos/photo-123-abc.jpg\n',
    ]) {
      assert.equal(f.resolveImageUri(uri), uri);
    }
  } finally { f.cleanup(); }
});
