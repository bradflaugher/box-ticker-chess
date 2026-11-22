// Three-check search: iterative-deepening alpha-beta with a transposition
// table, quiescence that also looks at checks, and an evaluation that treats
// delivered checks and king exposure as first-class citizens.

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, CHECKS_TO_WIN,
  moveFrom, moveTo, movePromo, moveFlag, FLAG_EP,
} from './engine.js';

const MATE = 30000;
const MATE_BOUND = MATE - 500;
const INF = 32000;
const MAX_PLY = 64;

const VALUE = [0, 100, 320, 330, 500, 900, 0];
// What a delivered check is worth, by how many are already in the bag.
const CHECK_BONUS = [0, 190, 640, 0];

// Piece-square tables, written from White's side with rank 8 on top.
const PST = [
  null,
  [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
];

// PSQ[piece][sq]: material + placement, positive for both colours.
const PSQ = [];
for (let piece = 0; piece < 16; piece++) {
  const table = new Int16Array(128);
  const type = piece & 7;
  if (type >= PAWN && type <= KING) {
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const r = sq >> 4;
      const idx = (piece >> 3 === WHITE ? 7 - r : r) * 8 + (sq & 7);
      table[sq] = VALUE[type] + PST[type][idx];
    }
  }
  PSQ.push(table);
}

const Q_DIRS = [-17, -16, -15, -1, 1, 15, 16, 17];

// Squares a queen standing on the king's square could reach: a cheap,
// effective measure of how many lines lead to the king.
function kingExposure(board, sq) {
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const o = Q_DIRS[i];
    let t = sq + o;
    while (!(t & 0x88) && !board[t]) {
      n++;
      t += o;
    }
  }
  return n;
}

export function evaluate(pos) {
  const b = pos.board;
  let score = 0;
  let wBishops = 0;
  let bBishops = 0;
  let wHeavy = 0; // attacking potential, used to scale king danger
  let bHeavy = 0;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p) continue;
    const type = p & 7;
    if (p < 8) {
      score += PSQ[p][sq];
      if (type === BISHOP) wBishops++;
      if (type === QUEEN) wHeavy += 4;
      else if (type === ROOK) wHeavy += 2;
      else if (type === BISHOP || type === KNIGHT) wHeavy += 1;
    } else {
      score -= PSQ[p][sq];
      if (type === BISHOP) bBishops++;
      if (type === QUEEN) bHeavy += 4;
      else if (type === ROOK) bHeavy += 2;
      else if (type === BISHOP || type === KNIGHT) bHeavy += 1;
    }
  }
  if (wBishops >= 2) score += 30;
  if (bBishops >= 2) score -= 30;

  const wc = pos.checks[WHITE];
  const bc = pos.checks[BLACK];
  score += CHECK_BONUS[wc > 3 ? 3 : wc] - CHECK_BONUS[bc > 3 ? 3 : bc];
  // An exposed king hurts more the closer the opponent is to three checks.
  score -= (kingExposure(b, pos.king[WHITE]) * bHeavy * (2 + 3 * bc)) >> 2;
  score += (kingExposure(b, pos.king[BLACK]) * wHeavy * (2 + 3 * wc)) >> 2;

  return (pos.turn === WHITE ? score : -score) + 10;
}

const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const EXACT = 1;
const LOWER = 2;
const UPPER = 3;

export class Engine {
  constructor() {
    this.ttKey = new Int32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttScore = new Int16Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE);
    this.ttFlag = new Int8Array(TT_SIZE);
    this.history = new Int32Array(16 * 128);
    this.killers = new Int32Array(MAX_PLY * 2);
    this.lists = Array.from({ length: MAX_PLY + 8 }, () => []);
    this.scores = Array.from({ length: MAX_PLY + 8 }, () => []);
    this.nodes = 0;
    this.stop = false;
    this.deadline = Infinity;
  }

  clear() {
    this.ttKey.fill(0);
    this.ttFlag.fill(0);
    this.history.fill(0);
    this.killers.fill(0);
  }

  tick() {
    if ((++this.nodes & 1023) === 0 && performance.now() > this.deadline) this.stop = true;
  }

  scoreMoves(list, scores, ttMove, ply) {
    const pos = this.pos;
    const b = pos.board;
    const k1 = this.killers[ply * 2];
    const k2 = this.killers[ply * 2 + 1];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      let s;
      if (m === ttMove) s = 1 << 30;
      else {
        const victim = b[moveTo(m)] & 7;
        const mover = b[moveFrom(m)];
        if (victim || moveFlag(m) & FLAG_EP) s = (1 << 24) + (victim || PAWN) * 16 - (mover & 7);
        else if (movePromo(m)) s = (1 << 24) + movePromo(m);
        else if (m === k1) s = (1 << 23) + 1;
        else if (m === k2) s = 1 << 23;
        else s = this.history[mover * 128 + moveTo(m)];
      }
      scores[i] = s;
    }
  }

  // Selection step: bring the best remaining move to index i.
  pick(list, scores, i) {
    let best = i;
    for (let j = i + 1; j < list.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = list[i];
      list[i] = list[best];
      list[best] = m;
      const s = scores[i];
      scores[i] = scores[best];
      scores[best] = s;
    }
    return list[i];
  }

  qs(alpha, beta, ply, qply) {
    const pos = this.pos;
    if (pos.checks[pos.turn ^ 1] >= CHECKS_TO_WIN) return -(MATE - ply);
    this.tick();
    if (this.stop) return 0;
    const inCheck = pos.inCheck;
    if (ply >= MAX_PLY - 1) return evaluate(pos);
    let best = -INF;
    if (!inCheck) {
      best = evaluate(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }
    // Quiet checks matter here: each one is real progress, and the third wins.
    const wantChecks = !inCheck && (qply === 0 || pos.checks[pos.turn] === CHECKS_TO_WIN - 1);
    const list = this.lists[ply];
    const scores = this.scores[ply];
    list.length = 0;
    pos.gen(list, !(inCheck || wantChecks));
    this.scoreMoves(list, scores, 0, ply);
    let legal = 0;
    for (let i = 0; i < list.length; i++) {
      const m = this.pick(list, scores, i);
      const noisy = inCheck || scores[i] >= 1 << 24;
      if (!pos.make(m)) continue;
      if (!noisy && !pos.inCheck) {
        pos.unmake();
        continue;
      }
      legal++;
      const score = -this.qs(-beta, -alpha, ply + 1, qply + 1);
      pos.unmake();
      if (this.stop) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) break;
        }
      }
    }
    if (inCheck && !legal) return -(MATE - ply);
    return best;
  }

  ab(depth, alpha, beta, ply, allowNull) {
    const pos = this.pos;
    if (pos.checks[pos.turn ^ 1] >= CHECKS_TO_WIN) return -(MATE - ply);
    if (pos.halfmove >= 100 || pos.repetitions() > 0) return 0;
    const inCheck = pos.inCheck;
    if (inCheck) depth++;
    if (depth <= 0) return this.qs(alpha, beta, ply, 0);
    this.tick();
    if (this.stop) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const idx = pos.lo & TT_MASK;
    let ttMove = 0;
    if (this.ttFlag[idx] && this.ttKey[idx] === pos.hi) {
      ttMove = this.ttMove[idx];
      if (this.ttDepth[idx] >= depth) {
        let s = this.ttScore[idx];
        if (s > MATE_BOUND) s -= ply;
        else if (s < -MATE_BOUND) s += ply;
        const flag = this.ttFlag[idx];
        if (flag === EXACT || (flag === LOWER && s >= beta) || (flag === UPPER && s <= alpha)) return s;
      }
    }

    if (allowNull && !inCheck && depth >= 3 && beta < MATE_BOUND && beta > -MATE_BOUND && this.hasPieces(pos.turn)
      && evaluate(pos) >= beta) {
      pos.makeNull();
      const s = -this.ab(depth - 3, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stop) return 0;
      if (s >= beta) return beta;
    }

    const list = this.lists[ply];
    const scores = this.scores[ply];
    list.length = 0;
    pos.gen(list);
    this.scoreMoves(list, scores, ttMove, ply);
    const alpha0 = alpha;
    let best = -INF;
    let bestMove = 0;
    let legal = 0;
    for (let i = 0; i < list.length; i++) {
      const m = this.pick(list, scores, i);
      const quiet = scores[i] < 1 << 24 || (m === ttMove && !pos.isCapture(m) && !movePromo(m));
      const mover = pos.board[moveFrom(m)];
      if (!pos.make(m)) continue;
      legal++;
      let score;
      if (legal === 1) score = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let r = 0;
        if (depth >= 3 && legal > 4 && quiet && !inCheck && !pos.inCheck) r = legal > 12 && depth >= 5 ? 2 : 1;
        score = -this.ab(depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
        if (r && score > alpha) score = -this.ab(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && score < beta) score = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (this.stop) return 0;
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const h = mover * 128 + moveTo(m);
              this.history[h] += depth * depth;
              if (this.history[h] > 1 << 22) for (let j = 0; j < this.history.length; j++) this.history[j] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -(MATE - ply) : 0;

    let stored = best;
    if (stored > MATE_BOUND) stored += ply;
    else if (stored < -MATE_BOUND) stored -= ply;
    this.ttKey[idx] = pos.hi;
    this.ttMove[idx] = bestMove;
    this.ttScore[idx] = stored;
    this.ttDepth[idx] = depth > 127 ? 127 : depth;
    this.ttFlag[idx] = best >= beta ? LOWER : best > alpha0 ? EXACT : UPPER;
    return best;
  }

  hasPieces(side) {
    const b = this.pos.board;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) continue;
      const p = b[sq];
      if (p && p >> 3 === side && (p & 7) !== PAWN && (p & 7) !== KING) return true;
    }
    return false;
  }

  // Exact scores for every root move at a fixed depth (used for variety).
  scoreRoot(pos, depth) {
    this.pos = pos;
    this.stop = false;
    this.deadline = Infinity;
    return pos.legalMoves().map((move) => {
      pos.make(move);
      const score = -this.ab(depth - 1, -INF, INF, 1, true);
      pos.unmake();
      return { move, score };
    }).sort((a, b) => b.score - a.score);
  }

  // Best move within a time and depth budget.
  search(pos, { timeMs = 1000, maxDepth = 40 } = {}) {
    this.pos = pos;
    this.stop = false;
    this.nodes = 0;
    this.killers.fill(0);
    const start = performance.now();
    this.deadline = start + timeMs;
    const moves = pos.legalMoves();
    if (!moves.length) return { move: 0, score: 0, depth: 0, nodes: 0 };
    let bestMove = moves[0];
    let bestScore = 0;
    let reached = 0;
    for (let depth = 1; depth <= maxDepth && moves.length > 1; depth++) {
      let alpha = -INF;
      let iterBest = 0;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        pos.make(m);
        let score;
        if (i === 0) score = -this.ab(depth - 1, -INF, -alpha, 1, true);
        else {
          score = -this.ab(depth - 1, -alpha - 1, -alpha, 1, true);
          if (score > alpha && !this.stop) score = -this.ab(depth - 1, -INF, -alpha, 1, true);
        }
        pos.unmake();
        if (this.stop) break;
        if (score > alpha) {
          alpha = score;
          iterBest = m;
        }
      }
      if (iterBest) {
        bestMove = iterBest;
        bestScore = alpha;
        // Search the best move first next time round.
        moves.splice(moves.indexOf(iterBest), 1);
        moves.unshift(iterBest);
      }
      if (this.stop) break;
      reached = depth;
      if (Math.abs(bestScore) > MATE_BOUND) break;
      if (performance.now() - start > timeMs * 0.55) break;
    }
    return { move: bestMove, score: bestScore, depth: reached, nodes: this.nodes };
  }
}

export const LEVELS = [
  { name: 'Intern', blurb: 'Ticks boxes at random. Forgiving.', timeMs: 0, depth: 2, margin: 140 },
  { name: 'Clerk', blurb: 'Reads the form before signing.', timeMs: 250, depth: 4, margin: 0 },
  { name: 'Auditor', blurb: 'Finds what you hoped was hidden.', timeMs: 900, depth: 40, margin: 0 },
  { name: 'Commissioner', blurb: 'Signs off on your defeat.', timeMs: 2500, depth: 40, margin: 0 },
];

// Picks a move for the given level (0-3). `rand` is injectable for tests.
export function chooseMove(engine, pos, level, rand = Math.random) {
  const cfg = LEVELS[level] || LEVELS[2];
  const pickNear = (depth, margin) => {
    const scored = engine.scoreRoot(pos, depth);
    if (!scored.length) return { move: 0, score: 0, depth: 0 };
    // Never dither over a forced win.
    const slack = scored[0].score > MATE_BOUND ? 0 : margin;
    const pool = scored.filter((s) => s.score >= scored[0].score - slack);
    return { ...pool[Math.floor(rand() * pool.length)], depth };
  };
  if (cfg.margin) return pickNear(cfg.depth, cfg.margin);
  // A little variety in the first few moves so games do not repeat.
  if (pos.hp < 6) return pickNear(Math.min(cfg.depth, 4), 18);
  return engine.search(pos, { timeMs: cfg.timeMs, maxDepth: cfg.depth });
}

export { MATE, MATE_BOUND, BLACK };
