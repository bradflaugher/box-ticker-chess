// Runs the engine off the main thread so the board stays responsive.
// This is a browser Web Worker: everything still happens on the player's device.

import { Position, moveToUci } from './engine.js';
import { Engine, chooseMove } from './ai.js';

const engine = new Engine();

self.onmessage = ({ data }) => {
  const pos = new Position(undefined, data.variant);
  for (const uci of data.moves) pos.make(pos.fromUci(uci));
  const best = chooseMove(engine, pos, data.level);
  self.postMessage({ id: data.id, uci: best.move ? moveToUci(best.move) : null, score: best.score, depth: best.depth });
};
