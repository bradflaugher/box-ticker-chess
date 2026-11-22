// Box-Ticker Chess rules engine.
// Standard chess movement on a 0x88 board, plus the three-check rule:
// the first player to give check three times wins on the spot.

export const WHITE = 0;
export const BLACK = 1;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const CHECKS_TO_WIN = 3;
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const FLAG_EP = 1;
export const FLAG_CASTLE = 2;
export const FLAG_DOUBLE = 4;

const N_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
const K_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];
const B_OFF = [-17, -15, 15, 17];
const R_OFF = [-16, -1, 1, 16];

const PIECE_CHARS = '.PNBRQK..pnbrqk';
const MAX_HIST = 4096;

// Castling rights lost when a move touches a given square.
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[0x00] = 13;
CASTLE_MASK[0x07] = 14;
CASTLE_MASK[0x04] = 12;
CASTLE_MASK[0x70] = 7;
CASTLE_MASK[0x77] = 11;
CASTLE_MASK[0x74] = 3;

// --- Zobrist keys (two 32-bit halves, deterministic) -----------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) | 0;
  };
}
const rnd = mulberry32(0xb0c5);
const fill = (n) => Int32Array.from({ length: n }, rnd);
const ZP_LO = fill(16 * 128);
const ZP_HI = fill(16 * 128);
const ZC_LO = fill(16);
const ZC_HI = fill(16);
const ZE_LO = fill(128);
const ZE_HI = fill(128);
const ZK_LO = fill(32);
const ZK_HI = fill(32);
const ZT_LO = rnd();
const ZT_HI = rnd();

export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromo = (m) => (m >> 14) & 7;
export const moveFlag = (m) => m >> 17;

export const sqName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
export const sqFromName = (s) => (s.charCodeAt(0) - 97) + ((s.charCodeAt(1) - 49) << 4);

export function moveToUci(m) {
  const p = movePromo(m);
  return sqName(moveFrom(m)) + sqName(moveTo(m)) + (p ? 'pnbrqk'[p - 1] : '');
}

export class Position {
  constructor(fen = START_FEN) {
    this.board = new Int8Array(128);
    this.king = [0, 0];
    this.checks = [0, 0]; // checks delivered by [white, black]
    this.hMove = new Int32Array(MAX_HIST);
    this.hCaptured = new Int8Array(MAX_HIST);
    this.hCastle = new Int8Array(MAX_HIST);
    this.hEp = new Int16Array(MAX_HIST);
    this.hHalf = new Int16Array(MAX_HIST);
    this.hLo = new Int32Array(MAX_HIST);
    this.hHi = new Int32Array(MAX_HIST);
    this.hInCheck = new Int8Array(MAX_HIST);
    this.load(fen);
  }

  // FEN, with an optional trailing "+W+B" field holding checks delivered.
  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board.fill(0);
    let sq = 0x70;
    for (const ch of parts[0]) {
      if (ch === '/') sq = (sq & 0x70) - 16;
      else if (ch >= '1' && ch <= '8') sq += Number(ch);
      else {
        const p = PIECE_CHARS.indexOf(ch);
        if (p <= 0) throw new Error(`Bad FEN piece: ${ch}`);
        this.board[sq] = p;
        if ((p & 7) === KING) this.king[p >> 3] = sq;
        sq++;
      }
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    for (const ch of parts[2] || '-') {
      const i = 'KQkq'.indexOf(ch);
      if (i >= 0) this.castling |= 1 << i;
    }
    this.ep = parts[3] && parts[3] !== '-' ? sqFromName(parts[3]) : -1;
    this.halfmove = Number(parts[4] || 0);
    this.fullmove = Number(parts[5] || 1);
    const ck = /^\+(\d)\+(\d)$/.exec(parts[6] || '');
    this.checks = ck ? [Number(ck[1]), Number(ck[2])] : [0, 0];
    this.hp = 0;
    this.inCheck = this.attacked(this.king[this.turn], this.turn ^ 1);
    this.computeHash();
    return this;
  }

  fen() {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) empty++;
        else {
          if (empty) out += empty;
          empty = 0;
          out += PIECE_CHARS[p];
        }
      }
      if (empty) out += empty;
      if (r) out += '/';
    }
    let c = '';
    for (let i = 0; i < 4; i++) if (this.castling & (1 << i)) c += 'KQkq'[i];
    return [
      out, this.turn ? 'b' : 'w', c || '-', this.ep >= 0 ? sqName(this.ep) : '-',
      this.halfmove, this.fullmove, `+${this.checks[0]}+${this.checks[1]}`,
    ].join(' ');
  }

  computeHash() {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      const p = this.board[sq];
      if (p) {
        lo ^= ZP_LO[p * 128 + sq];
        hi ^= ZP_HI[p * 128 + sq];
      }
    }
    lo ^= ZC_LO[this.castling];
    hi ^= ZC_HI[this.castling];
    if (this.ep >= 0) {
      lo ^= ZE_LO[this.ep];
      hi ^= ZE_HI[this.ep];
    }
    if (this.turn) {
      lo ^= ZT_LO;
      hi ^= ZT_HI;
    }
    for (let c = 0; c < 2; c++) {
      lo ^= ZK_LO[c * 16 + (this.checks[c] & 15)];
      hi ^= ZK_HI[c * 16 + (this.checks[c] & 15)];
    }
    this.lo = lo;
    this.hi = hi;
  }

  attacked(sq, by) {
    const b = this.board;
    if (by === WHITE) {
      if ((!((sq - 15) & 0x88) && b[sq - 15] === 1) || (!((sq - 17) & 0x88) && b[sq - 17] === 1)) return true;
    } else if ((!((sq + 15) & 0x88) && b[sq + 15] === 9) || (!((sq + 17) & 0x88) && b[sq + 17] === 9)) {
      return true;
    }
    const side = by << 3;
    const knight = KNIGHT | side;
    const king = KING | side;
    for (let i = 0; i < 8; i++) {
      let t = sq + N_OFF[i];
      if (!(t & 0x88) && b[t] === knight) return true;
      t = sq + K_OFF[i];
      if (!(t & 0x88) && b[t] === king) return true;
    }
    const queen = QUEEN | side;
    const bishop = BISHOP | side;
    const rook = ROOK | side;
    for (let i = 0; i < 4; i++) {
      let o = B_OFF[i];
      let t = sq + o;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        t += o;
      }
      o = R_OFF[i];
      t = sq + o;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        t += o;
      }
    }
    return false;
  }

  // Pseudo-legal moves (legality is settled by make()).
  // With capturesOnly, yields captures and promotions.
  gen(list, capturesOnly = false) {
    const b = this.board;
    const us = this.turn;
    const dir = us === WHITE ? 16 : -16;
    const startRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 7 : 0;
    for (let from = 0; from < 120; from++) {
      if (from & 0x88) {
        from += 7;
        continue;
      }
      const p = b[from];
      if (!p || p >> 3 !== us) continue;
      const type = p & 7;
      if (type === PAWN) {
        let t = from + dir;
        if (!b[t]) {
          if (t >> 4 === promoRank) {
            const base = from | (t << 7);
            list.push(base | (QUEEN << 14));
            if (!capturesOnly) list.push(base | (KNIGHT << 14), base | (ROOK << 14), base | (BISHOP << 14));
          } else if (!capturesOnly) {
            list.push(from | (t << 7));
            if (from >> 4 === startRank && !b[t + dir]) list.push(from | ((t + dir) << 7) | (FLAG_DOUBLE << 17));
          }
        }
        for (let d = -1; d <= 1; d += 2) {
          t = from + dir + d;
          if (t & 0x88) continue;
          const target = b[t];
          if (target) {
            if (target >> 3 === us) continue;
            const base = from | (t << 7);
            if (t >> 4 === promoRank) {
              list.push(base | (QUEEN << 14), base | (KNIGHT << 14), base | (ROOK << 14), base | (BISHOP << 14));
            } else list.push(base);
          } else if (t === this.ep) list.push(from | (t << 7) | (FLAG_EP << 17));
        }
      } else if (type === KNIGHT || type === KING) {
        const offs = type === KNIGHT ? N_OFF : K_OFF;
        for (let i = 0; i < 8; i++) {
          const t = from + offs[i];
          if (t & 0x88) continue;
          const target = b[t];
          if (target ? target >> 3 !== us : !capturesOnly) list.push(from | (t << 7));
        }
      } else {
        const lo = type === ROOK ? 4 : 0;
        const hi = type === BISHOP ? 4 : 8;
        for (let i = lo; i < hi; i++) {
          const o = i < 4 ? B_OFF[i] : R_OFF[i - 4];
          let t = from + o;
          while (!(t & 0x88)) {
            const target = b[t];
            if (target) {
              if (target >> 3 !== us) list.push(from | (t << 7));
              break;
            }
            if (!capturesOnly) list.push(from | (t << 7));
            t += o;
          }
        }
      }
    }
    if (!capturesOnly && !this.inCheck) {
      const them = us ^ 1;
      const k = us === WHITE ? 0x04 : 0x74;
      const rights = this.castling >> (us * 2);
      if (rights & 1 && !b[k + 1] && !b[k + 2] && !this.attacked(k + 1, them)) {
        list.push(k | ((k + 2) << 7) | (FLAG_CASTLE << 17));
      }
      if (rights & 2 && !b[k - 1] && !b[k - 2] && !b[k - 3] && !this.attacked(k - 1, them)) {
        list.push(k | ((k - 2) << 7) | (FLAG_CASTLE << 17));
      }
    }
    return list;
  }

  // Plays a pseudo-legal move. Returns false (and leaves the position
  // untouched) if it would leave the mover's own king in check.
  make(m) {
    const b = this.board;
    const us = this.turn;
    const them = us ^ 1;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const promo = (m >> 14) & 7;
    const flag = m >> 17;
    const piece = b[from];
    let captured = b[to];
    const i = this.hp++;
    this.hMove[i] = m;
    this.hCastle[i] = this.castling;
    this.hEp[i] = this.ep;
    this.hHalf[i] = this.halfmove;
    this.hLo[i] = this.lo;
    this.hHi[i] = this.hi;
    this.hInCheck[i] = this.inCheck ? 1 : 0;

    let lo = this.lo ^ ZC_LO[this.castling] ^ ZT_LO;
    let hi = this.hi ^ ZC_HI[this.castling] ^ ZT_HI;
    if (this.ep >= 0) {
      lo ^= ZE_LO[this.ep];
      hi ^= ZE_HI[this.ep];
      this.ep = -1;
    }
    b[from] = 0;
    lo ^= ZP_LO[piece * 128 + from];
    hi ^= ZP_HI[piece * 128 + from];
    if (flag & FLAG_EP) {
      const csq = to + (us === WHITE ? -16 : 16);
      captured = b[csq];
      b[csq] = 0;
      lo ^= ZP_LO[captured * 128 + csq];
      hi ^= ZP_HI[captured * 128 + csq];
    } else if (captured) {
      lo ^= ZP_LO[captured * 128 + to];
      hi ^= ZP_HI[captured * 128 + to];
    }
    this.hCaptured[i] = captured;
    const placed = promo ? promo | (us << 3) : piece;
    b[to] = placed;
    lo ^= ZP_LO[placed * 128 + to];
    hi ^= ZP_HI[placed * 128 + to];
    const type = piece & 7;
    if (type === KING) {
      this.king[us] = to;
      if (flag & FLAG_CASTLE) {
        const rFrom = to > from ? to + 1 : to - 2;
        const rTo = to > from ? to - 1 : to + 1;
        const rook = b[rFrom];
        b[rFrom] = 0;
        b[rTo] = rook;
        lo ^= ZP_LO[rook * 128 + rFrom] ^ ZP_LO[rook * 128 + rTo];
        hi ^= ZP_HI[rook * 128 + rFrom] ^ ZP_HI[rook * 128 + rTo];
      }
    }
    if (flag & FLAG_DOUBLE) {
      const enemyPawn = PAWN | (them << 3);
      if ((!((to - 1) & 0x88) && b[to - 1] === enemyPawn) || (!((to + 1) & 0x88) && b[to + 1] === enemyPawn)) {
        this.ep = (from + to) >> 1;
        lo ^= ZE_LO[this.ep];
        hi ^= ZE_HI[this.ep];
      }
    }
    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    lo ^= ZC_LO[this.castling];
    hi ^= ZC_HI[this.castling];
    this.halfmove = type === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;

    if (this.attacked(this.king[us], them)) {
      this.restore();
      return false;
    }
    this.inCheck = this.attacked(this.king[them], us);
    if (this.inCheck) {
      const c = this.checks[us];
      lo ^= ZK_LO[us * 16 + (c & 15)] ^ ZK_LO[us * 16 + ((c + 1) & 15)];
      hi ^= ZK_HI[us * 16 + (c & 15)] ^ ZK_HI[us * 16 + ((c + 1) & 15)];
      this.checks[us] = c + 1;
    }
    this.lo = lo;
    this.hi = hi;
    return true;
  }

  unmake() {
    if (this.inCheck) this.checks[this.turn ^ 1]--;
    this.restore();
  }

  restore() {
    const b = this.board;
    const i = --this.hp;
    const m = this.hMove[i];
    const us = this.turn ^ 1;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const flag = m >> 17;
    const piece = (m >> 14) & 7 ? PAWN | (us << 3) : b[to];
    const captured = this.hCaptured[i];
    b[from] = piece;
    if (flag & FLAG_EP) {
      b[to] = 0;
      b[to + (us === WHITE ? -16 : 16)] = captured;
    } else b[to] = captured;
    if ((piece & 7) === KING) {
      this.king[us] = from;
      if (flag & FLAG_CASTLE) {
        const rFrom = to > from ? to + 1 : to - 2;
        const rTo = to > from ? to - 1 : to + 1;
        b[rFrom] = b[rTo];
        b[rTo] = 0;
      }
    }
    this.turn = us;
    this.castling = this.hCastle[i];
    this.ep = this.hEp[i];
    this.halfmove = this.hHalf[i];
    this.lo = this.hLo[i];
    this.hi = this.hHi[i];
    this.inCheck = this.hInCheck[i] === 1;
    if (us === BLACK) this.fullmove--;
  }

  // Null move, for search pruning only. Never call while in check.
  makeNull() {
    const i = this.hp++;
    this.hMove[i] = 0;
    this.hEp[i] = this.ep;
    this.hHalf[i] = this.halfmove;
    this.hLo[i] = this.lo;
    this.hHi[i] = this.hi;
    this.lo ^= ZT_LO;
    this.hi ^= ZT_HI;
    if (this.ep >= 0) {
      this.lo ^= ZE_LO[this.ep];
      this.hi ^= ZE_HI[this.ep];
      this.ep = -1;
    }
    this.halfmove = 0;
    this.turn ^= 1;
  }

  unmakeNull() {
    const i = --this.hp;
    this.ep = this.hEp[i];
    this.halfmove = this.hHalf[i];
    this.lo = this.hLo[i];
    this.hi = this.hHi[i];
    this.turn ^= 1;
  }

  // How many earlier positions in the game match the current one.
  repetitions() {
    let n = 0;
    const stop = Math.max(0, this.hp - this.halfmove);
    for (let i = this.hp - 2; i >= stop; i -= 2) {
      if (this.hLo[i] === this.lo && this.hHi[i] === this.hi) n++;
    }
    return n;
  }

  legalMoves() {
    const out = [];
    for (const m of this.gen([])) {
      if (this.make(m)) {
        this.unmake();
        out.push(m);
      }
    }
    return out;
  }

  fromUci(uci) {
    return this.legalMoves().find((m) => moveToUci(m) === uci) || 0;
  }

  isCapture(m) {
    return this.board[moveTo(m)] !== 0 || (moveFlag(m) & FLAG_EP) !== 0;
  }

  onlyKings() {
    for (let sq = 0; sq < 120; sq++) {
      if (!(sq & 0x88) && this.board[sq] && (this.board[sq] & 7) !== KING) return false;
    }
    return true;
  }

  // null while the game is on, otherwise { winner: WHITE|BLACK|null, reason }.
  result() {
    const mover = this.turn ^ 1;
    if (this.checks[mover] >= CHECKS_TO_WIN) return { winner: mover, reason: 'three-checks' };
    if (!this.legalMoves().length) {
      return this.inCheck ? { winner: mover, reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
    }
    if (this.onlyKings()) return { winner: null, reason: 'material' };
    if (this.halfmove >= 100) return { winner: null, reason: 'fifty-move' };
    if (this.repetitions() >= 2) return { winner: null, reason: 'repetition' };
    return null;
  }

  // Standard algebraic notation for a legal move in the current position.
  san(m) {
    const from = moveFrom(m);
    const to = moveTo(m);
    const type = this.board[from] & 7;
    let s;
    if (moveFlag(m) & FLAG_CASTLE) s = to > from ? 'O-O' : 'O-O-O';
    else {
      const capture = this.isCapture(m);
      if (type === PAWN) s = capture ? `${sqName(from)[0]}x` : '';
      else {
        s = '.PNBRQK'[type];
        const rivals = this.legalMoves().filter(
          (o) => moveTo(o) === to && moveFrom(o) !== from && (this.board[moveFrom(o)] & 7) === type,
        );
        if (rivals.length) {
          const name = sqName(from);
          if (!rivals.some((o) => (moveFrom(o) & 7) === (from & 7))) s += name[0];
          else if (!rivals.some((o) => moveFrom(o) >> 4 === from >> 4)) s += name[1];
          else s += name;
        }
        if (capture) s += 'x';
      }
      s += sqName(to);
      if (movePromo(m)) s += `=${'.PNBRQK'[movePromo(m)]}`;
    }
    this.make(m);
    const res = this.result();
    if (res && res.winner !== null) s += '#';
    else if (this.inCheck) s += '+';
    this.unmake();
    return s;
  }
}

export function perft(pos, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of pos.gen([])) {
    if (pos.make(m)) {
      n += perft(pos, depth - 1);
      pos.unmake();
    }
  }
  return n;
}
