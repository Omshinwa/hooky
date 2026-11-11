# Lettres Cachées

Online word-deduction game for 3–5 players, with a French UI. The server deals the cards, keeps every hand secret and computes every answer, so nobody can miscount.

Only one game runs at a time. Everyone opens the same URL.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # plays 6 full bot games and checks rules + scoring
```

## Deploy on Render (free)

1. Create an **empty** GitHub repository (e.g. `hooky`), then push this folder:
   ```bash
   git remote add origin https://github.com/<you>/hooky.git
   git push -u origin main
   ```
2. On https://dashboard.render.com: **New → Blueprint**, pick the repository. Render reads `render.yaml` (free Node web service) and deploys.
   *(Alternative: New → Web Service, Build `npm install`, Start `npm start`, plan Free.)*
3. Share the `https://hooky-xxxx.onrender.com` URL with your friends.

### Free-tier notes

- The service sleeps after 15 minutes with no visitors. The first visit then takes about 1 minute to wake it up. Open the link a minute before you play.
- While at least one player has the page open, the page pings the server so it stays awake during a game.
- The game is kept in memory: a redeploy or a sleep **ends the current game**.

## How it plays

- Join with a first name in the lobby, arrange the seat order, then press **Lancer la partie** (3–5 players).
- Each player gets a 4-digit **reconnection code**, shown under their hand. Opening the link on another device and entering the code gives them their seat back.
- The **Indices** tab lists every answer, grouped by player. Tap a letter to mark it ✕ / ✓ / ?.
- The **Carnet** tab is the deduction grid. Certain facts fill in automatically: your hand, revealed cards, cards you peeked at, and Centre cards.
- Words are not dictionary-checked. Any 5 letters are accepted and the table validates the word out loud. Accents are folded (É → E, Œ → OE).
