# 🔐 Password Game

A real-time multiplayer party word game for 2–8 players, playable in iPhone Safari and installable as a PWA.

## Quick Start

```bash
npm install
npm start
# → http://localhost:3000
```

## How to Play

1. **Create a Room** — get a 6-letter code
2. **Share the code** — friends join on their phones
3. **Auto-assign teams** — or edit manually (teams of 2)
4. **Start the game**

### Gameplay

- Each team has a **Hinter** and a **Guesser** (roles swap every round)
- The Hinter sees the secret password + a list of **banned words**
- The Hinter gives a ONE-WORD clue (no banned words, can't say the password itself)
- The Guesser tries to guess the password
- If **correct** → team gets **+1 point** (or **+0.5** in the final round)
- If **wrong** → next team gets a turn
- After 3 full rounds (all teams × 3), the word is revealed and play moves on

### Rounds per Word

| Round | Points if correct |
|-------|------------------|
| 1     | 1 pt             |
| 2     | 1 pt             |
| 3 ⭐  | 0.5 pts (final)  |

## Word Bank

- **290 words** across 7 categories
- Each word has 6 strong banned words
- Words don't repeat until the full pool is exhausted
- Categories: Football · Cricket · Politics · Gen-Z · Internet · Tech · Pop Culture

## PWA Install (iPhone)

1. Open `http://your-server:3000` in Safari
2. Tap the Share button → **Add to Home Screen**
3. Launch from home screen — runs fullscreen like a native app

## File Structure

```
password-game/
├── server.js        # Express + Socket.io backend (in-memory)
├── words.js         # Word bank (290 words + banned lists)
├── package.json
└── public/
    ├── index.html   # Full single-page frontend
    ├── manifest.json
    ├── sw.js        # Service worker
    └── icon-*.png
```

## Adding More Words

Edit `words.js` and add entries to the `WORDS` array:

```js
{ id: 'f999', category: 'football', word: 'Panenka', banned: ['penalty', 'chip', 'cheeky', 'lob', 'slow', 'kick'] },
```

## Hosting

Works on any Node.js host: Railway, Render, Fly.io, DigitalOcean, etc.
Set `PORT` environment variable if needed (default: 3000).

> **Note:** Uses in-memory storage — game state resets on server restart. For production persistence, swap Maps for a database.
