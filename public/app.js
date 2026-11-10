'use strict';
(() => {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const HUES = ['#e4572e', '#1f9e8f', '#7b5cd6', '#d48c0e', '#2f7cf6'];
  const NEXT_NOTE = { '': 'x', x: 'o', o: '?', '?': '' };
  const NOTE_SYMBOL = { '': '', x: '✕', o: '✓', '?': '?' };
  const EYE =
    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z" fill="currentColor"/></svg>';

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let S = null; // vue envoyée par le serveur
  let ws = null;
  let online = false;
  let retry = 0;
  let token = store.get('lc_token');
  let helloPending = false;
  let tab = store.get('lc_tab') || 'indices';
  let helper = store.get('lc_helper') !== 'off'; // aide au calcul sous chaque réponse
  let ui = freshUi();

  function freshUi(keep = {}) {
    return {
      gameId: null,
      name: '',
      code: '',
      clueWord: '',
      askWord: '',
      target: null,
      revealOpen: false,
      revealLetter: null,
      revealTarget: null,
      guess: null,
      guessRound: null,
      editGuess: false,
      finalMystery: null,
      finalHands: null,
      editFinal: false,
      ...keep,
    };
  }

  // ------------------------------------------------------------ utils

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const P = (id) => S.players.find((p) => p.id === id);
  const isMe = (id) => !!(S && S.me && S.me.id === id);
  const others = () => S.players.filter((p) => !isMe(p.id));
  const nameOf = (id) => (id === 'center' ? 'Centre' : id === 'mystery' ? 'Mystère' : P(id)?.name ?? '?');
  const hue = (id) => HUES[Math.max(0, S.players.findIndex((p) => p.id === id)) % HUES.length];
  const who = (id) => `<b class="who" style="--c:${hue(id)}">${esc(nameOf(id))}</b>`;
  const clean = (raw) =>
    String(raw || '')
      .toUpperCase()
      .replace(/Œ/g, 'OE')
      .replace(/Æ/g, 'AE')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[\s'’\-.]/g, '');
  const countIn = (w, hand) => [...w].filter((c) => hand.includes(c)).length;
  const keyOf = (w) => [...w].sort().join('');
  const plural = (n, s, p = s + 's') => (n > 1 ? p : s);
  const tile = (l, cls = '') => `<span class="tile ${cls}">${esc(l)}</span>`;
  const back = (cls = '') => `<span class="tile back ${cls}" aria-label="carte cachée"></span>`;
  const tiles = (arr, cls = '') => arr.map((l) => tile(l, cls)).join('');

  function toast(msg, kind = '') {
    $toast.textContent = msg;
    $toast.className = `show ${kind}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => ($toast.className = ''), 3200);
  }

  // ------------------------------------------------------------ réseau

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      online = true;
      retry = 0;
      helloPending = !!token;
      if (token) sendMsg({ t: 'hello', token });
      render();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'state') onState(m.s);
      else if (m.t === 'token') {
        token = m.token;
        if (token) store.set('lc_token', token);
        else {
          store.del('lc_token');
          helloPending = false;
          render();
        }
      } else if (m.t === 'error') toast(m.msg, 'err');
    };
    ws.onclose = () => {
      online = false;
      render();
      setTimeout(connect, Math.min(8000, 400 * 2 ** retry++));
    };
  }

  function sendMsg(m) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else toast('Connexion perdue, reconnexion…', 'err');
  }

  // garde la connexion ouverte et le serveur éveillé (hébergement gratuit)
  setInterval(() => ws && ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 25000);
  setInterval(() => fetch('/ping', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  function myTurnIn(s) {
    if (!s || !s.me) return false;
    if (s.phase === 'clues' || s.phase === 'play') return s.activeId === s.me.id;
    if (s.phase === 'guess' || s.phase === 'final') return !s.players.find((p) => p.id === s.me.id)?.ready;
    return false;
  }

  function onState(s) {
    const prev = S;
    S = s;
    if (s.me) helloPending = false;
    if (s.gameId !== ui.gameId) ui = freshUi({ gameId: s.gameId, name: ui.name, code: ui.code });

    // nettoie les brouillons quand ils ne servent plus
    const mine = s.me && s.activeId === s.me.id;
    if (!(mine && s.phase === 'clues')) ui.clueWord = '';
    if (!(mine && s.phase === 'play' && !s.turn.asked)) {
      ui.askWord = '';
      ui.target = null;
    }
    if (!(s.me && s.me.canReveal)) {
      ui.revealOpen = false;
      ui.revealLetter = null;
      ui.revealTarget = null;
    }
    ensureDrafts();

    const now = myTurnIn(s);
    if (now && !myTurnIn(prev)) {
      try { navigator.vibrate && navigator.vibrate(120); } catch { /* ignore */ }
    }
    document.title = (now ? '● À toi · ' : '') + 'Lettres Cachées';
    render();
  }

  // ------------------------------------------------------------ déduction

  /** Faits certains pour ce joueur : où se trouve chaque lettre connue. */
  function facts() {
    const at = {};
    const full = new Set();
    if (!S || !S.me || !S.cfg) return { at, full };
    for (const l of S.me.hand) at[l] = S.me.id;
    for (const p of S.players) for (const l of p.revealed) at[l] = p.id;
    for (const l of S.centerShown || []) at[l] = 'center';
    for (const pk of S.me.peeks) at[pk.letter] = pk.target;
    const cap = { center: S.cfg.center, mystery: S.cfg.mystery };
    for (const p of S.players) cap[p.id] = p.handSize;
    const cnt = {};
    for (const l in at) cnt[at[l]] = (cnt[at[l]] || 0) + 1;
    for (const c in cap) if ((cnt[c] || 0) >= cap[c]) full.add(c);
    full.add(S.me.id);
    return { at, full, cap };
  }

  function cell(F, col, l) {
    const a = F.at[l];
    if (a) return { v: a === col ? 'o' : 'x', auto: true };
    if (F.full.has(col)) return { v: 'x', auto: true };
    return { v: (S.me.notes && S.me.notes[`${col}:${l}`]) || '', auto: false };
  }

  function marked(F, col) {
    return LETTERS.filter((l) => cell(F, col, l).v === 'o');
  }

  function ensureDrafts() {
    if (!S || !S.me || !S.cfg) return;
    const F = facts();
    if (S.phase === 'guess' && ui.guessRound !== S.round) {
      ui.guessRound = S.round;
      ui.editGuess = false;
      const fromNotes = marked(F, 'mystery').slice(0, 3);
      ui.guess = (S.me.guesses[S.round] || (fromNotes.length ? fromNotes : S.me.guesses[S.round - 1]) || []).slice();
    }
    if (S.phase === 'final' && !ui.finalHands) {
      const fromNotes = marked(F, 'mystery').slice(0, 3);
      ui.finalMystery = (S.me.guesses[6] || (fromNotes.length ? fromNotes : S.me.guesses[5]) || []).slice();
      ui.finalHands = {};
      for (const o of others()) {
        const saved = S.me.finalHands && S.me.finalHands[o.id];
        ui.finalHands[o.id] = saved ? saved.slice() : marked(F, o.id).slice(0, o.handSize);
      }
    }
  }

  // ------------------------------------------------------------ rendu

  function render() {
    const a = document.activeElement;
    const focusId = a && a.id;
    let sel = null;
    if (focusId && typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd];
    $app.innerHTML = view();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ }
      }
    }
  }

  function view() {
    if (!S || (helloPending && !S.me)) return `<div class="boot">${online ? 'Chargement…' : 'Connexion au serveur…'}</div>`;
    if (S.phase === 'lobby') return header() + lobbyView();
    if (!S.me) return header() + spectatorView();
    return header() + roundBar() + gameView();
  }

  function header() {
    return `<header class="top">
      <div class="brand"><img src="icon.svg" alt="" width="26" height="26"> Lettres Cachées</div>
      <div class="conn ${online ? 'on' : 'off'}">${online ? '' : 'Reconnexion…'}</div>
    </header>`;
  }

  // ---------- salon

  function lobbyView() {
    const joined = !!S.me;
    const n = S.players.length;
    const seats = S.players
      .map(
        (p, i) => `<li>
          <span class="dot" style="--c:${HUES[i]}"></span>
          <span class="seat-name">${esc(p.name)}${isMe(p.id) ? ' <span class="you">toi</span>' : ''}</span>
          <span class="status ${p.online ? 'on' : 'off'}">${p.online ? 'en ligne' : 'absent'}</span>
          ${joined ? `<span class="seat-actions">
            ${i > 0 ? `<button class="icon" data-action="move" data-pid="${p.id}" title="Avancer d’une place" aria-label="Avancer ${esc(p.name)}">↑</button>` : ''}
            ${!isMe(p.id) ? `<button class="icon" data-action="kick" data-pid="${p.id}" title="Retirer de la table" aria-label="Retirer ${esc(p.name)}">✕</button>` : ''}
          </span>` : ''}
        </li>`
      )
      .join('');
    return `<main class="lobby">
      <section class="card hero">
        <h1>Lettres Cachées</h1>
        <p>Un jeu de déduction avec des mots de 5 lettres, pour 3 à 5 joueurs. Les 26 lettres sont distribuées et 3 d’entre elles se cachent dans le <b>Mystère</b>. Posez des questions, croisez les réponses, trouvez-les avant les autres. Le jeu compte les lettres à votre place.</p>
      </section>
      ${joined ? '' : `<form class="card" data-form="join">
        <h2>Rejoindre la table</h2>
        <div class="row">
          <input id="joinName" data-bind="name" value="${esc(ui.name)}" placeholder="Ton prénom" maxlength="16" autocomplete="nickname" required>
          <button class="btn primary">Rejoindre</button>
        </div>
      </form>`}
      <section class="card">
        <h2>À la table <span class="muted">${n}/5</span></h2>
        <ol class="seats">${seats || '<li class="muted">Personne pour l’instant.</li>'}</ol>
        ${joined ? `
          <p class="muted small">L’ordre de la liste est le sens du jeu. Le premier joueur est tiré au sort.</p>
          <div class="row wrap">
            <button class="btn primary" data-action="start" ${n < 3 || n > 5 ? 'disabled' : ''}>Lancer la partie</button>
            <button class="btn" data-action="shuffleSeats" ${n < 2 ? 'disabled' : ''}>Mélanger les places</button>
            <button class="btn ghost" data-action="leave">Quitter</button>
          </div>
          ${n < 3 ? `<p class="hint">Il faut encore ${3 - n} ${plural(3 - n, 'joueur')} pour commencer.</p>` : ''}
          ${codeBox()}` : ''}
      </section>
      <section class="card rules">${rulesHtml()}</section>
    </main>`;
  }

  function codeBox() {
    return `<p class="code">Ton code de reconnexion : <b>${S.me.code}</b><br>
      <span class="muted small">Il te permet de reprendre ta place depuis un autre appareil ou navigateur.</span></p>`;
  }

  function spectatorView() {
    return `<main class="lobby">
      <form class="card" data-form="reclaim">
        <h2>Une partie est en cours</h2>
        <p>Si tu joues dans cette partie, entre ton code de reconnexion pour reprendre ta place.</p>
        <div class="row">
          <input id="reclaimCode" data-bind="code" value="${esc(ui.code)}" inputmode="numeric" placeholder="Code à 4 chiffres" maxlength="4" autocomplete="off">
          <button class="btn primary">Reprendre ma place</button>
        </div>
      </form>
      ${boardCard()}
      <section class="card"><h2>Journal</h2>${journalTab()}</section>
    </main>`;
  }

  // ---------- partie

  function roundBar() {
    const ph = S.phase;
    const r = S.round;
    const done = (i) => ph !== 'clues' && (i < r || (i === r && ['guess', 'final', 'over'].includes(ph)));
    let label;
    if (ph === 'clues') label = 'Mots d’ouverture';
    else if (ph === 'play') label = `Manche ${r}/6 · au tour de ${esc(nameOf(S.activeId))}`;
    else if (ph === 'guess') label = `Fin de la manche ${r} · pronostics secrets`;
    else if (ph === 'final') label = 'Fin de partie · réponses finales';
    else label = 'Partie terminée';
    const steps = [1, 2, 3, 4, 5, 6]
      .map((i) => {
        const st = done(i) ? 'done' : ph === 'play' && i === r ? 'now' : '';
        const what = i <= S.cfg.center ? 'centre' : i >= 4 ? 'prono' : '';
        return `<li class="${st}"><span class="n">${i}</span><span class="what">${what}</span></li>`;
      })
      .join('');
    return `<nav class="rounds" aria-label="Avancement">
      <div class="rounds-label">${label}</div>
      <ol><li class="${ph === 'clues' ? 'now' : 'done'} open"><span class="n">0</span><span class="what">ouvert.</span></li>${steps}</ol>
    </nav>`;
  }

  function gameView() {
    const F = facts();
    return `<main class="game">
      <div class="col">
        ${S.phase === 'over' ? resultsCard() : actionCard(F)}
        ${handCard()}
        ${boardCard()}
      </div>
      <div class="col">${tabsCard(F)}</div>
    </main>`;
  }

  function lastEvent() {
    const e = [...S.log].reverse().find((x) => ['clue', 'ask', 'reveal', 'center'].includes(x.k));
    if (!e) return '';
    let meta;
    let body;
    if (e.k === 'ask') {
      meta = `${who(e.from)} demande à ${who(e.to)}`;
      body = `<div class="tiles">${tiles([...e.word], 'md')}</div><span class="eq">→</span><span class="num">${e.count}</span>`;
    } else if (e.k === 'clue') {
      meta = `Ouverture de ${who(e.pid)}`;
      body = `<div class="tiles">${tiles([...e.word], 'md')}</div><span class="eq">→</span><span class="num">${e.count}</span>`;
    } else if (e.k === 'reveal') {
      meta = `${who(e.pid)} révèle une carte et regarde une carte de ${who(e.target)}`;
      body = `<div class="tiles">${tile(e.letter, 'md shown')}</div>`;
    } else {
      meta = 'Une carte du Centre est révélée';
      body = `<div class="tiles">${tile(e.letter, 'md shown')}</div>`;
    }
    return `<div class="last"><div class="last-meta">${meta}</div><div class="last-body">${body}</div></div>`;
  }

  function peekBanner() {
    const pk = S.me.peeks[S.me.peeks.length - 1];
    if (!pk || pk.round !== S.round || S.phase !== 'play') return '';
    return `<div class="peek">${EYE}<span>En secret, tu as vu chez ${who(pk.target)} la carte</span>${tile(pk.letter, 'md gold')}</div>`;
  }

  function actionCard(F) {
    let inner = '';
    if (S.phase === 'clues') inner = cluePanel();
    else if (S.phase === 'play') inner = playPanel();
    else if (S.phase === 'guess') inner = guessPanel(F);
    else if (S.phase === 'final') inner = finalPanel(F);
    return `<section class="card action ${myTurnIn(S) ? 'mine' : ''}">${lastEvent()}${inner}</section>`;
  }

  function wordForm(kind, label) {
    const id = kind === 'clue' ? 'clueWord' : 'askWord';
    const pv = preview(kind);
    return `<label class="lbl" for="${id}">${label}</label>
      <input id="${id}" class="word-input" data-bind="${id}" data-preview="${kind}" value="${esc(ui[id])}"
        placeholder="5 lettres" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" maxlength="12" enterkeyhint="send">
      <div id="prev-${kind}" class="preview">${pv.html}</div>
      <button class="btn primary big" id="btn-${kind}" ${pv.ok ? '' : 'disabled'}>${kind === 'clue' ? 'Annoncer' : 'Demander'}</button>`;
  }

  function preview(kind) {
    const w = clean(kind === 'clue' ? ui.clueWord : ui.askWord);
    const hand = S.me.hand;
    const slots = [0, 1, 2, 3, 4]
      .map((i) => (w[i] ? tile(w[i], `md ${kind === 'clue' && hand.includes(w[i]) ? 'mine' : ''}`) : '<span class="tile md slot"></span>'))
      .join('');
    let msg = '';
    let ok = false;
    if (/[^A-Z]/.test(w)) msg = '<span class="bad">Lettres uniquement (les accents sont acceptés).</span>';
    else if (w.length > 5) msg = `<span class="bad">Il faut exactement 5 lettres (là : ${w.length}).</span>`;
    else if (w.length < 5) msg = w.length ? `<span class="muted">Encore ${5 - w.length} ${plural(5 - w.length, 'lettre')}.</span>` : '';
    else if (kind === 'clue') {
      const c = countIn(w, hand);
      if (!c) msg = '<span class="bad">Ce mot ne contient aucune de tes lettres.</span>';
      else {
        ok = true;
        msg = `Tu annonceras <b>${c}</b>.${c > 1 ? ' <span class="warn">Plusieurs de tes lettres : c’est permis, mais déconseillé.</span>' : ''}`;
      }
    } else if (!ui.target) msg = '<span class="muted">Choisis à qui poser la question.</span>';
    else if ((S.asked[ui.target] || []).includes(keyOf(w)))
      msg = `<span class="bad">${esc(nameOf(ui.target))} a déjà répondu pour ces 5 lettres.</span>`;
    else ok = true;
    return { ok, html: `<div class="tiles">${slots}</div><div class="pv-msg">${msg}</div>` };
  }

  function updatePreview(kind) {
    const box = document.getElementById(`prev-${kind}`);
    const btn = document.getElementById(`btn-${kind}`);
    if (!box) return;
    const pv = preview(kind);
    box.innerHTML = pv.html;
    if (btn) btn.disabled = !pv.ok;
  }

  function cluePanel() {
    if (isMe(S.activeId)) {
      return `<h2>À toi : ton mot d’ouverture</h2>
        <p>Donne un mot de 5 lettres qui contient <b>au moins une</b> de tes lettres. Le jeu annoncera à tous combien il en contient.</p>
        <form data-form="clue">${wordForm('clue', 'Ton mot')}</form>`;
    }
    const done = new Set(S.log.filter((e) => e.k === 'clue').map((e) => e.pid));
    return `<h2>Mots d’ouverture</h2>
      <p class="lead">${who(S.activeId)} choisit son mot…</p>
      <p class="muted small">Déjà annoncés : ${done.size ? [...done].map(who).join(', ') : 'personne'}.</p>`;
  }

  function playPanel() {
    if (!isMe(S.activeId)) {
      return `<p class="lead">Au tour de ${who(S.activeId)}.</p>`;
    }
    let h = '<h2>À toi de jouer</h2>';
    if (!S.turn.asked) {
      const chips = others()
        .map((p) => `<button type="button" class="chip ${ui.target === p.id ? 'sel' : ''}" style="--c:${hue(p.id)}" data-action="target" data-pid="${p.id}">${esc(p.name)}</button>`)
        .join('');
      h += `<form data-form="ask">
        <span class="lbl">À qui poses-tu la question ?</span>
        <div class="chips">${chips}</div>
        ${wordForm('ask', 'Ton mot de 5 lettres')}
      </form>`;
    } else {
      h += '<p class="ok-line">✓ Question posée.</p>';
    }
    if (S.turn.revealed) h += '<p class="ok-line">✓ Carte révélée.</p>';
    h += peekBanner();
    if (S.me.canReveal) h += revealBlock();
    else if (S.round === 1) h += '<p class="muted small">Dès la manche 2, tu pourras aussi révéler une carte pour en regarder une chez un adversaire.</p>';
    if (S.turn.asked && S.me.canReveal) h += '<button class="btn wide" data-action="endTurn">Finir mon tour sans révéler</button>';
    return h;
  }

  function revealBlock() {
    if (!ui.revealOpen) {
      return `<button class="btn ghost wide" data-action="revealOpen">${EYE} Révéler une carte <span class="muted">(facultatif)</span></button>`;
    }
    const mine = S.me.hand.filter((l) => !S.me.revealed.includes(l));
    const tilesHtml = mine
      .map((l) => `<button type="button" class="tile md pickable ${ui.revealLetter === l ? 'sel' : ''}" data-action="revealLetter" data-l="${l}">${l}</button>`)
      .join('');
    const chips = others()
      .map((p) => {
        const hidden = p.handSize - p.revealed.length;
        return `<button type="button" class="chip ${ui.revealTarget === p.id ? 'sel' : ''}" style="--c:${hue(p.id)}" data-action="revealTarget" data-pid="${p.id}" ${hidden ? '' : 'disabled'}>${esc(p.name)}</button>`;
      })
      .join('');
    return `<div class="reveal-box">
      <h3>${EYE} Révéler une carte</h3>
      <p class="small muted">Ta carte reste visible par tous jusqu’à la fin. En échange, tu regardes en secret une carte au hasard chez l’adversaire choisi. (En cas d’égalité finale, révéler moins de cartes départage.)</p>
      <span class="lbl">Carte à montrer</span>
      <div class="tiles">${tilesHtml}</div>
      <span class="lbl">Regarder une carte de</span>
      <div class="chips">${chips}</div>
      <div class="row wrap">
        <button class="btn primary" data-action="doReveal" ${ui.revealLetter && ui.revealTarget ? '' : 'disabled'}>Révéler et regarder</button>
        <button class="btn ghost" data-action="revealClose">Annuler</button>
      </div>
    </div>`;
  }

  function picker(id, selected, max, F, col, locked = []) {
    const btns = LETTERS.map((l) => {
      const c = col ? cell(F, col, l) : { v: '' };
      const isSel = selected.includes(l);
      const isLocked = locked.includes(l);
      return `<button type="button" class="pk ${isSel ? 'sel' : ''} ${isLocked ? 'locked' : ''} hint-${c.v || 'n'}" data-action="pick" data-picker="${id}" data-l="${l}" ${isLocked ? 'aria-disabled="true"' : ''}>${l}</button>`;
    }).join('');
    return `<div class="picker" role="group">${btns}</div><div class="pk-count">${selected.length}/${max} : ${selected.length ? [...selected].sort().join(' ') : '—'}</div>`;
  }

  function waitingList() {
    const waiting = S.players.filter((p) => !p.ready);
    if (!waiting.length) return '';
    return `<p class="muted small waiting">En attente de : ${waiting.map((p) => who(p.id)).join(', ')}</p>`;
  }

  function guessPanel(F) {
    const r = S.round;
    const saved = S.me.guesses[r];
    if (saved && !ui.editGuess) {
      return `<h2>Pronostic de la manche ${r} enregistré</h2>
        <div class="tiles">${tiles(saved, 'md gold')}</div>
        <div class="row wrap"><button class="btn ghost" data-action="editGuess">Modifier</button></div>
        ${waitingList()}`;
    }
    const g = ui.guess || [];
    return `<h2>Pronostic secret · manche ${r}</h2>
      <p>Choisis les 3 lettres que tu crois dans le Mystère : <b>5 points</b> par lettre juste. Personne ne voit ton choix avant la fin.</p>
      ${picker('guess', g, 3, F, 'mystery')}
      <button class="btn primary big" data-action="sendGuess" ${g.length === 3 ? '' : 'disabled'}>Valider mon pronostic</button>
      ${waitingList()}`;
  }

  function finalPanel(F) {
    if (S.me.finalHands && !ui.editFinal) {
      const rows = others()
        .map((o) => `<div class="sum-row">${who(o.id)}<div class="tiles">${tiles(S.me.finalHands[o.id] || [], 'sm')}</div></div>`)
        .join('');
      return `<h2>Réponses finales enregistrées</h2>
        <div class="sum-row"><b>Mystère</b><div class="tiles">${tiles(S.me.guesses[6] || [], 'sm gold')}</div></div>
        ${rows}
        <div class="row wrap"><button class="btn ghost" data-action="editFinal">Modifier</button></div>
        ${waitingList()}`;
    }
    const hands = others()
      .map((o) => {
        const sel = ui.finalHands[o.id] || [];
        return `<h3>Main de ${who(o.id)} <span class="muted small">${o.handSize} lettres · 1 pt chacune, +1 si tout est juste</span></h3>
          ${picker(`fh:${o.id}`, sel, o.handSize, F, o.id, o.revealed)}`;
      })
      .join('');
    const fm = ui.finalMystery || [];
    return `<h2>Réponses finales</h2>
      <p>Le Mystère vaut maintenant <b>10 points</b> par lettre juste. Devine aussi la main de chaque adversaire. Les lettres sont pré-remplies avec ce que tu as coché ✓ dans ton carnet.</p>
      <h3>Mystère <span class="muted small">3 lettres · 10 pts chacune</span></h3>
      ${picker('fm', fm, 3, F, 'mystery')}
      ${hands}
      <button class="btn primary big" data-action="sendFinal" ${fm.length === 3 ? '' : 'disabled'}>Valider mes réponses</button>
      ${waitingList()}`;
  }

  function resultsCard() {
    const R = S.results;
    const mystery = new Set(R.mystery);
    const rank = R.rows
      .map((row) => {
        const pr = row.perRound;
        return `<li class="rank r${row.rank}">
          <span class="rk">${row.rank}</span>
          <span class="rk-name">${who(row.pid)}</span>
          <span class="pts">${row.total}<small> ${row.total > 1 ? "pts" : "pt"}</small></span>
          <span class="breakdown">Mystère ${pr[4].pts} + ${pr[5].pts} + ${pr[6].pts} · Mains ${row.handPts} · Bonus ${row.bonus}${row.reveals ? ` · ${row.reveals} ${plural(row.reveals, 'carte révélée', 'cartes révélées')}` : ''}</span>
        </li>`;
      })
      .join('');
    const handsHtml = S.players
      .map((p) => `<div class="sum-row">${who(p.id)}<div class="tiles">${R.hands[p.id].map((l) => tile(l, `sm ${p.revealed.includes(l) ? 'shown' : ''}`)).join('')}</div></div>`)
      .join('');
    const detail = R.rows
      .map((row) => {
        const guesses = [4, 5, 6]
          .map((r) => `<div class="sum-row"><span class="muted">Manche ${r}</span><div class="tiles">${(row.perRound[r].letters || []).map((l) => tile(l, `sm ${mystery.has(l) ? 'good' : 'wrong'}`)).join('') || '<span class="muted">—</span>'}</div><span class="muted small">${row.perRound[r].pts} ${row.perRound[r].pts > 1 ? "pts" : "pt"}</span></div>`)
          .join('');
        const hands = Object.entries(row.hands)
          .map(([pid, h]) => `<div class="sum-row"><span>Main de ${who(pid)}</span><div class="tiles">${h.letters.map((l) => tile(l, `sm ${R.hands[pid].includes(l) ? 'good' : 'wrong'}`)).join('') || '<span class="muted">—</span>'}</div><span class="muted small">${h.correct.length + (h.full ? 1 : 0)} ${h.correct.length + (h.full ? 1 : 0) > 1 ? "pts" : "pt"}</span></div>`)
          .join('');
        return `<details><summary>${who(row.pid)} · ${row.total} ${row.total > 1 ? "pts" : "pt"}</summary>${guesses}${hands}</details>`;
      })
      .join('');
    return `<section class="card action results">
      <h2>Résultats</h2>
      <div class="mystery-reveal"><span class="lbl">Le Mystère était</span><div class="tiles">${tiles(R.mystery, 'lg gold')}</div></div>
      <ol class="ranking">${rank}</ol>
      <p class="muted small">Égalité : on départage d’abord par le Mystère trouvé le plus tôt, puis par le plus de lettres du Mystère trouvées tôt, puis par le moins de cartes révélées.</p>
      <h3>Toutes les cartes</h3>
      ${handsHtml}
      <div class="sum-row"><b>Centre</b><div class="tiles">${tiles(R.center, 'sm')}</div></div>
      <h3>Détail des pronostics</h3>
      ${detail}
      <div class="row wrap"><button class="btn primary big" data-action="reset">Nouvelle partie</button></div>
    </section>`;
  }

  function handCard() {
    const rev = S.me.revealed;
    return `<section class="card hand">
      <div class="card-head"><h2>Ta main</h2><span class="muted small">code de reconnexion : <b>${S.me.code}</b></span></div>
      <div class="tiles">${S.me.hand.map((l) => `<span class="tile lg ${rev.includes(l) ? 'shown' : ''}">${l}${rev.includes(l) ? `<i class="badge" title="Visible par tous">${EYE}</i>` : ''}</span>`).join('')}</div>
      ${rev.length ? `<p class="muted small">${EYE} = carte révélée, visible par tous.</p>` : ''}
    </section>`;
  }

  function boardCard() {
    const cfg = S.cfg;
    const opps = S.players
      .map((p) => {
        const hidden = p.handSize - p.revealed.length;
        return `<li class="opp ${S.activeId === p.id ? 'active' : ''}">
          <div class="opp-head">
            <span class="dot" style="--c:${hue(p.id)}"></span>
            <b>${esc(p.name)}</b>${isMe(p.id) ? '<span class="you">toi</span>' : ''}
            ${S.startId === p.id ? '<span class="tag" title="Premier joueur">1er</span>' : ''}
            <span class="online ${p.online ? 'on' : 'off'}" title="${p.online ? 'en ligne' : 'déconnecté'}"></span>
            ${p.ready ? '<span class="ready">✓ validé</span>' : ''}
          </div>
          <div class="tiles">${tiles(p.revealed, 'sm shown')}${Array.from({ length: hidden }, () => back('sm')).join('')}</div>
        </li>`;
      })
      .join('');
    const shown = S.centerShown || [];
    return `<section class="card board">
      <h2>La table</h2>
      <ul class="opps">${opps}</ul>
      <div class="zones">
        <div class="zone">
          <div class="zone-title">Centre <span class="muted small">révélé après les manches 1 à ${cfg.center}</span></div>
          <div class="tiles">${tiles(shown, 'sm shown')}${Array.from({ length: cfg.center - shown.length }, () => back('sm')).join('')}</div>
        </div>
        <div class="zone">
          <div class="zone-title">Mystère <span class="muted small">3 lettres à deviner</span></div>
          <div class="tiles">${Array.from({ length: cfg.mystery }, () => '<span class="tile sm back q">?</span>').join('')}</div>
        </div>
      </div>
    </section>`;
  }

  // ---------- onglets

  function tabsCard(F) {
    const tabs = [
      ['indices', 'Indices'],
      ['carnet', 'Carnet'],
      ['journal', 'Journal'],
      ['regles', 'Règles'],
    ];
    let body;
    if (tab === 'carnet') body = carnetTab(F);
    else if (tab === 'journal') body = journalTab();
    else if (tab === 'regles') body = rulesHtml() + (S.phase !== 'over' ? '<div class="danger-zone"><button class="btn danger" data-action="reset">Abandonner la partie (pour tout le monde)</button></div>' : '');
    else body = indicesTab(F);
    return `<section class="card tabs-card">
      <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-action="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
      <div class="tab-body">${body}</div>
    </section>`;
  }

  function letterBtn(F, col, l) {
    const c = cell(F, col, l);
    return `<button class="lt v-${c.v === '?' ? 'q' : c.v || 'n'} ${c.auto ? 'auto' : ''}" data-action="note" data-col="${col}" data-l="${l}" ${c.auto ? 'disabled' : ''}>${l}</button>`;
  }

  function restInfo(F, col, e) {
    if (!helper) return '';
    const cs = [...e.word].map((l) => cell(F, col, l).v);
    const yes = cs.filter((v) => v === 'o').length;
    const unk = cs.filter((v) => v === '' || v === '?').length;
    const rest = e.count - yes;
    if (rest < 0 || rest > unk) return '<span class="cr-rest bad">incohérent</span>';
    if (unk === 5 && yes === 0) return '';
    if (!unk) return '<span class="cr-rest ok">résolu</span>';
    if (!rest) return '<span class="cr-rest ok">les autres lettres : ✕</span>';
    if (rest === unk) return '<span class="cr-rest ok">les autres lettres : ✓</span>';
    return `<span class="cr-rest">encore ${rest} parmi ${unk} ${plural(unk, 'inconnue')}</span>`;
  }

  function indicesTab(F) {
    const order = [...others(), ...S.players.filter((p) => isMe(p.id))];
    const groups = order
      .map((p) => {
        const entries = S.log.filter((e) => (e.k === 'clue' && e.pid === p.id) || (e.k === 'ask' && e.to === p.id));
        const rows = entries
          .map(
            (e) => `<div class="clue-row">
              <span class="cr-meta">${e.k === 'clue' ? 'ouverture' : `M${e.round} · ${esc(nameOf(e.from))}`}</span>
              <span class="cr-word">${[...e.word].map((l) => letterBtn(F, p.id, l)).join('')}</span>
              <span class="cr-n">${e.count}</span>
              ${isMe(p.id) ? '' : restInfo(F, p.id, e)}
            </div>`
          )
          .join('');
        const peeks = S.me.peeks
          .filter((pk) => pk.target === p.id)
          .map((pk) => `<div class="peek-row">${EYE} Tu as vu ${tile(pk.letter, 'xs gold')} <span class="muted small">manche ${pk.round}</span></div>`)
          .join('');
        const known = marked(F, p.id);
        return `<div class="clue-group">
          <div class="cg-head">${who(p.id)}${isMe(p.id) ? ' <span class="you">toi</span>' : ''}
            <span class="muted small">${known.length}/${p.handSize} ✓${known.length ? ` : ${known.join(' ')}` : ''}</span></div>
          ${rows || '<p class="muted small">Aucune réponse pour l’instant.</p>'}
          ${peeks}
        </div>`;
      })
      .join('');
    return `<p class="legend">Touche une lettre pour l’annoter : <span class="lt v-x">✕</span> pas chez ce joueur, <span class="lt v-o">✓</span> chez lui, <span class="lt v-q">?</span> doute. Ce qui est certain (ta main, cartes révélées ou vues) est rempli automatiquement.</p>
      <label class="switch"><input type="checkbox" data-action="helper" ${helper ? 'checked' : ''}> Aide au calcul sous chaque réponse (« encore 1 parmi 3 »)</label>
      ${groups}`;
  }

  function carnetTab(F) {
    const cols = [...others().map((p) => p.id), 'center', 'mystery'];
    const cap = (c) => (c === 'center' ? S.cfg.center : c === 'mystery' ? S.cfg.mystery : P(c).handSize);
    const head = cols
      .map((c) => {
        const k = marked(F, c).length;
        const color = c === 'center' || c === 'mystery' ? 'var(--muted)' : hue(c);
        return `<th><span class="gh" style="--c:${color}">${esc(nameOf(c))}</span><span class="gc ${k === cap(c) ? 'full' : ''}">${k}/${cap(c)}</span></th>`;
      })
      .join('');
    const rows = LETTERS.map((l) => {
      const mine = S.me.hand.includes(l);
      const tds = cols
        .map((c) => {
          const x = cell(F, c, l);
          return `<td><button class="gcell v-${x.v === '?' ? 'q' : x.v || 'n'} ${x.auto ? 'auto' : ''}" data-action="note" data-col="${c}" data-l="${l}" ${x.auto ? 'disabled' : ''} aria-label="${l} ${esc(nameOf(c))}">${NOTE_SYMBOL[x.v]}</button></td>`;
        })
        .join('');
      return `<tr class="${mine ? 'mine' : ''}"><th>${l}${mine ? '<small>toi</small>' : ''}</th>${tds}</tr>`;
    }).join('');
    return `<p class="legend">Touche une case : ✕ → ✓ → ? → vide. Les cases pâles sont des certitudes calculées pour toi.</p>
      <div class="grid-wrap"><table class="grid"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function logLine(e) {
    const w = (x) => `<b class="w">${esc(x)}</b>`;
    switch (e.k) {
      case 'start': return `<span class="sep">Ouverture</span>${who(e.pid)} commence. Chacun annonce son mot d’ouverture.`;
      case 'clue': return `${who(e.pid)} ouvre avec ${w(e.word)} → <b>${e.count}</b>`;
      case 'round': return `<span class="sep">Manche ${e.round}</span>`;
      case 'ask': return `${who(e.from)} → ${who(e.to)} : ${w(e.word)} → <b>${e.count}</b>`;
      case 'reveal': {
        const pk = isMe(e.pid) && S.me.peeks.find((p) => p.round === e.round && p.target === e.target);
        return `${who(e.pid)} révèle ${w(e.letter)} et regarde une carte de ${who(e.target)}${pk ? ` <span class="muted">(tu as vu ${w(pk.letter)})</span>` : ''}`;
      }
      case 'center': return `Carte du Centre révélée : ${w(e.letter)}`;
      case 'guessing': return `<span class="sep">Fin de la manche ${e.round} : pronostics secrets</span>`;
      case 'guessed': return `Pronostics de la manche ${e.round} enregistrés.`;
      case 'final': return '<span class="sep">Fin de la manche 6 : réponses finales</span>';
      case 'over': return '<span class="sep">Partie terminée</span>';
      default: return '';
    }
  }

  function journalTab() {
    // une section par manche, la plus récente en haut, chronologique à l’intérieur
    const groups = [];
    for (const e of S.log || []) {
      if (e.k === 'start' || e.k === 'round' || !groups.length) groups.push([]);
      groups[groups.length - 1].push(e);
    }
    const html = groups
      .reverse()
      .map((g) => `<li><ol class="journal-group">${g.map((e) => `<li>${logLine(e)}</li>`).join('')}</ol></li>`)
      .join('');
    return `<ol class="journal">${html || '<li class="muted">Rien pour l’instant.</li>'}</ol>`;
  }

  function rulesHtml() {
    return `<h2>Règles</h2>
      <h3>But</h3>
      <p>Trois lettres sont cachées dans le Mystère. Trouve-les le plus tôt possible, et devine aussi les lettres de tes adversaires.</p>
      <h3>Mise en place</h3>
      <p>Les 26 lettres sont mélangées. À 3 joueurs : 7 lettres chacun, 2 au Centre. À 4 : 5 chacun, 3 au Centre. À 5 : 4 chacun, 3 au Centre. Les 3 dernières forment le Mystère.</p>
      <h3>Ouverture</h3>
      <p>Chacun à son tour donne un mot de 5 lettres qui contient au moins une de ses lettres. Le jeu annonce combien il en contient.</p>
      <h3>Comptage</h3>
      <p>Chaque occurrence compte : avec E et N en main, NEVER vaut 3. Le jeu fait le calcul, il ne se trompe pas.</p>
      <h3>Les 6 manches</h3>
      <p>À ton tour, choisis un adversaire et propose-lui un vrai mot de 5 lettres. Les noms propres sont acceptés et la table valide le mot à l’oral. Le jeu annonce combien de ses lettres le mot contient. On ne peut pas passer. Interdit de redemander à quelqu’un un mot fait des mêmes 5 lettres.</p>
      <h3>Révéler une carte</h3>
      <p>À partir de la manche 2, une fois par tour, avant ou après ta question : montre une de tes cartes (elle reste visible jusqu’à la fin), puis regarde en secret une carte au hasard chez un adversaire.</p>
      <h3>Centre</h3>
      <p>Après les manches 1, 2 et 3 (1 et 2 seulement à 3 joueurs), une carte du Centre est révélée. Elle n’est donc pas dans le Mystère.</p>
      <h3>Pronostics</h3>
      <p>Après les manches 4, 5 et 6, chacun choisit en secret 3 lettres différentes pour le Mystère. Après la manche 6, chacun devine aussi la main de chaque adversaire.</p>
      <h3>Points</h3>
      <ul>
        <li>Mystère, manches 4 et 5 : 5 points par lettre juste</li>
        <li>Mystère, manche 6 : 10 points par lettre juste</li>
        <li>1 point par lettre juste dans les mains adverses</li>
        <li>+1 point par main adverse entièrement juste</li>
      </ul>
      <h3>Égalité</h3>
      <p>Gagne celui qui a trouvé une lettre du Mystère le plus tôt, puis celui qui en a trouvé le plus tôt, puis celui qui a révélé le moins de cartes.</p>`;
  }

  // ------------------------------------------------------------ événements

  function pickerRef(id) {
    if (id === 'guess') return { arr: ui.guess, max: 3, locked: [] };
    if (id === 'fm') return { arr: ui.finalMystery, max: 3, locked: [] };
    const pid = id.slice(3);
    const p = P(pid);
    return { arr: ui.finalHands[pid], max: p.handSize, locked: p.revealed };
  }

  $app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    const a = b.dataset.action;
    const pid = b.dataset.pid;
    const l = b.dataset.l;
    switch (a) {
      case 'helper':
        helper = b.checked;
        store.set('lc_helper', helper ? 'on' : 'off');
        render();
        break;
      case 'tab':
        tab = b.dataset.tab;
        store.set('lc_tab', tab);
        render();
        break;
      case 'move':
      case 'kick':
        sendMsg({ t: a, pid });
        break;
      case 'start':
      case 'shuffleSeats':
      case 'leave':
      case 'endTurn':
        sendMsg({ t: a });
        break;
      case 'reset':
        if (confirm(S.phase === 'over' ? 'Revenir au salon pour une nouvelle partie ?' : 'Abandonner la partie en cours pour tout le monde ?'))
          sendMsg({ t: 'reset' });
        break;
      case 'target':
        ui.target = pid;
        render();
        break;
      case 'revealOpen':
        ui.revealOpen = true;
        render();
        break;
      case 'revealClose':
        ui.revealOpen = false;
        ui.revealLetter = ui.revealTarget = null;
        render();
        break;
      case 'revealLetter':
        ui.revealLetter = l;
        render();
        break;
      case 'revealTarget':
        ui.revealTarget = pid;
        render();
        break;
      case 'doReveal':
        sendMsg({ t: 'reveal', letter: ui.revealLetter, target: ui.revealTarget });
        break;
      case 'note': {
        const col = b.dataset.col;
        const key = `${col}:${l}`;
        const v = NEXT_NOTE[S.me.notes[key] || ''];
        if (v) S.me.notes[key] = v;
        else delete S.me.notes[key];
        sendMsg({ t: 'note', col, letter: l, v });
        render();
        break;
      }
      case 'pick': {
        const ref = pickerRef(b.dataset.picker);
        if (ref.locked.includes(l)) {
          toast('Carte révélée : elle est forcément dans sa main.');
          break;
        }
        const i = ref.arr.indexOf(l);
        if (i >= 0) ref.arr.splice(i, 1);
        else if (ref.arr.length < ref.max) ref.arr.push(l);
        else {
          toast(`${ref.max} lettres maximum. Retire d’abord une lettre.`);
          break;
        }
        render();
        break;
      }
      case 'sendGuess':
        sendMsg({ t: 'guess', letters: ui.guess });
        ui.editGuess = false;
        break;
      case 'editGuess':
        ui.editGuess = true;
        ui.guess = (S.me.guesses[S.round] || []).slice();
        render();
        break;
      case 'sendFinal': {
        for (const o of others()) for (const r of o.revealed) if (!ui.finalHands[o.id].includes(r) && ui.finalHands[o.id].length < o.handSize) ui.finalHands[o.id].push(r);
        sendMsg({ t: 'final', mystery: ui.finalMystery, hands: ui.finalHands });
        ui.editFinal = false;
        break;
      }
      case 'editFinal':
        ui.editFinal = true;
        render();
        break;
      default:
    }
  });

  $app.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.dataset.form;
    if (f === 'join') {
      const name = ui.name.trim();
      if (name) sendMsg({ t: 'join', name });
    } else if (f === 'reclaim') {
      if (ui.code.trim()) sendMsg({ t: 'reclaim', code: ui.code.trim() });
    } else if (f === 'clue') {
      if (preview('clue').ok) sendMsg({ t: 'clue', word: clean(ui.clueWord) });
    } else if (f === 'ask') {
      if (preview('ask').ok) sendMsg({ t: 'ask', target: ui.target, word: clean(ui.askWord) });
    }
  });

  $app.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.bind) return;
    ui[t.dataset.bind] = t.value;
    if (t.dataset.preview) updatePreview(t.dataset.preview);
  });

  connect();
})();
