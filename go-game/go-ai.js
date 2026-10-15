// GoAI — pluggable Go opponent. UMD: works in browser (window.GoAI) and Node (require).
// Pure rule logic ported from index.html (groupAtIn / placeStone checks): no DOM, no deps.
(function (global) {
  "use strict";

  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];

  // group flood fill ported from index.html: returns {color, cells, libs}
  function groupAtIn(b, n, x, y) {
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    if (b[y][x] === EMPTY) return null;
    const color = b[y][x];
    const stack = [[x, y]], seen = new Set([y * n + x]), libs = new Set();
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const id = ny * n + nx;
        if (b[ny][nx] === EMPTY) libs.add(id);
        else if (b[ny][nx] === color && !seen.has(id)) { seen.add(id); stack.push([nx, ny]); }
      }
    }
    return { color, cells: [...seen], libs: libs.size };
  }

  // same key format as index.html keyOf (board + capture counts)
  function keyOf(b, n, cb, cw) {
    return b.map(r => r.map(v => v === BLACK ? "B" : v === WHITE ? "W" : ".").join("")).join("") + "|" + cb + "|" + cw;
  }

  // apply a move to a copy, mirroring placeStone: place, capture, suicide, superko.
  // returns {ok, captured, board} or {ok:false, reason}
  function simulate(b, n, toMove, captures, positionSet, x, y) {
    if (b[y][x] !== EMPTY) return { ok: false, reason: "occupied" };
    const color = toMove, opp = 3 - color;
    const copy = b.map(r => r.slice());
    copy[y][x] = color;
    let captured = 0;
    const seenCap = new Set();
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      if (copy[ny][nx] !== opp) continue;
      const g = groupAtIn(copy, n, nx, ny);
      if (g.libs === 0) {
        const gkey = g.cells.join(",");
        if (seenCap.has(gkey)) continue;
        seenCap.add(gkey);
        for (const c of g.cells) copy[Math.floor(c / n)][c % n] = EMPTY;
        captured += g.cells.length;
      }
    }
    // suicide check: our group needs a liberty when nothing was captured
    const self = groupAtIn(copy, n, x, y);
    if (self.libs === 0 && captured === 0) return { ok: false, reason: "suicide" };
    // superko: position plus capture counts must be new (same key as index.html)
    const key = keyOf(copy, n,
      captures[BLACK] + (color === BLACK ? captured : 0),
      captures[WHITE] + (color === WHITE ? captured : 0));
    if (positionSet.has(key)) return { ok: false, reason: "repeat" };
    return { ok: true, captured, board: copy };
  }

  // legal moves: every empty point that survives simulate()
  function getLegalMoves(board, size, toMove, captures, positionSet) {
    const out = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (board[y][x] !== EMPTY) continue;
      if (simulate(board, size, toMove, captures, positionSet, x, y).ok) out.push([x, y]);
    }
    return out;
  }

  function legalMoveCount(board, size, toMove, captures, positionSet) {
    return getLegalMoves(board, size, toMove, captures, positionSet).length;
  }

  // stones of `color` on the board
  function stonesOnBoard(b, n, color) {
    let c = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (b[y][x] === color) c++;
    return c;
  }

  // fast territory proxy: empty point adjacent to >=1 own stone and no enemy stone
  function territory(b, n, color) {
    const opp = 3 - color;
    let c = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (b[y][x] !== EMPTY) continue;
      let own = 0, enemy = 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        if (b[ny][nx] === color) own++;
        else if (b[ny][nx] === opp) enemy++;
      }
      if (own > 0 && enemy === 0) c++;
    }
    return c;
  }

  // leaf eval from `color`'s perspective:
  //   stones(color) + 2 * territory(color) + 2 * captures[color], minus the same for the opponent
  function evalFor(b, n, color, captures) {
    const opp = 3 - color;
    const mine = stonesOnBoard(b, n, color) + 2 * territory(b, n, color) + 2 * captures[color];
    const their = stonesOnBoard(b, n, opp) + 2 * territory(b, n, opp) + 2 * captures[opp];
    return mine - their;
  }

  function adjacentCount(b, n, x, y, color) {
    let c = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === color) c++;
    }
    return c;
  }

  // greedy: capture the most stones; tie-break enemy-adjacent, then own-adjacent, then random.
  // rng (default Math.random) is injectable for deterministic tests of exact ties.
  function bestMoveGreedy(board, size, toMove, captures, positionSet, rng = Math.random) {
    const legal = getLegalMoves(board, size, toMove, captures, positionSet);
    if (!legal.length) return null;
    const opp = 3 - toMove;
    // score each move: captures, then enemy-adjacent, then own-adjacent.
    // All three counts are computed on the POST-move board, since capture
    // changes the neighbors (an enemy just removed by the capture no longer
    // counts toward the adjacency tie-break).
    let best = null, bestKey = null;
    let tie = [];
    for (const [x, y] of legal) {
      const sim = simulate(board, size, toMove, captures, positionSet, x, y);
      const key = [sim.captured,
                   adjacentCount(sim.board, size, x, y, opp),
                   adjacentCount(sim.board, size, x, y, toMove)];
      // strict improvement: replace best and reset the tie pool
      if (!bestKey || (key[0] > bestKey[0] ||
          (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
          (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2]))) {
        best = [x, y]; bestKey = key;
        tie = [[x, y]];
      } else if (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] === bestKey[2]) {
        // exact tie on all three criteria: join the pool
        tie.push([x, y]);
      }
    }
    // random pick only within the pool of moves strictly tied with `best`
    return tie.length > 1 ? tie[Math.floor(rng() * tie.length)] : best;
  }

  // alpha-beta minimax, depth 2 (root move + one opponent reply). Node budget ~3000
  // evals; when the budget is exceeded, fall back to the best move found so far.
  // Values are relative scores: a move's outcome = -(opponent's min reply value).
  function minimax2(board, size, toMove, captures, positionSet) {
    const legal = getLegalMoves(board, size, toMove, captures, positionSet);
    if (!legal.length) return null;
    const opp = 3 - toMove;
    const budget = { evals: 0, limit: 3000, aborted: false };

    function nextCaps(caps, mover, captured) {
      const n = { [BLACK]: caps[BLACK], [WHITE]: caps[WHITE] };
      n[mover] += captured;
      return n;
    }
    // depth counter: 2 = root, 1 = opponent reply, 0 = leaf eval.
    // Budget ~3000 leaf evals; when exceeded, fall back to the best move
    // found so far at the root.
    function minimax(b, n, mover, root, caps, pos, depth, alpha, beta) {
      if (depth <= 0 || budget.aborted) {
        budget.evals++;
        if (budget.evals > budget.limit) budget.aborted = true;
        return evalFor(b, n, root, caps);
      }
      const moves = getLegalMoves(b, n, mover, caps, pos);
      if (!moves.length) {
        budget.evals++;
        if (budget.evals > budget.limit) budget.aborted = true;
        return evalFor(b, n, root, caps);
      }
      const enemy = 3 - mover;
      // legal-move ordering: captures first, then enemy-adjacent, so pruning kicks in
      const scored = moves.map(([x, y]) => {
        const sim = simulate(b, n, mover, caps, pos, x, y);
        return { m: [x, y], cap: sim.captured, sim, en: adjacentCount(b, n, x, y, enemy) };
      });
      scored.sort((a, c) => (c.cap - a.cap) || (c.en - a.en));
      const maximizing = mover === root;
      let best = maximizing ? -Infinity : Infinity;
      for (const s of scored) {
        if (budget.aborted) break;
        const cc = nextCaps(caps, mover, s.cap);
        const childPos = new Set(pos);
        childPos.add(keyOf(s.sim.board, n, cc[BLACK], cc[WHITE]));
        const ev = minimax(s.sim.board, n, 3 - mover, root, cc, childPos, depth - 1, alpha, beta);
        if (budget.aborted) break;
        if (maximizing) {
          best = Math.max(best, ev);
          alpha = Math.max(alpha, best);
        } else {
          best = Math.min(best, ev);
          beta = Math.min(beta, best);
        }
        if (alpha >= beta) break;
      }
      return best;
    }

    // root: toMove ("root") maximizes; each child is the opponent's reply (min)
    const rootMoves = legal.map(([x, y]) => {
      const sim = simulate(board, size, toMove, captures, positionSet, x, y);
      return { m: [x, y], cap: sim.captured, sim, en: adjacentCount(board, size, x, y, opp) };
    });
    rootMoves.sort((a, b) => (b.cap - a.cap) || (b.en - a.en));

    let bestMove = rootMoves[0].m;
    let bestVal = -Infinity;
    let alpha = -Infinity;
    for (const s of rootMoves) {
      if (budget.aborted) break;
      const cc = nextCaps(captures, toMove, s.cap);
      const cp = new Set(positionSet);
      cp.add(keyOf(s.sim.board, size, cc[BLACK], cc[WHITE]));
      const ev = minimax(s.sim.board, size, opp, toMove, cc, cp, 1, alpha, Infinity);
      if (budget.aborted) break;
      if (ev > bestVal) { bestVal = ev; bestMove = s.m; }
      alpha = Math.max(alpha, ev);
    }
    return bestMove;
  }

  // mode: "greedy" (default) or "minimax2". rng (default Math.random) is forwarded
  // to bestMoveGreedy so exact tie-breaks are deterministic under test.
  function bestMove(board, size, toMove, captures, positionSet, mode, rng = Math.random) {
    return mode === "minimax2"
      ? minimax2(board, size, toMove, captures, positionSet)
      : bestMoveGreedy(board, size, toMove, captures, positionSet, rng);
  }

  // pass when there is no legal move, or (minimax2) the best move's eval gain
  // over passing (evalAfter - evalBefore) is <= 0.
  function choosePassOrMove(state, mode) {
    const { board, size, toMove, captures, positionSet } = state;
    if (legalMoveCount(board, size, toMove, captures, positionSet) === 0) return { pass: true };
    // compute the best move once; for minimax2 reuse it for the pass decision
    const m = bestMove(board, size, toMove, captures, positionSet, mode);
    if (!m) return { pass: true };
    if (mode === "minimax2") {
      const sim = simulate(board, size, toMove, captures, positionSet, m[0], m[1]);
      const cc = { [BLACK]: captures[BLACK] + (toMove === BLACK ? sim.captured : 0),
                   [WHITE]: captures[WHITE] + (toMove === WHITE ? sim.captured : 0) };
      const before = evalFor(board, size, toMove, captures);
      const after = evalFor(sim.board, size, toMove, cc);
      if (after - before <= 0) return { pass: true };
    }
    return { move: m };
  }

  const GoAI = { getLegalMoves, legalMoveCount, bestMove, choosePassOrMove,
                 _internals: { simulate, groupAtIn, keyOf, evalFor, territory, stonesOnBoard } };

  if (typeof module !== "undefined" && module.exports) module.exports = GoAI;
  global.GoAI = GoAI;
})(typeof window !== "undefined" ? window : globalThis);
