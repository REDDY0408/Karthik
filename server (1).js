'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const R = require('./rules');

const CFG = { FIRST_DROP: 25, MIDDLE_DROP: 50, MAX_DEAL: 80, TOTAL_OUT: 101, MIN_P: 2, MAX_P: 6 };
const TABLES = 10;
const TURN_MS = 60 * 1000;
const DEAL_MS = process.env.DEAL_MS !== undefined ? +process.env.DEAL_MS : 5000; // time spent dealing cards (client animation)
const SEAT_MS = process.env.SEAT_MS !== undefined ? +process.env.SEAT_MS : 7000; // seat-draw cards shown to everyone
const NEXT_DEAL_MS = 20 * 1000;
const TIE_MS = process.env.TIE_MS !== undefined ? +process.env.TIE_MS : 20 * 1000; // time to answer the tie question
const MAX_SPECTATORS = 10;
const SUIT_RANK = { S: 4, H: 3, D: 2, C: 1 }; // only used to break ties in the seat draw
const IDLE_MS = 10 * 60 * 1000; // a table with nobody connected for this long is freed

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/t/:n', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// Lets Android open WhatsApp links straight in the installed app (App Links).
app.get('/.well-known/assetlinks.json', (req, res) => {
  const fps = (process.env.ANDROID_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: process.env.ANDROID_PACKAGE || 'com.friends.rummy',
        sha256_cert_fingerprints: fps,
      },
    },
  ]);
});

const rooms = new Map(); // table number -> room
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function newKey() {
  return Array.from({ length: 8 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('');
}

function listTables() {
  const out = [];
  for (let n = 1; n <= TABLES; n++) {
    const r = rooms.get(n);
    out.push(r ? { n, busy: true, players: r.players.length, phase: r.phase } : { n, busy: false, players: 0, phase: 'free' });
  }
  return out;
}
function pushTables() { io.emit('tables', listTables()); }

function createRoom(table, hostPid) {
  const room = {
    table, key: newKey(), host: hostPid, players: [], phase: 'lobby', stock: [], discard: [],
    wild: null, wildRank: 0, turn: 0, turnPhase: 'draw', turnEndsAt: 0, dealNo: 0, dealer: -1,
    log: [], result: null, gameWinner: null, winners: [], shared: false, tie: null, tieTimer: null, seatTimer: null, seatDraw: [], seatAt: 0, dealAt: 0,
    spectators: [], timer: null, nextTimer: null, nextAt: 0, emptySince: 0,
  };
  rooms.set(table, room);
  return room;
}

function freeTable(room, reason) {
  clearTimeout(room.timer);
  clearTimeout(room.nextTimer);
  clearTimeout(room.tieTimer);
  clearTimeout(room.seatTimer);
  if (rooms.get(room.table) !== room) return;
  rooms.delete(room.table);
  room.players.concat(room.spectators).forEach((p) => { if (p.sid) io.to(p.sid).emit('closed', reason || 'This table was closed.'); });
  pushTables();
}

const byId = (p) => Object.fromEntries(p.hand.map((c) => [c.id, c]));
const cur = (room) => room.players[room.turn];
const log = (room, msg) => { room.log.push(msg); if (room.log.length > 30) room.log.shift(); };

function view(room, me) {
  return {
    table: room.table, key: room.key, host: room.host, me: me.pid, phase: room.phase, cfg: CFG, dealNo: room.dealNo, dealMs: DEAL_MS, dealAge: room.dealAt ? Date.now() - room.dealAt : 1e9,
    wild: room.wild, wildRank: room.wildRank, turnMs: TURN_MS,
    spectator: !!me.spectator, specCount: room.spectators.length,
    dealer: room.dealer, dealerPid: room.dealer >= 0 && room.players[room.dealer] ? room.players[room.dealer].pid : null,
    seatDraw: room.phase === 'seating' ? room.seatDraw : [], seatAge: room.phase === 'seating' ? Date.now() - room.seatAt : 0, seatMs: SEAT_MS,
    winners: room.winners, shared: room.shared,
    tie: room.tie ? { pids: room.tie.pids, voted: Object.keys(room.tie.votes), endsAt: room.tie.endsAt, mine: room.tie.votes[me.pid] } : null,
    discard: room.discard.slice(-3), discardCount: room.discard.length, stockCount: room.stock.length,
    turnPid: room.phase === 'playing' && cur(room) ? cur(room).pid : null, turnPhase: room.turnPhase, turnEndsAt: room.turnEndsAt,
    players: room.players.map((q) => ({
      pid: q.pid, name: q.name, total: q.total, out: q.out, status: q.status,
      cards: q.hand.length, scores: q.scores, connected: !!q.sid,
    })),
    hand: me.hand, groups: me.groups,
    result: room.result, nextAt: room.nextAt, gameWinner: room.gameWinner,
    log: room.log.slice(-5),
  };
}

function broadcast(room) {
  room.players.concat(room.spectators).forEach((p) => { if (p.sid) io.to(p.sid).emit('state', view(room, p)); });
  room.emptySince = room.players.concat(room.spectators).some((p) => p.sid) ? 0 : room.emptySince || Date.now();
  pushTables();
}

function groupCards(p) {
  const m = byId(p);
  const seen = new Set();
  const groups = p.groups.map((g) => g.filter((id) => m[id] && !seen.has(id) && seen.add(id)).map((id) => m[id])).filter((g) => g.length);
  const rest = p.hand.filter((c) => !seen.has(c.id));
  if (rest.length) groups.push(rest);
  return groups;
}

function nextActive(room, from) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (room.players[i].status === 'active') return i;
  }
  return -1;
}

function setTurn(room, idx, extra = 0) {
  room.turn = idx;
  room.turnPhase = 'draw';
  room.turnEndsAt = Date.now() + extra + TURN_MS;
  clearTimeout(room.timer);
  const pid = room.players[idx].pid;
  const dealNo = room.dealNo;
  room.timer = setTimeout(() => autoPlay(room, pid, dealNo), extra + TURN_MS);
}

// ---- seat draw: every player gets one face-up card; the highest card is the dealer and seats follow the cards ----
function startSeating(room) {
  clearTimeout(room.nextTimer);
  clearTimeout(room.tieTimer);
  clearTimeout(room.timer);
  room.tie = null; room.result = null; room.winners = []; room.shared = false; room.gameWinner = null;
  room.dealNo = 0; room.dealer = -1; room.dealAt = 0; room.nextAt = 0;
  const deck = [];
  let id = 1000;
  for (const su of ['S', 'H', 'D', 'C']) for (let r = 1; r <= 13; r++) deck.push({ id: id++, r, s: su });
  R.shuffle(deck);
  room.seatDraw = room.players.map((p, i) => ({ pid: p.pid, card: deck[i] }));
  room.phase = 'seating';
  room.seatAt = Date.now();
  log(room, 'Seat draw');
  broadcast(room);
  clearTimeout(room.seatTimer);
  room.seatTimer = setTimeout(() => finishSeating(room), SEAT_MS);
}

function seatValue(c) { return (c.r === 1 ? 14 : c.r) * 10 + SUIT_RANK[c.s]; } // Ace is highest

function finishSeating(room) {
  if (room.phase !== 'seating') return;
  const order = room.seatDraw.slice().sort((a, b) => seatValue(b.card) - seatValue(a.card)).map((x) => x.pid);
  room.players.sort((a, b) => order.indexOf(a.pid) - order.indexOf(b.pid)); // highest card first = dealer
  room.dealer = -1;
  log(room, `${room.players[0].name} drew the highest card and is the dealer`);
  startDeal(room);
}

function startDeal(room) {
  clearTimeout(room.nextTimer);
  clearTimeout(room.tieTimer);
  room.tie = null;
  room.nextAt = 0;
  room.result = null;
  room.dealNo++;
  const deck = R.shuffle(R.makeDeck());
  room.players.forEach((p) => {
    if (p.out) { p.status = 'out'; p.hand = []; p.groups = []; return; }
    p.hand = deck.splice(0, 13);
    p.groups = [p.hand.map((c) => c.id)];
    p.status = 'active';
    p.turns = 0;
    p.dealScore = 0;
  });
  room.wild = deck.shift();
  room.wildRank = room.wild.s === 'J' ? 1 : room.wild.r; // if the cut card is a printed joker, Aces are wild
  room.discard = [deck.shift()];
  room.stock = deck;
  room.phase = 'playing';
  room.dealer = nextDealer(room);
  log(room, `Deal ${room.dealNo} started`);
  room.dealAt = Date.now();
  setTurn(room, nextActive(room, room.dealer), DEAL_MS);
  broadcast(room);
}

function nextDealer(room) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (room.dealer + k) % n;
    if (!room.players[i].out) return i;
  }
  return 0;
}

function finishDeal(room, winner) {
  clearTimeout(room.timer);
  const rows = [];
  room.players.forEach((p) => {
    if (p.status === 'out') { p.scores.push(null); return; }
    if (p === winner) p.dealScore = 0;
    else if (p.status === 'active') p.dealScore = R.evaluate(groupCards(p), room.wildRank, CFG.MAX_DEAL).deadwood;
    p.total += p.dealScore;
    p.scores.push(p.dealScore);
    if (p.total >= CFG.TOTAL_OUT) p.out = true;
    rows.push({ pid: p.pid, name: p.name, score: p.dealScore, total: p.total, out: p.out, status: p.status, won: p === winner, groups: groupCards(p) });
  });
  room.result = { dealNo: room.dealNo, winner: winner.pid, winnerName: winner.name, rows };
  log(room, `${winner.name} won deal ${room.dealNo}`);
  const left = room.players.filter((p) => !p.out);
  if (left.length <= 1) {
    room.phase = 'gameOver';
    const w = left[0] || room.players.slice().sort((a, b) => a.total - b.total)[0];
    room.gameWinner = w.pid;
    room.winners = [w.pid];
    room.shared = false;
  } else if (left.length === 2 && left[0].total === left[1].total) {
    // two players left with exactly the same score: ask them if they want to share the win
    room.phase = 'dealEnd';
    room.nextAt = 0;
    room.tie = { pids: left.map((p) => p.pid), votes: {}, endsAt: Date.now() + TIE_MS };
    clearTimeout(room.tieTimer);
    room.tieTimer = setTimeout(() => resolveTie(room), TIE_MS);
    log(room, 'Tie: two players have the same score');
  } else {
    scheduleNextDeal(room);
  }
  broadcast(room);
}

function scheduleNextDeal(room) {
  room.phase = 'dealEnd';
  room.nextAt = Date.now() + NEXT_DEAL_MS;
  clearTimeout(room.nextTimer);
  room.nextTimer = setTimeout(() => { if (room.phase === 'dealEnd' && !room.tie) startDeal(room); }, NEXT_DEAL_MS);
}

// Both say Yes -> both win and the game ends. Anyone says No (or no answer) -> the game goes on, points are kept and added.
function resolveTie(room) {
  if (!room.tie) return;
  clearTimeout(room.tieTimer);
  const t = room.tie;
  room.tie = null;
  const share = t.pids.every((pid) => t.votes[pid] === true);
  if (share) {
    room.phase = 'gameOver';
    room.winners = t.pids.slice();
    room.gameWinner = t.pids[0];
    room.shared = true;
    log(room, 'Both players agreed to share the win');
  } else {
    log(room, 'Game goes on: points are kept');
    scheduleNextDeal(room);
  }
  broadcast(room);
}

function afterExit(room) {
  const active = room.players.filter((p) => p.status === 'active');
  if (active.length === 1) return finishDeal(room, active[0]);
  setTurn(room, nextActive(room, room.turn));
  broadcast(room);
}

function doDrop(room, p, auto) {
  p.dealScore = p.turns === 0 ? CFG.FIRST_DROP : CFG.MIDDLE_DROP;
  p.status = 'dropped';
  log(room, `${p.name} ${auto ? 'timed out and ' : ''}dropped (${p.dealScore})`);
  afterExit(room);
}

function doDiscard(room, p, cardId) {
  const i = p.hand.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  const [card] = p.hand.splice(i, 1);
  p.groups = p.groups.map((g) => g.filter((id) => id !== cardId)).filter((g) => g.length);
  room.discard.push(card);
  p.turns++;
  setTurn(room, nextActive(room, room.turn));
  broadcast(room);
}

function autoPlay(room, pid, dealNo) {
  if (room.phase !== 'playing' || room.dealNo !== dealNo) return;
  const p = cur(room);
  if (p.pid !== pid) return;
  if (room.turnPhase === 'draw') doDrop(room, p, true);
  else doDiscard(room, p, p.hand[p.hand.length - 1].id);
}

function refillStock(room) {
  if (room.stock.length > 0 || room.discard.length < 2) return;
  const top = room.discard.pop();
  room.stock = R.shuffle(room.discard);
  room.discard = [top];
}

// Remove a player's connection from their table. Lobby: seat is released. In a game: they are dropped and out.
function leaveRoom(sock) {
  const room = rooms.get(sock.data.table);
  const p = room && room.players.find((x) => x.pid === sock.data.pid);
  const t = sock.data.table;
  const sp = room && !p && room.spectators.find((x) => x.pid === sock.data.pid);
  if (room && sp) {
    room.spectators = room.spectators.filter((x) => x !== sp);
    if (rooms.get(t) === room && room.players.every((x) => !x.sid) && room.spectators.every((x) => !x.sid) && room.phase !== 'lobby') freeTable(room);
    else broadcast(room);
  } else if (room && p) {
    if (room.phase === 'lobby') {
      room.players = room.players.filter((x) => x !== p);
      if (room.host === p.pid && room.players[0]) room.host = room.players[0].pid;
      if (!room.players.length) freeTable(room);
      else broadcast(room);
    } else {
      p.sid = null;
      if (room.phase === 'playing' && p.status === 'active') {
        p.dealScore = p.turns === 0 ? CFG.FIRST_DROP : CFG.MIDDLE_DROP;
        p.status = 'dropped';
        p.out = true;
        log(room, `${p.name} left the table`);
        if (cur(room) === p) afterExit(room);
        else {
          const act = room.players.filter((x) => x.status === 'active');
          if (act.length === 1) finishDeal(room, act[0]); else broadcast(room);
        }
      } else if (room.phase === 'seating') {
        p.out = true;
        broadcast(room);
      } else {
        p.out = true;
        if (room.phase === 'dealEnd') {
          const rest = room.players.filter((x) => !x.out);
          if (room.tie && room.tie.pids.includes(p.pid)) { room.tie.votes[p.pid] = false; resolveTie(room); }
          if (room.phase === 'dealEnd' && rest.length <= 1 && rest[0]) {
            clearTimeout(room.nextTimer); clearTimeout(room.tieTimer);
            room.tie = null; room.nextAt = 0; room.phase = 'gameOver'; room.gameWinner = rest[0].pid; room.winners = [rest[0].pid]; room.shared = false;
          }
        }
        broadcast(room);
      }
      if (rooms.get(t) === room && room.players.every((x) => !x.sid) && (room.phase === 'gameOver' || room.phase === 'dealEnd' || room.phase === 'seating')) freeTable(room, 'Everyone has left this table.');
    }
  }
  sock.leave('t' + t);
  sock.data = {};
}

io.on('connection', (sock) => {
  sock.data = {};
  sock.emit('tables', listTables());

  const ctx = () => {
    const room = rooms.get(sock.data.table);
    if (!room) return {};
    return { room, p: room.players.find((x) => x.pid === sock.data.pid) };
  };
  const myTurn = (room, p, phase) => room.phase === 'playing' && Date.now() >= (room.dealAt || 0) + DEAL_MS && cur(room) === p && room.turnPhase === phase;
  const cleanName = (n) => String(n || 'Player').trim().slice(0, 14) || 'Player';

  function seat(room, pid, name) {
    let p = room.players.find((x) => x.pid === pid);
    if (!p) {
      p = room.spectators.find((x) => x.pid === pid);
      if (p && room.phase === 'lobby') { // spectator becomes a player when the table is waiting for a new game
        room.spectators = room.spectators.filter((x) => x !== p);
        p = null;
      }
    }
    if (!p) {
      if (room.phase === 'lobby') {
        if (room.players.length >= CFG.MAX_P) return sock.emit('err', 'This table is full (6 players).');
        p = { pid, name, sid: null, hand: [], groups: [], total: 0, out: false, status: 'waiting', scores: [], turns: 0, dealScore: 0 };
        room.players.push(p);
        log(room, `${name} joined`);
      } else {
        // game already running: the friend watches (no cards) and can play from the next game
        if (room.spectators.length >= MAX_SPECTATORS) return sock.emit('err', 'Too many people are watching this table.');
        p = { pid, name, sid: null, hand: [], groups: [], spectator: true };
        room.spectators.push(p);
        log(room, `${name} is watching`);
      }
    }
    if (sock.data.table && sock.data.table !== room.table) leaveRoom(sock);
    p.sid = sock.id;
    p.name = name;
    sock.data = { table: room.table, pid };
    sock.join('t' + room.table);
    broadcast(room);
  }

  // The first person to open a free table becomes its owner and gets the private invite link.
  sock.on('claim', ({ table, pid, name }) => {
    table = parseInt(table, 10);
    if (!pid || !(table >= 1 && table <= TABLES)) return;
    if (rooms.has(table)) return sock.emit('err', `Table ${table} is already in use. Pick another table.`);
    const room = createRoom(table, pid);
    seat(room, pid, cleanName(name));
  });

  // Friends join with the invite link (table number + secret key).
  sock.on('join', ({ table, key, pid, name }) => {
    table = parseInt(table, 10);
    if (!pid) return;
    const room = rooms.get(table);
    if (!room) { sock.emit('err', `Table ${table} is no longer open.`); return sock.emit('gone'); }
    if (String(key || '') !== room.key) { sock.emit('err', 'Invalid invite link for this table.'); return sock.emit('gone'); }
    seat(room, pid, cleanName(name));
  });

  sock.on('start', () => {
    const { room, p } = ctx();
    if (!room || !p || room.host !== p.pid || room.phase !== 'lobby') return;
    if (room.players.length < CFG.MIN_P) return sock.emit('err', 'Need at least 2 players.');
    startSeating(room);
  });

  sock.on('next', () => {
    const { room, p } = ctx();
    if (room && p && room.host === p.pid && room.phase === 'dealEnd' && !room.tie) startDeal(room);
  });

  sock.on('rematch', () => {
    const { room, p } = ctx();
    if (!room || !p || room.host !== p.pid || room.phase !== 'gameOver') return;
    room.players = room.players.filter((q) => q.sid);
    // friends who were only watching can play from the new game
    room.spectators.filter((x) => x.sid).forEach((x) => {
      if (room.players.length < CFG.MAX_P) room.players.push({ pid: x.pid, name: x.name, sid: x.sid, hand: [], groups: [], total: 0, out: false, status: 'waiting', scores: [], turns: 0, dealScore: 0 });
    });
    room.spectators = room.spectators.filter((x) => x.sid && !room.players.some((q) => q.pid === x.pid));
    room.players.forEach((q) => { q.total = 0; q.out = false; q.scores = []; q.hand = []; q.groups = []; q.status = 'waiting'; });
    room.dealNo = 0;
    room.gameWinner = null; room.winners = []; room.shared = false; room.tie = null;
    if (room.players.length < CFG.MIN_P) { room.phase = 'lobby'; room.result = null; return broadcast(room); }
    startSeating(room);
  });

  sock.on('close', () => {
    const { room, p } = ctx();
    if (!room || !p || room.host !== p.pid) return;
    freeTable(room, 'The table owner closed this table.');
    sock.data = {};
  });

  sock.on('vote', ({ share }) => {
    const { room, p } = ctx();
    if (!room || !p || !room.tie || !room.tie.pids.includes(p.pid)) return;
    room.tie.votes[p.pid] = !!share;
    if (room.tie.pids.every((pid) => pid in room.tie.votes)) resolveTie(room);
    else broadcast(room);
  });

  sock.on('arrange', ({ groups }) => {
    const { room, p } = ctx();
    if (!room || !p || room.phase !== 'playing' || p.status !== 'active' || !Array.isArray(groups)) return;
    const ids = groups.flat();
    const have = new Set(p.hand.map((c) => c.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) return;
    p.groups = groups.filter((g) => g.length);
  });

  sock.on('draw', ({ from }) => {
    const { room, p } = ctx();
    if (!room || !p || !myTurn(room, p, 'draw')) return;
    let card;
    if (from === 'discard') {
      if (room.discard.length < 1) return;
      card = room.discard.pop();
    } else {
      refillStock(room);
      if (room.stock.length < 1) return sock.emit('err', 'No cards left to draw.');
      card = room.stock.pop();
    }
    p.hand.push(card);
    p.groups.push([card.id]);
    room.turnPhase = 'discard';
    broadcast(room);
  });

  sock.on('discard', ({ cardId }) => {
    const { room, p } = ctx();
    if (!room || !p || !myTurn(room, p, 'discard')) return;
    doDiscard(room, p, cardId);
  });

  sock.on('drop', () => {
    const { room, p } = ctx();
    if (!room || !p || !myTurn(room, p, 'draw')) return;
    doDrop(room, p, false);
  });

  sock.on('declare', ({ discardId, groups }) => {
    const { room, p } = ctx();
    if (!room || !p || !myTurn(room, p, 'discard') || !Array.isArray(groups)) return;
    const idx = p.hand.findIndex((c) => c.id === discardId);
    if (idx < 0) return;
    const rest = p.hand.filter((c) => c.id !== discardId);
    const ids = groups.flat();
    const have = new Set(rest.map((c) => c.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) {
      return sock.emit('err', 'Arrange all 13 cards into groups first.');
    }
    const m = Object.fromEntries(rest.map((c) => [c.id, c]));
    const ev = R.evaluate(groups.map((g) => g.map((id) => m[id])), room.wildRank, CFG.MAX_DEAL);
    const card = p.hand[idx];
    p.hand = rest;
    p.groups = groups;
    room.discard.push(card);
    p.turns++;
    if (ev.valid) {
      log(room, `${p.name} declared!`);
      return finishDeal(room, p);
    }
    p.dealScore = CFG.MAX_DEAL;
    p.status = 'wrong';
    log(room, `${p.name} made a wrong show (${CFG.MAX_DEAL})`);
    afterExit(room);
  });

  sock.on('leave', () => { leaveRoom(sock); });

  sock.on('disconnect', () => {
    const { room, p } = ctx();
    if (!room) return;
    if (!p) { // a spectator closed the page
      const sp = room.spectators.find((x) => x.pid === sock.data.pid);
      if (sp && sp.sid === sock.id) { room.spectators = room.spectators.filter((x) => x !== sp); broadcast(room); }
      return;
    }
    if (p.sid === sock.id) p.sid = null;
    broadcast(room);
  });
});

// Free tables that nobody has been connected to for a while.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.every((p) => !p.sid) && room.spectators.every((p) => !p.sid) && room.emptySince && Date.now() - room.emptySince > IDLE_MS) freeTable(room);
  }
}, 60 * 1000);

if (process.env.RUMMY_TEST) module.exports = { rooms, resolveTie, finishDeal };
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Rummy server on port ' + PORT));
