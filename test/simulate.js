'use strict';
// Simule des parties complètes avec des bots et vérifie règles + score.
const assert = require('assert');
const WebSocket = require('ws');
const { server, normalizeWord, countIn } = require('../server');

const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

assert.strictEqual(normalizeWord('Élève'), 'ELEVE');
assert.strictEqual(normalizeWord('cœurs'), null); // COEURS = 6 lettres → refusé
assert.strictEqual(normalizeWord('Sœur'), 'SOEUR');
assert.strictEqual(normalizeWord('Paris'), 'PARIS');
assert.strictEqual(normalizeWord('abc'), null);
assert.strictEqual(countIn('NEVER', ['E', 'N']), 3);
assert.strictEqual(countIn('DADDY', ['D']), 3);

function bot(port, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const b = { name, ws, s: null, errors: [], waiters: [] };
    b.send = (m) => ws.send(JSON.stringify(m));
    b.next = () => new Promise((r) => b.waiters.push(r));
    // envoie une action et attend la réponse du serveur (état ou erreur)
    b.act = async (m) => { const p = b.next(); b.send(m); await Promise.race([p, sleep(2000)]); await settle(); };
    ws.on('message', (d) => {
      lastMsg = Date.now();
      const m = JSON.parse(d);
      if (m.t === 'state') { b.s = m.s; b.waiters.splice(0).forEach((r) => r()); }
      if (m.t === 'error') { b.errors.push(m.msg); b.waiters.splice(0).forEach((r) => r()); }
    });
    ws.on('open', () => resolve(b));
  });
}

let lastMsg = Date.now();
// attend que plus aucun message n'arrive pendant 15 ms
async function settle() {
  await sleep(5);
  while (Date.now() - lastMsg < 15) await sleep(5);
}

async function playGame(port, count, opts = {}) {
  const bots = [];
  for (let i = 0; i < count; i++) bots.push(await bot(port, `Bot${i}`));
  await settle();
  for (const b of bots) { await b.act({ t: 'join', name: b.name }); }
  assert.strictEqual(bots[0].s.players.length, count);
  await bots[0].act({ t: 'start' });
  const byId = () => Object.fromEntries(bots.map((b) => [b.s.me.id, b]));
  const B = byId();
  const s0 = bots[0].s;
  assert.strictEqual(s0.phase, 'clues');
  // Les mains ne fuient pas
  for (const b of bots) for (const p of b.s.players) assert.ok(!('hand' in p));
  const all = bots.flatMap((b) => b.s.me.hand);
  assert.strictEqual(new Set(all).size, all.length);
  assert.strictEqual(all.length, { 3: 21, 4: 20, 5: 20 }[count]);

  const active = () => B[bots[0].s.activeId];

  // Ouverture
  for (let i = 0; i < count; i++) {
    const a = active();
    const others = bots.filter((x) => x !== a);
    // Mauvais joueur
    await others[0].act({ t: 'clue', word: 'AAAAA' });
    assert.match(others[0].errors.pop(), /pas ton tour/);
    // Mot sans aucune de ses lettres
    const notMine = L.filter((l) => !a.s.me.hand.includes(l));
    await a.act({ t: 'clue', word: notMine.slice(0, 5).join('') });
    assert.match(a.errors.pop(), /au moins une/);
    await a.act({ t: 'clue', word: 'abc' });
    assert.match(a.errors.pop(), /5 lettres/);
    const word = a.s.me.hand[0] + notMine.slice(0, 4).join('');
    await a.act({ t: 'clue', word });
    const e = bots[0].s.log.filter((x) => x.k === 'clue').pop();
    assert.strictEqual(e.word, word); assert.strictEqual(e.count, 1);
  }
  assert.strictEqual(bots[0].s.phase, 'play');
  assert.strictEqual(bots[0].s.round, 1);

  let reveals = 0;
  while (bots[0].s.phase !== 'over') {
    const s = bots[0].s;
    if (s.phase === 'play') {
      const a = active();
      const r = s.round;
      const others = bots.filter((x) => x !== a);
      if (r === 1 && Math.random() < 0.3) {
        await a.act({ t: 'reveal', letter: a.s.me.hand[0], target: others[0].s.me.id });
        assert.match(a.errors.pop(), /manche 2/);
      }
      const doReveal = a.s.me.canReveal && Math.random() < 0.4;
      const revealFirst = doReveal && Math.random() < 0.5;
      const reveal = async () => {
        const mine = a.s.me.hand.filter((l) => !a.s.me.revealed.includes(l));
        const tg = bots.find((x) => x !== a && x.s.players.find((p) => p.id === x.s.me.id).handSize - x.s.me.revealed.length > 0);
        const before = a.s.me.peeks.length;
        await a.act({ t: 'reveal', letter: mine[0], target: tg.s.me.id });
        assert.strictEqual(a.errors.length, 0, a.errors.join());
        const pk = a.s.me.peeks[before];
        assert.ok(tg.s.me.hand.includes(pk.letter), 'carte vue dans la main cible');
        assert.strictEqual(a.s.me.revealed.length, mine.length ? a.s.me.revealed.length : 0);
        // la carte vue reste privée
        for (const o of others) assert.ok(!o.s.me.peeks.some((x) => x === pk || (x.round === pk.round && x.target === pk.target && o.s.me.id !== a.s.me.id && o.s.log.length < 0)));
        assert.ok(!JSON.stringify(others[0].s.log).includes(`"letter":"${pk.letter}","target":"${tg.s.me.id}","seen"`));
        reveals++;
      };
      // anagramme d'un mot déjà répondu par une cible → refusé
      const tgt = others.find((o) => (s.asked[o.s.me.id] || []).length);
      if (tgt) {
        const key = s.asked[tgt.s.me.id][0];
        await a.act({ t: 'ask', target: tgt.s.me.id, word: [...key].reverse().join('') });
        assert.match(a.errors.pop() || '', /déjà répondu/);
      }
      if (revealFirst) await reveal();
      const target = rnd(others);
      let word;
      const asked = s.asked[target.s.me.id] || [];
      do word = Array.from({ length: 5 }, () => rnd(L)).join(''); while (asked.includes([...word].sort().join('')));
      await a.act({ t: 'ask', target: target.s.me.id, word });
      assert.strictEqual(a.errors.length, 0, a.errors.join());
      const e = bots[0].s.log.filter((x) => x.k === 'ask').pop();
      assert.strictEqual(e.count, countIn(word, target.s.me.hand), 'comptage');
      // anagramme interdit
      if (bots[0].s.activeId === a.s.me.id) {
        await a.act({ t: 'ask', target: target.s.me.id, word });
        assert.match(a.errors.pop(), /déjà posé/);
        if (doReveal && !revealFirst) await reveal();
        else if (bots[0].s.activeId === a.s.me.id) { await a.act({ t: 'endTurn' }); }
      }
      if (!(bots[0].s.activeId !== a.s.me.id || bots[0].s.phase !== 'play')) { console.log({r, doReveal, revealFirst, turn: bots[0].s.turn, round: bots[0].s.round, canRev: a.s.me.canReveal, errs: a.errors, n: count, last: bots[0].s.log.slice(-4)}); throw new Error('le tour doit passer'); }
    } else if (s.phase === 'guess') {
      const r = s.round;
      assert.ok([4, 5].includes(r));
      assert.strictEqual(s.centerShown.length, s.cfg.center);
      await bots[0].act({ t: 'guess', letters: ['A', 'A', 'B'] });
      assert.match(bots[0].errors.pop(), /différentes/);
      for (const b of bots) {
        const letters = [...new Set(Array.from({ length: 10 }, () => rnd(L)))].slice(0, 3);
        await b.act({ t: 'guess', letters });
      }
      assert.strictEqual(bots[0].s.round, r + 1);
    } else if (s.phase === 'final') {
      for (const b of bots) {
        const hands = {};
        for (const o of bots) if (o !== b) hands[o.s.me.id] = Math.random() < 0.5 ? o.s.me.hand.slice() : o.s.me.hand.slice(0, 2);
        await b.act({ t: 'final', mystery: L.filter(l => !b.s.me.hand.includes(l)).slice(0, 3), hands });
        assert.strictEqual(b.errors.length, 0, b.errors.join());
      }
    } else throw new Error('phase inattendue ' + s.phase);
  }

  // Score
  const R = bots[0].s.results;
  const mystery = R.mystery;
  const allCards = [...Object.values(R.hands).flat(), ...R.center, ...mystery];
  assert.strictEqual(new Set(allCards).size, 26);
  for (const row of R.rows) {
    let exp = 0;
    for (const r of [4, 5, 6]) exp += row.perRound[r].letters.filter((l) => mystery.includes(l)).length * (r === 6 ? 10 : 5);
    for (const [pid, h] of Object.entries(row.hands)) {
      const c = h.letters.filter((l) => R.hands[pid].includes(l)).length;
      exp += c + (c === R.hands[pid].length ? 1 : 0);
    }
    assert.strictEqual(row.total, exp, 'score');
  }
  const totals = R.rows.map((r) => r.total);
  assert.deepStrictEqual(totals, totals.slice().sort((a, b) => b - a));
  const logKinds = bots[0].s.log.map((e) => e.k);
  assert.strictEqual(logKinds.filter((k) => k === 'center').length, { 3: 2, 4: 3, 5: 3 }[count]);
  assert.strictEqual(logKinds.filter((k) => k === 'ask').length, 6 * count);
  // Reset
  await bots[0].act({ t: 'reset' });
  assert.strictEqual(bots[0].s.phase, 'lobby');
  for (const b of bots) { await b.act({ t: 'leave' }); }
  assert.strictEqual(bots[0].s.players.length, 0);
  bots.forEach((b) => b.ws.close());
  console.log(`✓ partie à ${count} joueurs (${reveals} révélations) — scores ${totals.join(', ')}`);
}

server.listen(0, async () => {
  const port = server.address().port;
  try {
    for (const n of [3, 4, 5, 4, 3, 5]) await playGame(port, n);
    console.log('Tout est OK');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
});
