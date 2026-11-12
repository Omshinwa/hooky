'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWord, countMatches, findConflicts } = require('../logic.js');

test('normalizeWord uppercases, folds accents and drops non-letters', () => {
  assert.equal(normalizeWord('brave'), 'BRAVE');
  assert.equal(normalizeWord(' Café '), 'CAFE');
  assert.equal(normalizeWord('cœur'), 'COEUR');
  assert.equal(normalizeWord("o'k-a y"), 'OKAY');
  assert.equal(normalizeWord(''), '');
  assert.equal(normalizeWord(null), '');
});

test('countMatches counts every occurrence', () => {
  assert.equal(countMatches('NEVER', ['E', 'N']), 3);
  assert.equal(countMatches('BRAVE', ['A', 'B', 'C']), 2);
  assert.equal(countMatches('BRAVE', ['X', 'Y', 'Z']), 0);
  assert.equal(countMatches('EERIE', ['E']), 3);
});

test('findConflicts reports player pairs, never letters', () => {
  assert.deepEqual(findConflicts([['A', 'B'], ['C', 'D'], ['E', 'F']]), []);
  assert.deepEqual(findConflicts([['A', 'B'], ['B', 'C'], ['D']]), [{ a: 0, b: 1, count: 1 }]);
  assert.deepEqual(findConflicts([['A', 'B'], ['A', 'B'], ['C']]), [{ a: 0, b: 1, count: 2 }]);
  assert.deepEqual(findConflicts([['A'], ['A'], ['A']]), [
    { a: 0, b: 1, count: 1 },
    { a: 0, b: 2, count: 1 },
    { a: 1, b: 2, count: 1 },
  ]);
});
