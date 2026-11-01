'use strict';
// Indian Rummy (13 cards) rules engine. Ace = 1 (can also be high: Q-K-A). J=11, Q=12, K=13.
// Printed joker: s === 'J', r === 0.  Wild joker = every card whose rank === wildRank.

const SUITS = ['S', 'H', 'D', 'C'];

function makeDeck() {
  const cards = [];
  let id = 0;
  for (let d = 0; d < 2; d++)
    for (const s of SUITS)
      for (let r = 1; r <= 13; r++) cards.push({ id: id++, r, s });
  cards.push({ id: id++, r: 0, s: 'J' });
  cards.push({ id: id++, r: 0, s: 'J' });
  return cards; // 106 cards
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pts = (c) => (c.s === 'J' ? 0 : c.r === 1 || c.r >= 10 ? 10 : c.r);
const isPrinted = (c) => c.s === 'J';
const isWild = (c, w) => c.s === 'J' || c.r === w;

function fits(ranks, n, high) {
  const lo = high ? 2 : 1;
  const hi = high ? 14 : 13;
  const mn = ranks[0];
  const mx = ranks[ranks.length - 1];
  for (let st = lo; st + n - 1 <= hi; st++) if (st <= mn && st + n - 1 >= mx) return true;
  return false;
}

function runOk(ranks, n) {
  if (fits(ranks, n, false)) return true;
  if (ranks.includes(1)) {
    const r2 = ranks.map((x) => (x === 1 ? 14 : x)).sort((a, b) => a - b);
    return fits(r2, n, true);
  }
  return false;
}

function uniqueSorted(ranks) {
  const s = ranks.slice().sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] === s[i - 1]) return null;
  return s;
}

function pureSeq(cards) {
  if (cards.length < 3) return false;
  if (cards.some(isPrinted)) return false;
  const s = cards[0].s;
  if (cards.some((c) => c.s !== s)) return false;
  const ranks = uniqueSorted(cards.map((c) => c.r));
  if (!ranks) return false;
  return runOk(ranks, cards.length);
}

function impureSeq(cards, w) {
  if (cards.length < 3) return false;
  const nat = cards.filter((c) => !isWild(c, w));
  if (nat.length === 0) return false;
  const s = nat[0].s;
  if (nat.some((c) => c.s !== s)) return false;
  const ranks = uniqueSorted(nat.map((c) => c.r));
  if (!ranks) return false;
  return runOk(ranks, cards.length);
}

function setOk(cards, w) {
  if (cards.length < 3 || cards.length > 4) return false;
  const nat = cards.filter((c) => !isWild(c, w));
  if (nat.length === 0) return false;
  const r = nat[0].r;
  if (nat.some((c) => c.r !== r)) return false;
  const suits = new Set(nat.map((c) => c.s));
  return suits.size === nat.length;
}

function classify(cards, w) {
  if (pureSeq(cards)) return 'pure';
  if (impureSeq(cards, w)) return 'seq';
  if (setOk(cards, w)) return 'set';
  return null;
}

// groups: array of arrays of card objects. Returns { valid, deadwood, kinds }
function evaluate(groups, w, maxPts) {
  const kinds = groups.map((g) => classify(g, w));
  const P = kinds.filter((k) => k === 'pure').length;
  const I = kinds.filter((k) => k === 'seq').length;
  const valid = P >= 1 && P + I >= 2 && kinds.every((k) => k);
  const melded = new Set();
  if (P >= 1) {
    kinds.forEach((k, i) => {
      if (k === 'pure') melded.add(i);
      else if (k && P + I >= 2) melded.add(i);
    });
  }
  let dead = 0;
  groups.forEach((g, i) => {
    if (!melded.has(i)) g.forEach((c) => (dead += pts(c)));
  });
  return { valid, deadwood: Math.min(dead, maxPts || 80), kinds };
}

module.exports = { makeDeck, shuffle, evaluate, classify, pts };
