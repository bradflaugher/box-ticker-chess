# Box-Ticker Chess

Chess board and pieces, normal rules — but the objective is different: **the first
player to give their opponent three checks wins the game**, regardless of anything else.

Every check ticks one of your three boxes. Tick all three and the game is over.

**Play it:** https://bradflaugher.github.io/box-ticker-chess/

## What's in the box

- **Computer opponent** with four ranks (Intern → Commissioner). It runs entirely on
  your device, in a background thread of the browser tab. No server, no downloads.
- **Pass & play** for two people on one screen.
- **Friend online**: create an invite link and send it. The two browsers connect
  directly to each other (WebRTC), so there is no game server.
- **Copy link** captures the current position in a URL you can send to anyone.
- Drag-and-drop or tap-tap moves, legal-move hints, undo, board flip, sound,
  and your game is still there after a reload.

## The rules

1. Pieces move exactly as in ordinary chess (castling, en passant, promotion).
2. Each time you put the enemy king in check, one of your boxes is ticked.
3. Three ticks wins immediately. Checkmate also wins.
4. One move that attacks the king twice (a double check) still ticks one box.
5. You may not leave your own king in check. Stalemate, threefold repetition,
   fifty quiet moves, and bare kings are draws.

## Running it locally

It is a static site with no build step. Serve the folder with any web server:

```sh
npm start            # or: python3 -m http.server 8080
```

Then open http://localhost:8080. (Opening `index.html` straight from disk will not
work, because browsers block JavaScript modules on `file://`.)

```sh
npm install
npm test             # rules + AI tests
npm run lint
```

## Hosting on GitHub Pages

The repository root *is* the site. In the repo go to **Settings → Pages**, set
**Source** to *Deploy from a branch*, pick **main** and **/ (root)**, and save.

## How it works

| File | Job |
| --- | --- |
| `js/engine.js` | Rules: move generation, check counting, results, notation |
| `js/ai.js` | Search (alpha-beta, transposition table, check-aware quiescence) and evaluation |
| `js/ai-worker.js` | Runs the AI off the main thread so the board never freezes |
| `js/net.js` | Peer-to-peer link for online games |
| `js/main.js` | Board, input, game flow |

A note on "no server" for online play: once connected, moves travel straight between
the two browsers. To *find* each other, the browsers use the free public
[PeerJS](https://peerjs.com) broker for a brief handshake. If that service is ever
down, invites will not connect; everything else keeps working.

## Credits

- Piece artwork by Colin M.L. Burnett (see `pieces/LICENSE.md`).
- [PeerJS](https://github.com/peers/peerjs), MIT (see `vendor/peerjs.LICENSE`).
- Everything else: MIT, see `LICENSE`.
