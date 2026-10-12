const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('route ID accepts positive safe integers and rejects ambiguous or invalid parameters', () => {
  const exports = {};
  const source = ts.transpileModule(readFileSync('utils/parseMarkerId.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports });
  const { parseMarkerId } = exports;
  assert.equal(parseMarkerId('1'), 1);
  assert.equal(parseMarkerId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const invalid of [undefined, '', 'abc', '0', '-1', '1.5', '1e2', '01', ' 1', 'Infinity', '9007199254740992', ['1', '2']]) {
    assert.equal(parseMarkerId(invalid), null);
  }
});
