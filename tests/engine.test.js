import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, perft, WHITE, BLACK, START_FEN } from '../js/engine.js';

function playSan(pos, line) {
  for (const san of line.split(' ')) {
    const move = pos.legalMoves().find((m) => pos.san(m) === san);
    assert.ok(move, `no legal move matches ${san}`);
    pos.make(move);
  }
  return pos;
}

test('move generation matches known perft counts', () => {
  const cases = [
    [START_FEN, 4, 197281],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
  ];
  for (const [fen, depth, nodes] of cases) {
    const pos = new Position(fen);
    const before = [pos.fen(), pos.lo, pos.hi];
    assert.equal(perft(pos, depth), nodes, fen);
    assert.deepEqual([pos.fen(), pos.lo, pos.hi], before, 'make/unmake restores the position');
  }
});

test('the third check wins immediately', () => {
  const pos = playSan(new Position(), 'e4 e5 Qh5 Nc6 Qxf7+ Kxf7 Bc4+ Ke8');
  assert.deepEqual(pos.checks, [2, 0]);
  assert.equal(pos.result(), null);
  const move = pos.legalMoves().find((m) => pos.san(m) === 'Bf7#');
  assert.ok(move, 'the winning check is written with #');
  pos.make(move);
  assert.deepEqual(pos.result(), { winner: WHITE, reason: 'three-checks' });
});

test('checks are counted per player and undone with the move', () => {
  const pos = playSan(new Position(), 'e4 d5 Bb5+ c6 Bxc6+ bxc6 d3 Qa5+');
  assert.deepEqual(pos.checks, [2, 1]);
  pos.unmake();
  assert.deepEqual(pos.checks, [2, 0]);
  assert.match(pos.fen(), / \+2\+0$/);
  assert.deepEqual(new Position(pos.fen()).checks, [2, 0]);
});

test('a double check only ticks one box', () => {
  const pos = new Position('4k3/8/8/8/8/4N3/8/K3R3 w - - 0 1');
  pos.make(pos.fromUci('e3d5')); // discovered check from the rook only
  assert.deepEqual(pos.checks, [1, 0]);
  const dbl = new Position('4k3/8/8/8/4N3/8/8/K3R3 w - - 0 1');
  dbl.make(dbl.fromUci('e4f6')); // knight and rook both give check
  assert.equal(dbl.inCheck, true);
  assert.deepEqual(dbl.checks, [1, 0]);
});

test('checkmate still wins before three checks', () => {
  const pos = playSan(new Position(), 'f3 e5 g4 Qh4#');
  assert.deepEqual(pos.result(), { winner: BLACK, reason: 'checkmate' });
  assert.deepEqual(pos.checks, [0, 1]);
});

test('stalemate, repetition and bare kings are draws', () => {
  assert.deepEqual(new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').result(), { winner: null, reason: 'stalemate' });
  assert.deepEqual(new Position('7k/8/6K1/8/8/8/8/8 w - - 0 1').result(), { winner: null, reason: 'material' });
  const pos = playSan(new Position(), 'Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1');
  assert.equal(pos.result(), null);
  playSan(pos, 'Ng8');
  assert.deepEqual(pos.result(), { winner: null, reason: 'repetition' });
});

test('an en-passant square that cannot be used does not block repetition', () => {
  // exd6 would expose the white king, so the square must not count.
  const pos = new Position('k3r1n1/8/8/3pP3/8/8/8/4K1N1 w - d6 0 1');
  assert.equal(pos.ep, -1);
  playSan(pos, 'Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8');
  assert.deepEqual(pos.result(), { winner: null, reason: 'repetition' });
  // A usable en-passant square is still kept.
  const live = playSan(new Position(), 'e4 a6 e5 d5');
  assert.match(live.fen(), / d6 /);
  assert.ok(live.legalMoves().some((m) => live.san(m) === 'exd6'));
  // ...but not when no pawn stands ready to capture.
  assert.match(playSan(new Position(), 'e4').fen(), / - 0 1 /);
});

test('isStalemate agrees with the full rules', () => {
  assert.equal(new Position('7k/5K1n/8/8/8/8/8/7R b - - 1 1').isStalemate(), true);
  assert.equal(new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').isStalemate(), true);
  assert.equal(new Position('7k/5K1n/8/8/8/8/8/6R1 b - - 1 1').isStalemate(), false);
  assert.equal(new Position().isStalemate(), false);
});

test('special moves: castling, en passant, promotion, disambiguation', () => {
  const pos = playSan(new Position(), 'e4 e6 e5 d5 exd6 Bxd6 Nf3 Nf6 Bc4 O-O O-O');
  assert.equal(pos.fen().split(' ')[0], 'rnbq1rk1/ppp2ppp/3bpn2/8/2B5/5N2/PPPP1PPP/RNBQ1RK1');
  const promo = new Position('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.deepEqual(promo.legalMoves().map((m) => promo.san(m)).filter((s) => s.includes('=')).sort(),
    ['a8=B', 'a8=N', 'a8=Q', 'a8=R']);
  const twins = new Position('4k3/8/8/8/8/8/K7/R6R w - - 0 1');
  assert.ok(twins.legalMoves().some((m) => twins.san(m) === 'Rhd1'));
});

test('illegal input is rejected', () => {
  const pos = new Position();
  assert.equal(pos.fromUci('e2e5'), 0);
  assert.equal(pos.fromUci('nonsense'), 0);
});
