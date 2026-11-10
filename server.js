'use strict';
/*
 * Lettres Cachées — serveur de jeu (une seule partie à la fois).
 * Le serveur distribue les cartes, garde les mains secrètes et calcule
 * toutes les réponses : personne ne peut se tromper en comptant.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SETUP = { 3: { hand: 7, center: 2 }, 4: { hand: 5, center: 3 }, 5: { hand: 4, center: 3 } };
const MYSTERY_SIZE = 3;
const LAST_ROUND = 6;
const GUESS_ROUNDS = [4, 5, 6];
const POINTS = { 4: 5, 5: 5, 6: 10 };
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;
const NOTE_VALUES = new Set(['x', 'o', '?']);

// ---------------------------------------------------------------- helpers

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Met en majuscules, retire les accents (É→E, Œ→OE), espaces, tirets et apostrophes. */
function normalizeWord(raw) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const w = raw
    .toUpperCase()
    .replace(/Œ/g, 'OE')
    .replace(/Æ/g, 'AE')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s'’\-.]/g, '');
  return /^[A-Z]{5}$/.test(w) ? w : null;
}

/** Chaque occurrence compte : NEVER avec E et N en main → 3. */
const countIn = (word, hand) => [...word].filter((c) => hand.includes(c)).length;
const letterKey = (w) => [...w].sort().join('');
const isLetter = (l) => typeof l === 'string' && /^[A-Z]$/.test(l);
const distinct = (arr) => new Set(arr).size === arr.length;
const randomHex = (n) => crypto.randomBytes(n).toString('hex');

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ---------------------------------------------------------------- state

const game = {
  phase: 'lobby', // lobby | clues | play | guess | final | over
  gameId: randomHex(6),
  players: [], // ordre des sièges (sens horaire)
};

function newPlayer(name) {
  const used = new Set(game.players.map((p) => p.code));
  let code;
  do code = String(crypto.randomInt(1000, 10000)); while (used.has(code));
  const p = { id: randomHex(4), token: randomHex(16), code, name, sockets: 0 };
  resetPlayerGame(p);
  return p;
}

function resetPlayerGame(p) {
  p.hand = [];
  p.revealed = [];
  p.peeks = [];
  p.notes = {};
  p.guesses = {};
  p.finalHands = null;
}

const byId = (id) => game.players.find((p) => p.id === id);
const n = () => game.players.length;
const activePlayer = () => game.players[(game.startPos + game.pos) % n()];
const hiddenCount = (p) => p.hand.length - p.revealed.length;
const inGame = () => !['lobby', 'over'].includes(game.phase);

function log(entry) {
  game.log.push({ ...entry, at: Date.now() });
}

function startGame() {
  const count = n();
  if (count < MIN_PLAYERS || count > MAX_PLAYERS) fail(`Il faut entre ${MIN_PLAYERS} et ${MAX_PLAYERS} joueurs.`);
  const cfg = SETUP[count];
  const deck = shuffle(LETTERS);
  let k = 0;
  for (const p of game.players) {
    resetPlayerGame(p);
    p.hand = deck.slice(k, k + cfg.hand).sort();
    k += cfg.hand;
  }
  game.center = deck.slice(k, k + cfg.center);
  k += cfg.center;
  game.mystery = deck.slice(k, k + MYSTERY_SIZE).sort();
  k += MYSTERY_SIZE;
  if (k !== LETTERS.length) throw new Error('Distribution incorrecte');

  Object.assign(game, {
    phase: 'clues',
    gameId: randomHex(6),
    cfg: { players: count, hand: cfg.hand, center: cfg.center, mystery: MYSTERY_SIZE, rounds: LAST_ROUND },
    startPos: crypto.randomInt(count),
    pos: 0,
    round: 0,
    centerShown: 0,
    turn: { asked: false, revealed: false },
    asked: {}, // pid -> [clé de lettres déjà demandées]
    log: [],
    results: null,
    startedAt: Date.now(),
  });
  log({ k: 'start', pid: activePlayer().id });
}

function backToLobby() {
  for (const p of game.players) resetPlayerGame(p);
  Object.assign(game, { phase: 'lobby', gameId: randomHex(6), log: [], results: null, cfg: null });
}

function canReveal(p) {
  return (
    game.phase === 'play' &&
    game.round >= 2 &&
    !game.turn.revealed &&
    activePlayer() === p &&
    hiddenCount(p) > 0 &&
    game.players.some((o) => o !== p && hiddenCount(o) > 0)
  );
}

function rememberAsked(pid, word) {
  (game.asked[pid] ||= []).push(letterKey(word));
}

function endTurn() {
  game.pos += 1;
  game.turn = { asked: false, revealed: false };
  if (game.pos >= n()) endRound();
}

function endRound() {
  const r = game.round;
  if (r <= game.cfg.center) {
    const letter = game.center[game.centerShown];
    game.centerShown += 1;
    log({ k: 'center', round: r, letter });
  }
  if (r === LAST_ROUND) {
    game.phase = 'final';
    log({ k: 'final' });
  } else if (GUESS_ROUNDS.includes(r)) {
    game.phase = 'guess';
    log({ k: 'guessing', round: r });
  } else {
    nextRound();
  }
}

function nextRound() {
  game.round += 1;
  game.pos = 0;
  game.turn = { asked: false, revealed: false };
  game.phase = 'play';
  log({ k: 'round', round: game.round });
}

function finishGame() {
  const mystery = new Set(game.mystery);
  const rows = game.players.map((p) => {
    const perRound = {};
    let mysteryPts = 0;
    for (const r of GUESS_ROUNDS) {
      const letters = p.guesses[r] || [];
      const correct = letters.filter((l) => mystery.has(l));
      perRound[r] = { letters, correct, pts: correct.length * POINTS[r] };
      mysteryPts += perRound[r].pts;
    }
    const hands = {};
    let handPts = 0;
    let bonus = 0;
    for (const o of game.players) {
      if (o === p) continue;
      const guessed = (p.finalHands && p.finalHands[o.id]) || [];
      const correct = guessed.filter((l) => o.hand.includes(l));
      const full = correct.length === o.hand.length;
      hands[o.id] = { letters: guessed, correct, full };
      handPts += correct.length;
      if (full) bonus += 1;
    }
    const firstRound = GUESS_ROUNDS.find((r) => perRound[r].correct.length > 0) || 99;
    return {
      pid: p.id,
      perRound,
      hands,
      mysteryPts,
      handPts,
      bonus,
      total: mysteryPts + handPts + bonus,
      firstRound,
      reveals: p.revealed.length,
    };
  });

  // Départage : 1) Mystère trouvé le plus tôt, 2) le plus de Mystère trouvés le plus tôt,
  // 3) le moins de cartes révélées.
  const cmp = (a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.firstRound !== b.firstRound) return a.firstRound - b.firstRound;
    for (const r of GUESS_ROUNDS) {
      const d = b.perRound[r].correct.length - a.perRound[r].correct.length;
      if (d) return d;
    }
    return a.reveals - b.reveals;
  };
  rows.sort(cmp);
  rows.forEach((row, i) => {
    row.rank = i > 0 && cmp(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
  });

  game.results = {
    rows,
    mystery: game.mystery,
    center: game.center,
    hands: Object.fromEntries(game.players.map((p) => [p.id, p.hand])),
  };
  game.phase = 'over';
  log({ k: 'over' });
}

// ---------------------------------------------------------------- actions

function handle(ws, msg) {
  const me = byId(ws.pid);
  const needMe = () => me || fail('Rejoins la partie d’abord.');
  const needActive = () => {
    needMe();
    if (activePlayer() !== me) fail('Ce n’est pas ton tour.');
  };

  switch (msg.t) {
    case 'ping':
      return false;

    case 'hello': {
      const p = game.players.find((x) => x.token === msg.token);
      if (p) attach(ws, p);
      else send(ws, { t: 'token', token: null });
      return 'self';
    }

    case 'join': {
      if (game.phase !== 'lobby') fail('Une partie est en cours. Utilise ton code pour reprendre ta place.');
      const name = String(msg.name || '').trim().replace(/\s+/g, ' ').slice(0, 16);
      if (!name) fail('Choisis un prénom.');
      if (game.players.length >= MAX_PLAYERS) fail('La table est complète (5 joueurs max).');
      if (game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('Ce prénom est déjà pris.');
      const p = newPlayer(name);
      game.players.push(p);
      attach(ws, p);
      send(ws, { t: 'token', token: p.token });
      return true;
    }

    case 'reclaim': {
      const p = game.players.find((x) => x.code === String(msg.code || '').trim());
      if (!p) fail('Code inconnu.');
      attach(ws, p);
      send(ws, { t: 'token', token: p.token });
      return true;
    }

    case 'leave': {
      needMe();
      if (game.phase !== 'lobby') fail('Impossible de quitter pendant une partie.');
      game.players = game.players.filter((p) => p !== me);
      detachAll(me);
      return true;
    }

    case 'kick': {
      needMe();
      if (game.phase !== 'lobby') fail('Impossible pendant une partie.');
      const p = byId(msg.pid);
      if (!p) return false;
      game.players = game.players.filter((x) => x !== p);
      detachAll(p);
      return true;
    }

    case 'move': {
      needMe();
      if (game.phase !== 'lobby') fail('Impossible pendant une partie.');
      const i = game.players.findIndex((p) => p.id === msg.pid);
      if (i <= 0) return false;
      [game.players[i - 1], game.players[i]] = [game.players[i], game.players[i - 1]];
      return true;
    }

    case 'shuffleSeats': {
      needMe();
      if (game.phase !== 'lobby') fail('Impossible pendant une partie.');
      game.players = shuffle(game.players);
      return true;
    }

    case 'start': {
      needMe();
      if (game.phase !== 'lobby') fail('La partie a déjà commencé.');
      startGame();
      return true;
    }

    case 'reset': {
      needMe();
      backToLobby();
      return true;
    }

    case 'clue': {
      if (game.phase !== 'clues') fail('Ce n’est pas le moment.');
      needActive();
      const word = normalizeWord(msg.word) || fail('Il faut un mot de exactement 5 lettres.');
      const count = countIn(word, me.hand);
      if (count === 0) fail('Ton mot doit contenir au moins une de tes lettres.');
      rememberAsked(me.id, word);
      log({ k: 'clue', pid: me.id, word, count });
      game.pos += 1;
      if (game.pos >= n()) nextRound();
      return true;
    }

    case 'ask': {
      if (game.phase !== 'play') fail('Ce n’est pas le moment.');
      needActive();
      if (game.turn.asked) fail('Tu as déjà posé ta question ce tour-ci.');
      const target = byId(msg.target);
      if (!target || target === me) fail('Choisis un autre joueur.');
      const word = normalizeWord(msg.word) || fail('Il faut un mot de exactement 5 lettres.');
      if ((game.asked[target.id] || []).includes(letterKey(word)))
        fail(`${target.name} a déjà répondu pour ces 5 lettres. Choisis un autre mot.`);
      const count = countIn(word, target.hand);
      rememberAsked(target.id, word);
      log({ k: 'ask', round: game.round, from: me.id, to: target.id, word, count });
      game.turn.asked = true;
      if (!canReveal(me)) endTurn();
      return true;
    }

    case 'reveal': {
      if (game.phase !== 'play') fail('Ce n’est pas le moment.');
      needActive();
      if (game.round < 2) fail('Les révélations commencent à la manche 2.');
      if (game.turn.revealed) fail('Une seule révélation par tour.');
      if (!isLetter(msg.letter) || !me.hand.includes(msg.letter) || me.revealed.includes(msg.letter))
        fail('Choisis une de tes cartes encore cachées.');
      const target = byId(msg.target);
      if (!target || target === me) fail('Choisis un autre joueur.');
      const hidden = target.hand.filter((l) => !target.revealed.includes(l));
      if (!hidden.length) fail(`${target.name} n’a plus de carte cachée.`);
      const seen = hidden[crypto.randomInt(hidden.length)];
      me.revealed.push(msg.letter);
      me.peeks.push({ round: game.round, target: target.id, letter: seen });
      log({ k: 'reveal', round: game.round, pid: me.id, letter: msg.letter, target: target.id });
      game.turn.revealed = true;
      if (game.turn.asked) endTurn();
      return true;
    }

    case 'endTurn': {
      if (game.phase !== 'play') fail('Ce n’est pas le moment.');
      needActive();
      if (!game.turn.asked) fail('Tu dois poser une question avant de finir ton tour.');
      endTurn();
      return true;
    }

    case 'guess': {
      if (game.phase !== 'guess') fail('Ce n’est pas le moment.');
      needMe();
      const letters = Array.isArray(msg.letters) ? msg.letters : [];
      if (letters.length !== MYSTERY_SIZE || !letters.every(isLetter) || !distinct(letters))
        fail('Choisis 3 lettres différentes.');
      me.guesses[game.round] = letters.slice().sort();
      if (game.players.every((p) => p.guesses[game.round])) {
        log({ k: 'guessed', round: game.round });
        nextRound();
      }
      return true;
    }

    case 'final': {
      if (game.phase !== 'final') fail('Ce n’est pas le moment.');
      needMe();
      const mystery = Array.isArray(msg.mystery) ? msg.mystery : [];
      if (mystery.length !== MYSTERY_SIZE || !mystery.every(isLetter) || !distinct(mystery))
        fail('Choisis 3 lettres différentes pour le Mystère.');
      const hands = {};
      for (const o of game.players) {
        if (o === me) continue;
        const raw = (msg.hands && msg.hands[o.id]) || [];
        if (!Array.isArray(raw) || raw.length > o.hand.length || !raw.every(isLetter) || !distinct(raw))
          fail(`Main de ${o.name} : au plus ${o.hand.length} lettres différentes.`);
        hands[o.id] = raw.slice().sort();
      }
      me.guesses[LAST_ROUND] = mystery.slice().sort();
      me.finalHands = hands;
      if (game.players.every((p) => p.finalHands)) finishGame();
      return true;
    }

    case 'note': {
      needMe();
      if (!inGame()) return false;
      const col = String(msg.col || '');
      if (!(col === 'center' || col === 'mystery' || byId(col)) || !isLetter(msg.letter)) return false;
      const key = `${col}:${msg.letter}`;
      if (NOTE_VALUES.has(msg.v)) me.notes[key] = msg.v;
      else delete me.notes[key];
      return 'self';
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------- views

function viewFor(p) {
  const pub = (x) => ({
    id: x.id,
    name: x.name,
    online: x.sockets > 0,
    handSize: x.hand.length,
    revealed: x.revealed,
    ready:
      (game.phase === 'guess' && !!x.guesses[game.round]) || (game.phase === 'final' && !!x.finalHands),
  });
  const v = {
    phase: game.phase,
    gameId: game.gameId,
    players: game.players.map(pub),
    me: null,
  };
  if (game.phase !== 'lobby') {
    Object.assign(v, {
      cfg: game.cfg,
      round: game.round,
      activeId: inGame() ? activePlayer().id : null,
      startId: game.players[game.startPos].id,
      turn: game.turn,
      centerShown: game.center.slice(0, game.centerShown),
      log: game.log,
      asked: game.asked,
      results: game.results,
    });
  }
  if (p) {
    v.me = {
      id: p.id,
      name: p.name,
      code: p.code,
      hand: p.hand,
      revealed: p.revealed,
      peeks: p.peeks,
      notes: p.notes,
      guesses: p.guesses,
      finalHands: p.finalHands,
      canReveal: canReveal(p),
    };
  }
  return v;
}

// ---------------------------------------------------------------- network

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz' || url.pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('ok');
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Introuvable');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendState(ws) {
  send(ws, { t: 'state', s: viewFor(byId(ws.pid)) });
}

function broadcast() {
  for (const ws of wss.clients) sendState(ws);
}

function attach(ws, p) {
  detach(ws);
  ws.pid = p.id;
  p.sockets += 1;
}

function detach(ws) {
  const p = byId(ws.pid);
  if (p) p.sockets = Math.max(0, p.sockets - 1);
  ws.pid = null;
}

function detachAll(p) {
  for (const ws of wss.clients) {
    if (ws.pid === p.id) {
      ws.pid = null;
      send(ws, { t: 'token', token: null });
    }
  }
  p.sockets = 0;
}

wss.on('connection', (ws) => {
  ws.pid = null;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      const changed = handle(ws, msg);
      if (changed === true) broadcast();
      else if (changed === 'self') {
        for (const c of wss.clients) if (c.pid && c.pid === ws.pid) sendState(c);
        if (!ws.pid) sendState(ws);
        if (msg.t === 'hello') broadcast(); // statut en ligne
      }
    } catch (e) {
      if (e instanceof GameError) send(ws, { t: 'error', msg: e.message });
      else {
        console.error(e);
        send(ws, { t: 'error', msg: 'Erreur du serveur.' });
      }
    }
  });
  ws.on('close', () => {
    const had = ws.pid;
    detach(ws);
    if (had) broadcast();
  });
  sendState(ws);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Lettres Cachées sur http://localhost:${PORT}`));
}

module.exports = { server, normalizeWord, countIn };
