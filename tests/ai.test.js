import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../js/engine.js';
import { Engine, chooseMove, LEVELS, MATE_BOUND } from '../js/ai.js';

test('takes the winning third check', () => {
  const pos = new Position('rnbqkbnr/ppp2ppp/8/3pp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3 +2+0');
  const best = new Engine().search(pos, { timeMs: 2000, maxDepth: 4 });
  assert.equal(moveToUci(best.move), 'f1b5');
  assert.ok(best.score > MATE_BOUND);
});

test('every level finds a win in one', () => {
  for (let level = 0; level < LEVELS.length; level++) {
    const pos = new Position('rnbqkbnr/ppp2ppp/8/3pp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 13 +2+0');
    pos.hp = 0;
    const { move } = chooseMove(new Engine(), pos, level, () => 0.99);
    pos.make(move);
    assert.equal(pos.result()?.reason, 'three-checks', LEVELS[level].name);
  }
});

test('removes the piece that threatens the final check', () => {
  // Black (two checks in) threatens Re1+. Only capturing the rook stops it.
  const pos = new Position('4r1k1/5ppp/8/1B6/8/8/5PPP/6K1 w - - 0 1 +0+2');
  const { move } = new Engine().search(pos, { timeMs: 2000, maxDepth: 5 });
  assert.equal(moveToUci(move), 'b5e8');
});

test('finds mate in one', () => {
  const pos = new Position('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  const best = new Engine().search(pos, { timeMs: 2000, maxDepth: 4 });
  assert.equal(moveToUci(best.move), 'a1a8');
});

test('delivers mate even as the fifty-move clock runs out', () => {
  const pos = new Position('6k1/5ppp/8/8/8/8/8/R5K1 w - - 99 1');
  const best = new Engine().search(pos, { timeMs: 2000, maxDepth: 4 });
  assert.equal(moveToUci(best.move), 'a1a8');
  assert.ok(best.score > MATE_BOUND);
});

test('scores stalemate as a draw at the search horizon', () => {
  const pos = new Position('k7/4Q3/2K5/8/8/8/8/8 w - - 0 1');
  const scored = new Engine().scoreRoot(pos, 1);
  assert.ok(scored.find((s) => moveToUci(s.move) === 'e7c7').score === 0);
  assert.notEqual(moveToUci(scored[0].move), 'e7c7');
});

test('plays a full legal game against itself', () => {
  const engine = new Engine();
  const pos = new Position();
  let plies = 0;
  while (!pos.result() && plies < 300) {
    const { move } = engine.search(pos, { timeMs: 1000, maxDepth: 3 });
    assert.ok(pos.legalMoves().includes(move));
    pos.make(move);
    plies++;
  }
  assert.ok(pos.result() || plies === 300);
});
