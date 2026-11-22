import {
  Position, WHITE, BLACK, QUEEN, ROOK, BISHOP, KNIGHT, CHECKS_TO_WIN,
  VARIANT_THREE_CHECK, VARIANT_KOTH, isHillSquare, hillDistance,
  moveFrom, moveTo, movePromo, moveToUci,
} from './engine.js';
import { LEVELS } from './ai.js';
import { Link } from './net.js';
import { Sound } from './sound.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PIECE_NAMES = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
const PIECE_VALUE = [0, 1, 3, 3, 5, 9, 0];
const SIDE = ['White', 'Black'];
const SAVE_KEY = 'box-ticker-chess.game';
const SOUND_KEY = 'box-ticker-chess.sound';
const MAX_REJOINS = 12;

const game = {
  pos: new Position(),
  variant: VARIANT_THREE_CHECK, // 'three-check' | 'koth'
  moves: [], // UCI strings
  sans: [],
  mode: 'ai', // 'ai' | 'local' | 'online'
  me: WHITE, // the side on this device (ai / online)
  level: 1,
  flipped: false,
  over: null, // { winner, reason }
  selected: -1,
  targets: [],
  thinking: false,
  reviewing: false, // result stamp dismissed
};

const sound = new Sound();
const dom = {
  board: $('board'), squares: $('squares'), pieces: $('pieces'), promo: $('promo'),
  stamp: $('stamp'), status: $('status'), moves: $('moves'), toast: $('toast'),
};

// --- Persistence -----------------------------------------------------------

const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or full storage: the game still works, it just won't resume.
    }
  },
};

function save() {
  // A guest's online game cannot be resumed from storage (the host holds it),
  // so it never replaces whatever game was saved before.
  if (game.mode === 'online' && !net.hostCode) return;
  storage.set(SAVE_KEY, {
    variant: game.variant, mode: game.mode, me: game.me, level: game.level, flipped: game.flipped, moves: game.moves,
    resigned: game.over && game.over.reason === 'resign' ? game.over.winner : null,
    host: game.mode === 'online' ? net.hostCode : null,
  });
}

// --- Board geometry --------------------------------------------------------

const xy = (sq) => {
  const f = sq & 7;
  const r = sq >> 4;
  return game.flipped ? [7 - f, r] : [f, 7 - r];
};

function squareAt(clientX, clientY) {
  const box = dom.board.getBoundingClientRect();
  const x = Math.floor(((clientX - box.left) / box.width) * 8);
  const y = Math.floor(((clientY - box.top) / box.height) * 8);
  if (x < 0 || x > 7 || y < 0 || y > 7) return -1;
  return game.flipped ? y * 16 + (7 - x) : (7 - y) * 16 + x;
}

const squareEls = new Map();

function buildSquares() {
  dom.squares.textContent = '';
  squareEls.clear();
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sq = game.flipped ? y * 16 + (7 - x) : (7 - y) * 16 + x;
      const node = el('div', `sq ${((sq & 7) + (sq >> 4)) % 2 ? 'light' : 'dark'}${isHillSquare(sq) ? ' hill' : ''}`);
      if (x === 0) node.append(el('i', 'rank', String((sq >> 4) + 1)));
      if (y === 7) node.append(el('i', 'file', 'abcdefgh'[sq & 7]));
      squareEls.set(sq, node);
      dom.squares.append(node);
    }
  }
}

// --- Pieces ----------------------------------------------------------------

const pieceEls = new Map(); // square -> element

const pieceClass = (p) => (p >> 3 ? 'b' : 'w') + PIECE_NAMES[p & 7];

function place(node, sq) {
  const [x, y] = xy(sq);
  node.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
}

// Reconciles the piece elements with the position, reusing elements so that
// moves (including castling and undo) glide instead of popping.
function syncPieces(animate) {
  dom.pieces.classList.toggle('instant', !animate);
  const want = new Map();
  for (let sq = 0; sq < 120; sq++) {
    if (!(sq & 0x88) && game.pos.board[sq]) want.set(sq, game.pos.board[sq]);
  }
  const free = [];
  for (const [sq, node] of [...pieceEls]) {
    if (want.get(sq) === node.piece) {
      want.delete(sq);
      place(node, sq);
    } else {
      pieceEls.delete(sq);
      free.push({ sq, node });
    }
  }
  for (const [sq, p] of want) {
    let best = -1;
    let bestDist = Infinity;
    free.forEach((f, i) => {
      if (f.node.piece !== p) return;
      const d = Math.abs((f.sq & 7) - (sq & 7)) + Math.abs((f.sq >> 4) - (sq >> 4));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    let node;
    if (best >= 0) node = free.splice(best, 1)[0].node;
    else {
      node = el('div', `piece ${pieceClass(p)}`);
      node.piece = p;
      dom.pieces.append(node);
    }
    node.classList.remove('drag');
    place(node, sq);
    pieceEls.set(sq, node);
  }
  for (const { node } of free) {
    if (animate) {
      node.classList.add('gone');
      setTimeout(() => node.remove(), 220);
    } else node.remove();
  }
  if (!animate) {
    void dom.pieces.offsetWidth; // flush so the next change animates again
    dom.pieces.classList.remove('instant');
  }
}

// --- Rendering -------------------------------------------------------------

function names() {
  if (game.mode === 'local') return ['White', 'Black'];
  const out = [];
  out[game.me] = 'You';
  out[game.me ^ 1] = game.mode === 'ai' ? LEVELS[game.level].name : 'Your friend';
  return out;
}

function captured(side) {
  // Pieces `side` has actually taken (read from the move history, so that
  // promotions are not mistaken for captures), plus the material lead.
  const { pos } = game;
  const material = [0, 0];
  for (let sq = 0; sq < 120; sq++) {
    const p = pos.board[sq];
    if (!(sq & 0x88) && p) material[p >> 3] += PIECE_VALUE[p & 7];
  }
  const taken = [];
  for (let i = 0; i < pos.hp; i++) {
    const p = pos.hCaptured[i];
    if (p && p >> 3 !== side) taken.push(p);
  }
  taken.sort((a, b) => PIECE_VALUE[b & 7] - PIECE_VALUE[a & 7] || (b & 7) - (a & 7));
  return { taken, lead: material[side] - material[side ^ 1] };
}

function renderCard(node, side) {
  const who = names()[side];
  const isKoth = game.variant === VARIANT_KOTH;
  const ticks = isKoth ? (isHillSquare(game.pos.king[side]) ? 1 : 0) : Math.min(game.pos.checks[side], CHECKS_TO_WIN);
  const key = `${side}|${who}|${game.mode}|${game.variant}`;
  if (node.dataset.key !== key) {
    node.dataset.key = key;
    node.textContent = '';
    const id = el('div', 'who');
    id.append(el('span', `swatch ${side ? 'black' : 'white'}`), el('b', 'name', who));
    const sub = game.mode === 'local' ? '' : `${game.mode === 'ai' && side !== game.me ? 'Computer · ' : ''}${SIDE[side]}`;
    id.append(el('span', 'sub', sub), el('span', 'dots'));
    const ticksRow = el('div', 'ticks');
    ticksRow.append(el('span', 'ticks-label', isKoth ? 'Hill' : 'Checks'));
    const boxCount = isKoth ? 1 : CHECKS_TO_WIN;
    for (let i = 0; i < boxCount; i++) {
      const box = el('span', 'box');
      box.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 6.5L20.5 3.5"/></svg>';
      ticksRow.append(box);
    }
    node.append(id, ticksRow, el('div', 'captured'));
  }
  node.classList.toggle('to-move', !game.over && game.pos.turn === side);
  node.classList.toggle('thinking', game.thinking && game.pos.turn === side);
  const row = node.querySelector('.ticks');
  if (isKoth) {
    const dist = hillDistance(game.pos.king[side]);
    row.querySelector('.ticks-label').textContent = dist === 0 ? 'Summit' : `${dist} away`;
    row.setAttribute('aria-label', dist === 0 ? `${who}: king reached the center` : `${who}: king ${dist} ${dist === 1 ? 'step' : 'steps'} from center`);
  } else {
    row.setAttribute('aria-label', `${who}: ${ticks} of ${CHECKS_TO_WIN} checks given`);
  }
  row.querySelectorAll('.box').forEach((box, i) => box.classList.toggle('ticked', i < ticks));
  const cap = node.querySelector('.captured');
  const { taken, lead } = captured(side);
  cap.textContent = '';
  for (const p of taken) cap.append(el('i', `mini ${pieceClass(p)}`));
  if (lead > 0) cap.append(el('span', 'lead', `+${lead}`));
}

function renderMoves() {
  dom.moves.textContent = '';
  for (let i = 0; i < game.sans.length; i += 2) {
    const row = el('li');
    row.append(el('span', 'num', `${i / 2 + 1}.`));
    for (const j of [i, i + 1]) {
      if (j >= game.sans.length) break;
      const san = game.sans[j];
      const cell = el('span', 'san', san);
      if (/[+#]$/.test(san)) cell.classList.add('check');
      if (j === game.sans.length - 1) cell.classList.add('latest');
      row.append(cell);
    }
    dom.moves.append(row);
  }
  if (!game.sans.length) dom.moves.append(el('li', 'empty', 'No moves yet. White to begin.'));
  dom.moves.scrollTop = dom.moves.scrollHeight;
}

const REASONS = {
  'three-checks': ['Three checks', 'All three boxes ticked.'],
  hill: ['King of the Hill', 'The center square was claimed.'],
  checkmate: ['Checkmate', 'No way out for the king.'],
  stalemate: ['Stalemate', 'No legal moves — a draw.'],
  repetition: ['Draw', 'The same position, three times.'],
  'fifty-move': ['Draw', 'Fifty moves without progress.'],
  material: ['Draw', 'Only the kings are left.'],
  resign: ['Resigned', 'The paperwork was conceded.'],
};

function winnerText() {
  const { winner } = game.over;
  if (winner === null) return 'Nobody wins';
  if (game.mode === 'local') return `${SIDE[winner]} wins`;
  return winner === game.me ? 'You win' : `${names()[winner]} wins`;
}

function statusText() {
  if (game.over) return `${winnerText()} — ${REASONS[game.over.reason][0].toLowerCase()}.`;
  if (game.mode === 'online' && !net.link) return 'This online game has closed. Start a new one.';
  if (game.mode === 'online' && !net.connected) return 'Waiting for your friend to connect…';
  const side = game.pos.turn;
  const giver = side ^ 1;
  let text = '';
  if (game.pos.inCheck) {
    text = game.variant === VARIANT_KOTH
      ? 'Check! '
      : `Check! Box ${game.pos.checks[giver]} of ${CHECKS_TO_WIN} ticked. `;
  }
  if (game.mode === 'local') return `${text}${SIDE[side]} to move.`;
  if (side === game.me) return `${text}Your move.`;
  return `${text}${names()[side]} is ${game.mode === 'ai' ? 'thinking' : 'on the move'}…`;
}

function render() {
  for (const [sq, node] of squareEls) {
    node.classList.remove('last', 'sel', 'check', 'dot', 'ring');
    if (sq === game.selected) node.classList.add('sel');
  }
  if (game.moves.length) {
    const last = game.moves[game.moves.length - 1];
    for (const name of [last.slice(0, 2), last.slice(2, 4)]) {
      squareEls.get((name.charCodeAt(0) - 97) + ((name.charCodeAt(1) - 49) << 4)).classList.add('last');
    }
  }
  if (game.pos.inCheck) squareEls.get(game.pos.king[game.pos.turn]).classList.add('check');
  for (const m of game.targets) {
    squareEls.get(moveTo(m)).classList.add(game.pos.isCapture(m) ? 'ring' : 'dot');
  }

  const isKoth = game.variant === VARIANT_KOTH;
  dom.board.classList.toggle('koth', isKoth);
  $('form-code').textContent = isKoth ? 'K-H' : '3-C';
  $('subtitle').innerHTML = isKoth
    ? 'Ordinary chess, one extra clause: the first player to <em>reach a center square with their king</em> wins.'
    : 'Ordinary chess, one extra clause: the first player to <em>tick three checks</em> wins.';

  const bottom = game.flipped ? BLACK : WHITE;
  renderCard($('card-bottom'), bottom);
  renderCard($('card-top'), bottom ^ 1);
  renderMoves();
  dom.status.textContent = statusText();
  dom.status.classList.toggle('alert', !game.over && game.pos.inCheck);

  $('btn-undo').disabled = game.mode === 'online' || !game.moves.length
    || (game.mode === 'ai' && game.moves.length < 2 && game.me === BLACK && !game.over);
  $('btn-resign').hidden = game.mode === 'local';
  $('btn-resign').disabled = !canResign();
  $('btn-share').textContent = game.mode === 'online' ? 'Copy invite' : 'Copy link';
  $('btn-result').hidden = !(game.over && game.reviewing);

  const showStamp = Boolean(game.over) && !game.reviewing;
  if (showStamp && dom.stamp.hidden) {
    const [title, detail] = REASONS[game.over.reason];
    $('stamp-title').textContent = title;
    $('stamp-sub').textContent = `${winnerText()}. ${detail}`;
    $('stamp-mark').classList.toggle('draw', game.over.winner === null);
    $('btn-again').textContent = game.mode === 'online' ? 'Rematch' : 'Play again';
  }
  dom.stamp.hidden = !showStamp;
  dom.board.classList.toggle('locked', !canMove());
}

let toastTimer = 0;
function toast(text, ms = 3200) {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, ms);
}

// --- Playing moves ---------------------------------------------------------

function canMove() {
  if (game.over || !dom.promo.hidden) return false;
  if (game.mode === 'local') return true;
  if (game.mode === 'online' && !net.connected) return false;
  return game.pos.turn === game.me;
}

function clearSelection() {
  game.selected = -1;
  game.targets = [];
}

function finishIfOver() {
  const res = game.pos.result();
  if (res) endGame(res);
}

function endGame(result) {
  game.over = result;
  game.thinking = false;
  game.reviewing = false;
  if (result.winner === null) sound.play('draw');
  else if (game.mode !== 'local' && result.winner !== game.me) sound.play('lose');
  else sound.play('win');
}

function play(move, { remote = false } = {}) {
  const { pos } = game;
  const capture = pos.isCapture(move);
  const san = pos.san(move);
  const uci = moveToUci(move);
  pos.make(move);
  game.moves.push(uci);
  game.sans.push(san);
  clearSelection();
  syncPieces(true);
  if (pos.inCheck) {
    sound.play('check');
    if (game.variant === VARIANT_THREE_CHECK) tickFlash(pos.turn ^ 1);
  } else sound.play(capture ? 'capture' : 'move');
  finishIfOver();
  if (game.over && game.over.reason === 'hill') tickFlash(game.over.winner);
  if (game.mode === 'online' && !remote) net.send({ t: 'move', uci, n: game.moves.length - 1 });
  render();
  save();
  maybeThink();
}

function tickFlash(side) {
  const card = (game.flipped ? BLACK : WHITE) === side ? $('card-bottom') : $('card-top');
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

function tryMove(from, to) {
  const options = game.targets.filter((m) => moveTo(m) === to && moveFrom(m) === from);
  if (!options.length) return false;
  if (options.length === 1) play(options[0]);
  else askPromotion(options);
  return true;
}

function askPromotion(options) {
  const side = game.pos.turn;
  const [x, y] = xy(moveTo(options[0]));
  dom.promo.textContent = '';
  const tray = el('div', 'promo-tray');
  tray.style.left = `${x * 12.5}%`;
  tray.classList.toggle('from-bottom', y === 7);
  for (const type of [QUEEN, KNIGHT, ROOK, BISHOP]) {
    const btn = el('button', `piece-btn ${pieceClass(type | (side << 3))}`);
    btn.type = 'button';
    btn.setAttribute('aria-label', `Promote to ${['', '', 'knight', 'bishop', 'rook', 'queen'][type]}`);
    btn.addEventListener('click', () => {
      dom.promo.hidden = true;
      play(options.find((m) => movePromo(m) === type));
    });
    tray.append(btn);
  }
  dom.promo.append(tray);
  dom.promo.hidden = false;
  render();
}

dom.promo.addEventListener('click', (e) => {
  if (e.target === dom.promo) {
    dom.promo.hidden = true;
    clearSelection();
    syncPieces(true);
    render();
  }
});

function select(sq) {
  game.selected = sq;
  game.targets = game.pos.legalMoves().filter((m) => moveFrom(m) === sq);
}

// Pointer handling: click-click and drag-and-drop share one code path.
let drag = null;

dom.board.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || !canMove() || e.target.closest('.stamp-layer, .promo')) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (sq < 0) return;
  const p = game.pos.board[sq];
  const own = p && p >> 3 === game.pos.turn;
  if (game.selected >= 0 && sq !== game.selected && tryMove(game.selected, sq)) return;
  if (!own) {
    clearSelection();
    render();
    return;
  }
  const again = game.selected === sq;
  select(sq);
  drag = { sq, node: pieceEls.get(sq), x: e.clientX, y: e.clientY, moved: false, again };
  dom.board.setPointerCapture(e.pointerId);
  e.preventDefault();
  render();
});

dom.board.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
  drag.moved = true;
  const box = dom.board.getBoundingClientRect();
  const size = box.width / 8;
  drag.node.classList.add('drag');
  drag.node.style.transform = `translate(${e.clientX - box.left - size / 2}px, ${e.clientY - box.top - size / 2}px) scale(1.12)`;
});

function endDrag(e, cancelled) {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.node.classList.remove('drag');
  if (d.moved) {
    const to = cancelled ? -1 : squareAt(e.clientX, e.clientY);
    if (to >= 0 && to !== d.sq && tryMove(d.sq, to)) return;
    place(d.node, d.sq);
  } else if (d.again) clearSelection();
  render();
}
dom.board.addEventListener('pointerup', (e) => endDrag(e, false));
dom.board.addEventListener('pointercancel', (e) => endDrag(e, true));

// --- Computer opponent (runs in a Web Worker, on this device) --------------

let worker = null;
let searchId = 0;
let thinkStarted = 0;

function maybeThink() {
  if (game.mode !== 'ai' || game.over || game.pos.turn === game.me) return;
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onBestMove;
    worker.onerror = () => {
      // Drop the broken worker so the next attempt builds a fresh one.
      worker.terminate();
      worker = null;
      searchId++;
      game.thinking = false;
      toast('The computer opponent failed to start in this browser.');
      render();
    };
  }
  game.thinking = true;
  const id = ++searchId;
  thinkStarted = performance.now();
  worker.postMessage({ id, variant: game.variant, moves: game.moves, level: game.level });
  render();
}

function onBestMove({ data }) {
  if (data.id !== searchId || !data.uci) return;
  // A beat of "thought" so instant replies don't feel jarring.
  const wait = Math.max(0, 450 - (performance.now() - thinkStarted));
  setTimeout(() => {
    if (data.id !== searchId || game.mode !== 'ai' || game.over || game.pos.turn === game.me) return;
    const move = game.pos.fromUci(data.uci);
    game.thinking = false;
    if (move) play(move);
  }, wait);
}

// --- Game lifecycle --------------------------------------------------------

function loadMoves(list, variant = game.variant) {
  game.pos = new Position(undefined, variant);
  game.moves = [];
  game.sans = [];
  for (const uci of list) {
    if (game.pos.result()) break;
    const move = game.pos.fromUci(uci);
    if (!move) break;
    game.sans.push(game.pos.san(move));
    game.pos.make(move);
    game.moves.push(uci);
  }
}

function startGame({ variant = game.variant, mode, me = WHITE, level = game.level, moves = [], flipped, resigned = null }) {
  searchId++;
  game.variant = variant === VARIANT_KOTH ? VARIANT_KOTH : VARIANT_THREE_CHECK;
  game.mode = mode;
  game.me = me;
  game.level = level;
  game.thinking = false;
  game.reviewing = false;
  game.over = null;
  dom.promo.hidden = true;
  clearSelection();
  loadMoves(moves, game.variant);
  game.over = game.pos.result();
  if (!game.over && resigned !== null) game.over = { winner: resigned, reason: 'resign' };
  const wantFlip = flipped ?? (mode !== 'local' && me === BLACK);
  if (wantFlip !== game.flipped || !squareEls.size) {
    game.flipped = wantFlip;
    buildSquares();
  }
  dom.stamp.hidden = true;
  syncPieces(false);
  render();
  save();
  maybeThink();
}

function undo() {
  if (game.mode === 'online' || !game.moves.length) return;
  if (game.mode === 'ai' && game.moves.length < 2 && game.me === BLACK && !game.over) return;
  searchId++;
  game.thinking = false;
  let n = 1;
  // Against the computer, step back to your own turn.
  if (game.mode === 'ai' && game.pos.turn === game.me && !game.over) n = 2;
  if (game.mode === 'ai' && game.over && game.pos.turn === game.me) n = 2;
  n = Math.min(n, game.moves.length);
  for (let i = 0; i < n; i++) {
    game.pos.unmake();
    game.moves.pop();
    game.sans.pop();
  }
  game.over = null;
  game.reviewing = false;
  dom.promo.hidden = true;
  clearSelection();
  syncPieces(true);
  render();
  save();
  maybeThink();
}

// A guest's resignation has to reach the host, who keeps the official record,
// so a guest can only resign while connected.
function canResign() {
  if (game.over || game.mode === 'local' || !game.moves.length) return false;
  return game.mode !== 'online' || net.connected || Boolean(net.link && net.link.isHost);
}

function resign() {
  if (!canResign()) return;
  searchId++;
  endGame({ winner: game.me ^ 1, reason: 'resign' });
  if (game.mode === 'online') net.send({ t: 'resign' });
  render();
  save();
}

// --- Online play -----------------------------------------------------------

const net = {
  link: null, // the connection the current online game runs on
  invite: null, // a new invite nobody has joined yet; the current game carries on
  joined: false, // this guest has been connected to the host at least once
  retryTimer: 0,
  hostCode: null, // invite code we host under; kept until the game is abandoned
  wantRematch: false,
  theyWantRematch: false,
  retries: 0,
  get connected() {
    return Boolean(this.link && this.link.connected);
  },
  send(message) {
    if (this.link) this.link.send(message);
  },
  inviteUrl(link = this.link) {
    return `${location.origin}${location.pathname}#j=${link.code}`;
  },
  resetSession() {
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.retries = 0;
    this.joined = false;
    this.wantRematch = false;
    this.theyWantRematch = false;
  },
  withdrawInvite() {
    if (this.invite) this.invite.destroy();
    this.invite = null;
  },
  close() {
    this.withdrawInvite();
    if (this.link) this.link.destroy();
    this.link = null;
    this.hostCode = null;
    this.resetSession();
  },
  sendState() {
    this.send({
      t: 'start', variant: game.variant, you: game.me ^ 1, moves: game.moves,
      resigned: game.over && game.over.reason === 'resign' ? game.over.winner : null,
    });
  },

  // Every handler first checks that its link is still the one in use, so a
  // replaced or withdrawn connection can never affect the game.
  wire(link) {
    link.addEventListener('open', () => {
      if (link === this.invite) this.acceptInvite(link);
      else if (link !== this.link) {
        link.destroy();
        return;
      }
      this.retries = 0;
      this.joined = true;
      if (link.isHost) {
        this.sendState();
        toast('Your friend is here. Good luck!');
      }
      render();
    });
    link.addEventListener('message', (e) => {
      if (this.link === link) this.receive(e.detail);
    });
    link.addEventListener('close', () => {
      if (this.link !== link) return;
      toast(link.isHost ? 'Your friend dropped off. The invite link still works.' : 'Connection lost. Trying to rejoin…', 5000);
      render();
      if (!link.isHost) this.rejoin(link.code);
    });
    link.addEventListener('error', (e) => {
      if (this.invite === link) {
        $('invite-status').textContent = e.detail;
        return;
      }
      if (this.link !== link) return;
      if (!link.isHost && !link.connected) {
        // The host may simply not be there yet (or be reloading): keep trying
        // for a while before giving up, on the first attempt as on later ones.
        if (this.retries < MAX_REJOINS) {
          if (!this.joined) toast('No answer from your friend yet. Still trying…', 5000);
          this.rejoin(link.code);
          return;
        }
        if (!this.joined) {
          this.giveUpJoining(e.detail);
          return;
        }
      }
      toast(e.detail, 6000);
    });
  },

  // A friend opened the pending invite: it now replaces the current game.
  acceptInvite(link) {
    const old = this.link;
    this.invite = null;
    this.link = link;
    if (old) old.destroy();
    this.resetSession();
    this.hostCode = link.code;
    clearJoinHash();
    startGame({ variant: this.inviteVariant, mode: 'online', me: this.inviteSide });
    $('dlg-new').close();
  },

  rejoin(code) {
    if (this.retryTimer) return; // one attempt in flight at a time
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      if (this.link && this.link.code === code && !this.link.connected) this.join(code, true);
    }, 3000);
  },

  // The invite never answered: go back to whatever game was saved before.
  giveUpJoining(reason) {
    this.close();
    history.replaceState(null, '', location.pathname);
    resume();
    toast(reason, 7000);
  },

  // Opens a fresh invite alongside whatever game is in progress. Nothing is
  // replaced or saved until a friend actually joins (see acceptInvite).
  async createInvite(side, variant) {
    this.withdrawInvite();
    const link = new Link();
    this.wire(link);
    this.invite = link;
    this.inviteSide = side;
    this.inviteVariant = variant;
    await link.host();
    return link;
  },

  // Re-opens the invite of a saved game after the host reloads.
  async rehost(code) {
    this.close();
    const link = new Link();
    this.wire(link);
    this.link = link;
    this.hostCode = code;
    await link.host(code);
  },

  async join(code, quiet = false) {
    if (this.link) this.link.destroy();
    const link = new Link();
    this.wire(link);
    this.link = link;
    if (!quiet) toast('Joining your friend’s game…', 8000);
    try {
      await link.join(code);
    } catch {
      // Reported through the link's error event.
    }
  },

  receive(msg) {
    const isHost = this.link.isHost;
    if (msg.t === 'start' && !isHost) {
      if (msg.you !== WHITE && msg.you !== BLACK) return;
      this.wantRematch = false;
      this.theyWantRematch = false;
      const moves = Array.isArray(msg.moves) ? msg.moves.filter((m) => typeof m === 'string').slice(0, 2000) : [];
      const variant = msg.variant === VARIANT_KOTH ? VARIANT_KOTH : VARIANT_THREE_CHECK;
      startGame({ variant, mode: 'online', me: msg.you, moves, resigned: msg.resigned === WHITE || msg.resigned === BLACK ? msg.resigned : null });
      toast(`Connected. You play ${SIDE[msg.you]}.`);
    } else if (msg.t === 'move') {
      const move = msg.n === game.moves.length && game.pos.turn !== game.me && !game.over
        ? game.pos.fromUci(String(msg.uci)) : 0;
      if (move) play(move, { remote: true });
      else if (isHost) this.sendState();
      else this.send({ t: 'sync' });
    } else if (msg.t === 'sync' && isHost) this.sendState();
    else if (msg.t === 'resign' && !game.over) {
      endGame({ winner: game.me, reason: 'resign' });
      render();
      save();
    } else if (msg.t === 'rematch' && game.over) {
      // Offers only count for a finished game; a stale duplicate is ignored.
      this.theyWantRematch = true;
      if (!this.wantRematch) {
        // Bring the result (and its Rematch button) back if it was dismissed.
        game.reviewing = false;
        render();
        toast('Your friend wants a rematch.', 6000);
      }
      this.maybeRematch();
    }
  },

  askRematch() {
    if (this.wantRematch || !game.over) return;
    if (!this.connected) {
      toast('Your friend is not connected right now.');
      return;
    }
    this.wantRematch = true;
    this.send({ t: 'rematch' });
    if (!this.theyWantRematch) toast('Rematch offered. Waiting for your friend…', 5000);
    this.maybeRematch();
  },

  maybeRematch() {
    if (!this.wantRematch || !this.theyWantRematch || !this.link.isHost) return;
    this.wantRematch = false;
    this.theyWantRematch = false;
    startGame({ mode: 'online', me: game.me ^ 1 }); // swap colours
    this.sendState();
  },
};

// --- Controls --------------------------------------------------------------

// Once this tab's game is really replaced, a reload must not rejoin the
// invite it was opened with.
function clearJoinHash() {
  if (location.hash) history.replaceState(null, '', location.pathname);
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    window.prompt('Copy this link:', text);
  }
}

function openNewGame() {
  const form = $('form-new');
  form.elements.variant.value = game.variant;
  form.elements.mode.value = game.mode;
  form.elements.level.value = String(game.level);
  $('setup').hidden = false;
  $('invite').hidden = true;
  updateSetup();
  const dlg = $('dlg-new');
  dlg.showModal();
  dlg.scrollTop = 0;
}

function updateSetup() {
  const mode = $('form-new').elements.mode.value;
  $('fs-side').hidden = mode === 'local';
  $('fs-level').hidden = mode !== 'ai';
  $('btn-start').textContent = mode === 'online' ? 'Create invite link' : 'Start game';
}

LEVELS.forEach((level, i) => {
  const label = el('label');
  const input = el('input');
  input.type = 'radio';
  input.name = 'level';
  input.value = String(i);
  const body = el('span');
  body.append(el('b', '', level.name), el('small', '', level.blurb));
  label.append(input, body);
  $('levels').append(label);
});

$('form-new').addEventListener('change', updateSetup);
$('form-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.elements;
  const variant = form.variant.value === VARIANT_KOTH ? VARIANT_KOTH : VARIANT_THREE_CHECK;
  const mode = form.mode.value;
  const side = form.side.value === 'random' ? (Math.random() < 0.5 ? WHITE : BLACK) : form.side.value === 'black' ? BLACK : WHITE;
  if (mode !== 'online') {
    net.close();
    clearJoinHash();
    $('dlg-new').close();
    startGame({ variant, mode, me: side, level: Number(form.level.value) });
    return;
  }
  $('setup').hidden = true;
  $('invite').hidden = false;
  $('invite-url').value = 'Preparing your link…';
  $('invite-status').innerHTML = '<span class="pulse"></span> Setting up…';
  try {
    const link = await net.createInvite(side, variant);
    if (net.invite !== link) return; // abandoned while it was being set up
    $('invite-url').value = net.inviteUrl(link);
    $('invite-status').innerHTML = '<span class="pulse"></span> Waiting for your friend…';
  } catch {
    $('invite-url').value = '';
    $('invite-status').textContent = 'Could not create an invite. Check your connection and try again.';
  }
});

$('btn-copy-invite').addEventListener('click', () => {
  if (net.invite && net.invite.code) copy(net.inviteUrl(net.invite), 'Invite link copied.');
});
$('btn-cancel-invite').addEventListener('click', () => $('dlg-new').close());
$('dlg-new').addEventListener('close', () => {
  // Backing out of the invite screen (Cancel, Escape, the X or the backdrop)
  // withdraws the invite and leaves the game in progress exactly as it was.
  net.withdrawInvite();
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

$('btn-new').addEventListener('click', openNewGame);
$('btn-rules').addEventListener('click', () => $('dlg-rules').showModal());
$('btn-undo').addEventListener('click', undo);
$('btn-resign').addEventListener('click', resign);
$('btn-flip').addEventListener('click', () => {
  game.flipped = !game.flipped;
  buildSquares();
  syncPieces(false);
  render();
  save();
});
$('btn-share').addEventListener('click', () => {
  if (game.mode === 'online' && net.link) copy(net.inviteUrl(), 'Invite link copied.');
  else {
    const v = game.variant === VARIANT_KOTH ? `&v=${VARIANT_KOTH}` : '';
    copy(`${location.origin}${location.pathname}#g=${game.moves.join('.')}${v}`, 'Link to this position copied.');
  }
});
$('btn-sound').addEventListener('click', () => setSound(!sound.enabled));
$('btn-review').addEventListener('click', () => {
  game.reviewing = true;
  render();
});
$('btn-result').addEventListener('click', () => {
  game.reviewing = false;
  render();
});
$('btn-again').addEventListener('click', () => {
  if (game.mode === 'online') net.askRematch();
  else startGame({ mode: game.mode, me: game.mode === 'ai' ? game.me ^ 1 : game.me });
});

function setSound(on) {
  sound.enabled = on;
  $('btn-sound').textContent = on ? 'Sound on' : 'Sound off';
  $('btn-sound').setAttribute('aria-pressed', String(on));
  storage.set(SOUND_KEY, on);
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    if (!drag) {
      e.preventDefault();
      undo();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'f') $('btn-flip').click();
  else if (e.key === 'n') openNewGame();
});

// --- Boot ------------------------------------------------------------------

// Picks up the saved game, or offers a new one.
function resume() {
  const saved = storage.get(SAVE_KEY);
  const clean = (list) => (Array.isArray(list) ? list.filter((m) => typeof m === 'string') : []);
  const savedVariant = saved && saved.variant === VARIANT_KOTH ? VARIANT_KOTH : VARIANT_THREE_CHECK;
  if (saved && saved.mode === 'online' && saved.host) {
    // The host reloaded: reopen the same invite so the guest can find us again.
    net.hostCode = String(saved.host);
    startGame({
      variant: savedVariant, mode: 'online', me: saved.me === BLACK ? BLACK : WHITE, moves: clean(saved.moves),
      flipped: Boolean(saved.flipped), resigned: saved.resigned ?? null,
    });
    net.rehost(net.hostCode).catch(() => toast('Could not reopen the online game. Start a new one.', 6000));
    return;
  }
  if (saved && (saved.mode === 'ai' || saved.mode === 'local')) {
    startGame({
      variant: savedVariant, mode: saved.mode, me: saved.me === BLACK ? BLACK : WHITE,
      level: LEVELS[saved.level] ? saved.level : 1, moves: clean(saved.moves),
      flipped: Boolean(saved.flipped), resigned: saved.resigned ?? null,
    });
    return;
  }
  startGame({ variant: VARIANT_THREE_CHECK, mode: 'ai', me: WHITE, level: 1 });
  openNewGame();
}

function boot() {
  setSound(storage.get(SOUND_KEY) !== false);
  const hash = new URLSearchParams(location.hash.slice(1));

  if (hash.has('j')) {
    startGame({ mode: 'online', me: BLACK });
    net.join(hash.get('j').replace(/[^a-z0-9]/g, '').slice(0, 12));
    render();
    return;
  }
  if (hash.has('g')) {
    const variant = hash.get('v') === VARIANT_KOTH ? VARIANT_KOTH : VARIANT_THREE_CHECK;
    history.replaceState(null, '', location.pathname);
    startGame({ variant, mode: 'local', moves: hash.get('g').split('.').filter(Boolean).slice(0, 2000) });
    toast('Position loaded. Play on from here, pass-and-play.');
    return;
  }
  resume();
}

window.addEventListener('hashchange', () => {
  if (/^#[jg]=/.test(location.hash)) location.reload();
});

boot();
