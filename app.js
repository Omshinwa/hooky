'use strict';
/*
 * Hooky Helper — one shared device, passed around the table.
 * Players keep their paper; the helper only stores each hand in secret and
 * answers "how many of Bob's letters are in this word?". Everything lives in
 * localStorage, so the page works from any static host.
 */
(function () {
  const { normalizeWord, countMatches, findConflicts } = window.HookyLogic;

  const STORE_KEY = 'hooky-helper/v1';
  const PHASES = ['setup', 'deal', 'review', 'play', 'over'];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const PLAYER_COUNTS = [3, 4, 5];
  const HAND_SIZE = { 3: 7, 4: 5, 5: 4 }; // letters dealt to each player
  const WORD_LENGTH = 5;
  const NAME_MAX = 16;

  const app = document.getElementById('app');
  const topActions = document.getElementById('top-actions');
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  let state = load() || newState();
  let ui = newUi();

  // ------------------------------------------------------------------ state

  function newState(prev) {
    return {
      phase: 'setup',
      count: prev ? prev.count : 4,
      // Names carry over to the next game; letters never do.
      players: prev ? prev.players.map((p) => ({ name: p.name, letters: [] })) : [],
      dealIndex: 0,
      history: [], // { id, word, target, score }
      lastId: null,
      seq: 0,
    };
  }

  function newUi() {
    return { form: null, word: '', target: null, error: '', confirmEnd: false };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && PHASES.includes(s.phase) && Array.isArray(s.players) && Array.isArray(s.history)) return s;
    } catch {
      /* private mode or corrupted data: start fresh */
    }
    return null;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* the game still works, it just won't survive a reload */
    }
  }

  function commit() {
    save();
    render();
  }

  const hands = () => state.players.map((p) => p.letters);
  const expected = () => HAND_SIZE[state.count];

  // The hand form: used once per player while dealing, and again to fix a hand.
  function openForm(index, mode) {
    const p = state.players[index];
    ui.form = {
      index,
      mode, // 'deal' | 'edit'
      name: p.name,
      letters: mode === 'edit' ? p.letters.slice() : [],
      unlocked: mode === 'deal', // an edit shows a cover screen first
      error: '',
      kind: 'bad',
    };
  }

  function formMessage(text, kind = 'bad') {
    ui.form.error = text;
    ui.form.kind = kind;
    render();
  }

  function toggleLetter(l) {
    const f = ui.form;
    const i = f.letters.indexOf(l);
    if (i >= 0) f.letters.splice(i, 1);
    else if (f.letters.length >= expected())
      return formMessage(`You already have ${expected()} letters. Tap one to remove it first.`, 'warn');
    else f.letters.push(l);
    f.error = '';
    render();
  }

  function saveHand() {
    const f = ui.form;
    const name = f.name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) return formMessage('Enter your name.');
    const taken = state.players.some(
      (p, j) => j !== f.index && (f.mode === 'edit' || j < f.index) && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) return formMessage(`“${name}” is already taken. Add an initial?`);
    if (f.letters.length !== expected())
      return formMessage(`Tap all ${expected()} letters you were dealt (${f.letters.length} so far).`);

    const p = state.players[f.index];
    p.name = name;
    p.letters = f.letters.slice().sort();
    ui.form = null;
    if (f.mode === 'deal') {
      if (f.index + 1 < state.count) state.dealIndex = f.index + 1;
      else state.phase = 'review';
    }
    commit();
    scrollTop();
  }

  function check() {
    const word = normalizeWord(ui.word);
    if (word.length !== WORD_LENGTH) {
      return playError(
        word.length
          ? `“${word}” has ${plural(word.length, 'letter')}. Words have ${WORD_LENGTH}.`
          : `Type a ${WORD_LENGTH}-letter word.`,
      );
    }
    if (ui.target == null) return playError('Choose who answers.');
    const entry = {
      id: ++state.seq,
      word,
      target: ui.target,
      score: countMatches(word, state.players[ui.target].letters),
    };
    state.history.push(entry);
    state.lastId = entry.id;
    ui.word = '';
    ui.target = null;
    ui.error = '';
    commit();
    if (finePointer) document.getElementById('word')?.focus();
  }

  function playError(text) {
    ui.error = text;
    render();
  }

  // ---------------------------------------------------------------- actions

  const actions = {
    count(el) {
      state.count = Number(el.dataset.n);
      commit();
    },
    begin() {
      const prev = state.players;
      state.players = Array.from({ length: state.count }, (_, i) => ({ name: prev[i] ? prev[i].name : '', letters: [] }));
      state.phase = 'deal';
      state.dealIndex = 0;
      ui = newUi();
      commit();
    },
    back() {
      state.phase = 'setup';
      ui = newUi();
      commit();
    },
    letter: (el) => toggleLetter(el.dataset.l),
    'save-hand': saveHand,
    edit(el) {
      openForm(Number(el.dataset.i), 'edit');
      render();
      scrollTop();
    },
    unlock() {
      ui.form.unlocked = true;
      render();
    },
    'cancel-edit'() {
      ui.form = null;
      render();
      scrollTop();
    },
    start() {
      if (findConflicts(hands()).length) return;
      state.phase = 'play';
      ui = newUi();
      commit();
    },
    target(el) {
      ui.target = Number(el.dataset.i);
      ui.error = '';
      render();
    },
    check,
    remove(el) {
      const id = Number(el.dataset.id);
      const h = state.history.find((x) => x.id === id);
      if (!h || !window.confirm(`Remove “${h.word} → ${state.players[h.target].name}” from the history?`)) return;
      state.history = state.history.filter((x) => x.id !== id);
      if (state.lastId === id) state.lastId = null;
      commit();
    },
    'end-ask'() {
      ui.confirmEnd = true;
      render();
      scrollTop();
    },
    'end-cancel'() {
      ui.confirmEnd = false;
      render();
    },
    'end-confirm'() {
      state.phase = 'over';
      ui = newUi();
      commit();
      scrollTop();
    },
    restart() {
      if (!window.confirm('Start over? The letters entered so far will be cleared.')) return;
      state = newState(state);
      ui = newUi();
      commit();
    },
    'new-game'() {
      state = newState(state);
      ui = newUi();
      commit();
      scrollTop();
    },
  };

  function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  }

  app.addEventListener('click', onClick);
  topActions.addEventListener('click', onClick);

  // Inputs update ui without re-rendering, so typing never loses focus.
  app.addEventListener('input', (e) => {
    if (e.target.id === 'name' && ui.form) ui.form.name = e.target.value;
    if (e.target.id === 'word') {
      ui.word = e.target.value;
      if (ui.error) {
        ui.error = '';
        document.getElementById('play-error')?.setAttribute('hidden', '');
      }
    }
  });

  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'word') {
      e.preventDefault();
      check();
    } else if (e.target.id === 'name') {
      e.preventDefault();
      e.target.blur();
    }
  });

  // With a physical keyboard, typing a letter toggles it on the hand form.
  document.addEventListener('keydown', (e) => {
    const f = ui.form;
    if (!f || !f.unlocked || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const l = e.key.toUpperCase();
    if (/^[A-Z]$/.test(l)) {
      e.preventDefault();
      toggleLetter(l);
    }
  });

  // ------------------------------------------------------------------ views

  function render() {
    if (state.phase === 'deal' && (!ui.form || ui.form.mode !== 'deal' || ui.form.index !== state.dealIndex)) {
      openForm(state.dealIndex, 'deal');
    }
    const views = {
      setup: viewSetup,
      deal: viewForm,
      review: () => (ui.form ? viewForm() : viewReview()),
      play: viewPlay,
      over: viewOver,
    };
    app.innerHTML = views[state.phase]();
    topActions.innerHTML = viewTopActions();
  }

  function viewTopActions() {
    if (state.phase === 'deal' || state.phase === 'review')
      return `<button class="btn ghost slim" data-action="restart">Restart</button>`;
    if (state.phase === 'play' && !ui.confirmEnd)
      return `<button class="btn ghost slim" data-action="end-ask">End game</button>`;
    return '';
  }

  function viewSetup() {
    const n = state.count;
    return `
      <section class="card">
        <p class="lead">Each player enters the letters they were dealt, in secret. During the game, type a word and pick a player: the helper tells you how many of their letters the word contains.</p>
        <p class="muted small">Keep your paper for notes. The helper doesn't know the playground or the hooky letters.</p>
      </section>
      <section class="card">
        <h2>How many players?</h2>
        <div class="seg" role="radiogroup" aria-label="Number of players">
          ${PLAYER_COUNTS.map(
            (c) =>
              `<button class="seg-btn${c === n ? ' on' : ''}" role="radio" aria-checked="${c === n}" data-action="count" data-n="${c}">${c}</button>`,
          ).join('')}
        </div>
        <p class="muted small center">With ${n} players, everyone is dealt ${HAND_SIZE[n]} letters.</p>
        <button class="btn primary big" data-action="begin">Enter the hands</button>
      </section>`;
  }

  function viewForm() {
    const f = ui.form;
    const i = f.index;
    const p = state.players[i];
    const color = `--c: var(--p${i})`;

    if (!f.unlocked) {
      return `
        <section class="card cover">
          <div class="step">Secret</div>
          <h2>Hand the device to <span class="who" style="${color}">${esc(p.name)}</span></h2>
          <p class="muted">Everyone else, look away. ${esc(p.name)}, tap below to see and fix your letters.</p>
          <button class="btn primary big" data-action="unlock">I'm ${esc(p.name)}, show my letters</button>
          <button class="btn ghost big" data-action="cancel-edit">Cancel</button>
        </section>`;
    }

    const chosen = f.letters.slice().sort();
    const slots =
      chosen.map((l) => tile(l)).join('') +
      '<span class="tile slot"></span>'.repeat(Math.max(0, expected() - chosen.length));
    const head =
      f.mode === 'deal'
        ? `<div class="step">Player ${i + 1} of ${state.count}</div>
           <h2>${i === 0 ? 'First player' : `Pass the device to player ${i + 1}`}</h2>
           <p class="muted">Everyone else, look away.</p>`
        : `<div class="step">Fixing a hand</div>
           <h2>${esc(p.name)}'s letters</h2>
           <p class="muted">Compare with your paper and correct your letters.</p>`;
    const secondary =
      f.mode === 'edit'
        ? `<button class="btn ghost big" data-action="cancel-edit">Cancel</button>`
        : i === 0
          ? `<button class="btn ghost big" data-action="back">Back</button>`
          : '';

    return `
      <section class="card form" style="${color}">
        ${head}
        <label class="lbl" for="name">Name</label>
        <input id="name" value="${esc(f.name)}" maxlength="${NAME_MAX}" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Your name" enterkeyhint="done">
        <div class="lbl-row">
          <span class="lbl">Letters you were dealt</span>
          <span class="count${chosen.length === expected() ? ' ok' : ''}">${chosen.length} / ${expected()}</span>
        </div>
        <div class="tiles hand">${slots}</div>
        <div class="keys">
          ${LETTERS.map((l) => {
            const on = f.letters.includes(l);
            return `<button class="key${on ? ' on' : ''}" data-action="letter" data-l="${l}" aria-pressed="${on}">${l}</button>`;
          }).join('')}
        </div>
        ${f.error ? `<p class="msg ${f.kind}" role="alert">${esc(f.error)}</p>` : ''}
        <button class="btn primary big" data-action="save-hand">${f.mode === 'deal' ? 'Done, hide my letters' : 'Save'}</button>
        ${secondary}
      </section>`;
  }

  function viewReview() {
    const conflicts = findConflicts(hands());
    const flagged = new Set(conflicts.flatMap((c) => [c.a, c.b]));
    const rows = state.players
      .map(
        (p, i) => `
          <li class="${flagged.has(i) ? 'flag' : ''}">
            ${who(i)}
            <span class="meta">${plural(p.letters.length, 'letter')}</span>
            <button class="btn slim" data-action="edit" data-i="${i}">Fix</button>
          </li>`,
      )
      .join('');
    const status = conflicts.length
      ? `<div class="msg bad" role="alert">
           <p><strong>The same letter was entered twice.</strong></p>
           <ul>${conflicts
             .map(
               (c) =>
                 `<li>${esc(name(c.a))} and ${esc(name(c.b))} entered ${c.count === 1 ? 'the same letter' : `${c.count} of the same letters`}.</li>`,
             )
             .join('')}</ul>
           <p>Each of you, check your paper, then tap <b>Fix</b> next to your name.</p>
         </div>`
      : `<p class="msg ok">No letter was entered twice.</p>`;
    return `
      <section class="card">
        <h2>Check the hands</h2>
        <p class="muted">Letters stay hidden; only the counts are shown.</p>
        <ul class="roster">${rows}</ul>
        ${status}
        <button class="btn primary big" data-action="start"${conflicts.length ? ' disabled' : ''}>Start the game</button>
      </section>`;
  }

  function viewPlay() {
    const last = state.history.find((h) => h.id === state.lastId);
    const confirmEnd = ui.confirmEnd
      ? `<section class="card confirm">
           <h2>End the game?</h2>
           <p class="muted">Everyone's letters will be revealed.</p>
           <div class="row">
             <button class="btn" data-action="end-cancel">Keep playing</button>
             <button class="btn danger" data-action="end-confirm">End and reveal</button>
           </div>
         </section>`
      : '';
    return `
      ${confirmEnd}
      <section class="card">
        <label class="lbl first" for="word">Word</label>
        <input id="word" class="word-input" value="${esc(ui.word)}" maxlength="24" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="${WORD_LENGTH} letters" enterkeyhint="go">
        <span class="lbl">Who answers?</span>
        <div class="chips">
          ${state.players
            .map(
              (p, i) =>
                `<button class="chip${ui.target === i ? ' on' : ''}" style="--c: var(--p${i})" data-action="target" data-i="${i}" aria-pressed="${ui.target === i}">${esc(p.name)}</button>`,
            )
            .join('')}
        </div>
        <p class="msg bad" id="play-error" role="alert"${ui.error ? '' : ' hidden'}>${esc(ui.error)}</p>
        <button class="btn primary big" data-action="check">Check</button>
        <p class="muted small center note">Every occurrence counts: holding E and N, NEVER scores 3.</p>
      </section>
      ${last ? viewResult(last) : ''}
      ${viewHistory(true)}`;
  }

  function viewResult(h) {
    return `
      <section class="card result" style="--c: var(--p${h.target})" aria-live="polite">
        <div class="score" aria-label="${plural(h.score, 'letter')}">${h.score}</div>
        <div class="result-body">
          <p>${who(h.target)}<span class="muted">'s answer</span></p>
          <div class="tiles">${[...h.word].map((l) => tile(l, 'sm')).join('')}</div>
        </div>
      </section>`;
  }

  function viewHistory(removable) {
    const list = state.history.slice().reverse();
    const rows = list
      .map(
        (h) => `
          <li class="${h.id === state.lastId ? 'latest' : ''}">
            <span class="hn">#${h.id}</span>
            <span class="hw">${h.word}</span>
            ${who(h.target)}
            <span class="hs">${h.score}</span>
            ${removable ? `<button class="x" data-action="remove" data-id="${h.id}" aria-label="Remove ${h.word} from history">×</button>` : ''}
          </li>`,
      )
      .join('');
    return `
      <section class="card">
        <div class="card-head"><h2>History</h2><span class="muted small">${plural(list.length, 'question')}</span></div>
        ${list.length ? `<ol class="history${removable ? '' : ' fixed'}">${rows}</ol>` : `<p class="muted">Nothing asked yet.</p>`}
      </section>`;
  }

  function viewOver() {
    return `
      <section class="card">
        <h2>Game over</h2>
        <p class="muted">Here is what everyone was dealt.</p>
        <ul class="hands">
          ${state.players
            .map((p, i) => `<li>${who(i)}<div class="tiles">${p.letters.map((l) => tile(l, 'sm')).join('')}</div></li>`)
            .join('')}
        </ul>
        <button class="btn primary big" data-action="new-game">New game</button>
      </section>
      ${viewHistory(false)}`;
  }

  // ---------------------------------------------------------------- helpers

  function name(i) {
    return state.players[i] ? state.players[i].name : '?';
  }

  function who(i) {
    return `<span class="who" style="--c: var(--p${i})">${esc(name(i))}</span>`;
  }

  function tile(l, size = '') {
    return `<span class="tile ${size}">${l}</span>`;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function scrollTop() {
    window.scrollTo(0, 0);
  }

  render();
})();
