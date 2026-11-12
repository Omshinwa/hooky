/* Pure helpers, shared by the page (window.HookyLogic) and the tests (require). */
(function (root) {
  'use strict';

  /** Uppercase, fold accents (É→E, Œ→OE) and drop anything that isn't A–Z. */
  function normalizeWord(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/Œ/g, 'OE')
      .replace(/Æ/g, 'AE')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z]/g, '');
  }

  /** Every occurrence counts: NEVER against a hand holding E and N scores 3. */
  function countMatches(word, letters) {
    const hand = new Set(letters);
    let n = 0;
    for (const c of word) if (hand.has(c)) n += 1;
    return n;
  }

  /**
   * Pairs of players who entered at least one identical letter.
   * Returns [{ a, b, count }] with player indexes a < b. The letters themselves
   * are not returned, so the warning never reveals anyone's hand.
   */
  function findConflicts(hands) {
    const owners = new Map();
    hands.forEach((hand, i) => {
      for (const l of new Set(hand)) {
        if (!owners.has(l)) owners.set(l, []);
        owners.get(l).push(i);
      }
    });
    const pairs = new Map();
    for (const idx of owners.values()) {
      for (let x = 0; x < idx.length; x++) {
        for (let y = x + 1; y < idx.length; y++) {
          const key = `${idx[x]},${idx[y]}`;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    }
    return [...pairs]
      .map(([key, count]) => {
        const [a, b] = key.split(',').map(Number);
        return { a, b, count };
      })
      .sort((p, q) => p.a - q.a || p.b - q.b);
  }

  const api = { normalizeWord, countMatches, findConflicts };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HookyLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
