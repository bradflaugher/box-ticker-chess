// Peer-to-peer play over WebRTC. The two browsers talk directly; PeerJS's
// free public broker is only used for the initial handshake (finding each
// other), so there is no game server to run.

const PREFIX = 'box-ticker-chess-';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/peerjs.min.js', import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the networking library.'));
    document.head.append(s);
  });
}

export function randomCode(n = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// Events: 'open' (connected to the other player), 'message' (detail = object),
// 'close' (other player dropped), 'error' (detail = human-readable string).
export class Link extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.code = '';
  }

  get connected() {
    return Boolean(this.conn && this.conn.open);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async host(code = randomCode()) {
    await loadPeerJs();
    this.isHost = true;
    this.code = code;
    this.peer = new window.Peer(PREFIX + this.code);
    this.watchPeer();
    this.peer.on('connection', (conn) => {
      // A newer connection replaces the old one (e.g. the guest reloaded).
      if (this.conn && this.conn !== conn) this.conn.close();
      this.adopt(conn);
    });
    await new Promise((resolve, reject) => {
      this.peer.once('open', resolve);
      this.peer.once('error', reject);
    });
    return this.code;
  }

  async join(code) {
    await loadPeerJs();
    this.isHost = false;
    this.code = code;
    this.peer = new window.Peer();
    this.watchPeer();
    await new Promise((resolve, reject) => {
      this.peer.once('open', resolve);
      this.peer.once('error', reject);
    });
    this.adopt(this.peer.connect(PREFIX + code, { reliable: true }));
  }

  watchPeer() {
    this.peer.on('error', (err) => {
      const text = err.type === 'peer-unavailable'
        ? 'That invite is no longer open. Ask your friend for a fresh link.'
        : err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'
          ? 'Could not reach the matchmaking service. Check your connection.'
          : `Connection problem (${err.type || 'unknown'}).`;
      this.emit('error', text);
    });
    this.peer.on('disconnected', () => {
      // Lost the broker, not necessarily the other player; try to get it back.
      if (this.peer && !this.peer.destroyed) this.peer.reconnect();
    });
  }

  adopt(conn) {
    this.conn = conn;
    conn.on('open', () => this.emit('open'));
    conn.on('data', (data) => {
      if (data && typeof data === 'object' && typeof data.t === 'string') this.emit('message', data);
    });
    conn.on('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        this.emit('close');
      }
    });
  }

  send(message) {
    if (this.connected) this.conn.send(message);
  }

  destroy() {
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.conn = null;
  }
}
