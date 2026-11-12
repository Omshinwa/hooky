# Hooky Helper

A small pass-the-device helper for Hooky. Players still play on paper. The helper does two things:

- keeps every player's letters secret, and
- answers "how many of Bob's letters are in this word?" without counting mistakes.

It's a static page (HTML, CSS and JS, no server). Everything is saved in the browser's `localStorage`, so reloading the page doesn't lose the game.

## How it works

1. **Players.** Choose the number of players (3–5).
2. **Hands.** Pass the device around. Each player types their name and taps the letters they were dealt: exactly 7, 5 or 4 for 3, 4 or 5 players. Their letters are hidden as soon as they tap **Done**.
3. **Check.** The helper warns if two players entered the same letter. It names the two players but not the letter. Each of them taps **Fix** to correct their hand in private.
4. **Play.** Type a 5-letter word, pick who answers, tap **Check**. The helper shows the count. Every occurrence counts: holding E and N, NEVER scores 3. Each answer is added to the history.
5. **End game** at any time reveals everyone's letters.

The helper doesn't know the playground or the hooky letters.

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000   # http://localhost:8000
```

Tests for the counting and duplicate-letter logic (Node 18+):

```bash
node --test
```

## Publish on GitHub Pages

1. Push to GitHub.
2. In the repository: **Settings → Pages → Build and deployment**, source **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The helper is live at `https://<user>.github.io/hooky/` after a minute.

Any other static host (Netlify, Cloudflare Pages, Vercel…) works the same way: there's no build step.
