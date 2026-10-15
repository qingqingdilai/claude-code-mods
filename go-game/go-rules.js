// GoRules — pure Go rule logic shared by the game page and the AI opponent.
// UMD: works in browser (window.GoRules) and Node (require). No DOM, no deps.
(function (global) {
  "use strict";

  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];

  // group flood fill: returns {color, cells, libs} or null for off-board/empty
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

  // board + capture counts as a position key (same format as index.html keyOf)
  function keyOf(b, n, cb, cw) {
    return b.map(r => r.map(v => v === BLACK ? "B" : v === WHITE ? "W" : ".").join("")).join("") + "|" + cb + "|" + cw;
  }

  // apply a move to a copy, mirroring placeStone: place, capture, suicide, superko.
  // returns {ok, captured, board} or {ok:false, reason}
  function simulateMove(b, n, toMove, captures, positionSet, x, y) {
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

  const GoRules = { EMPTY, BLACK, WHITE, groupAtIn, keyOf, simulateMove };

  if (typeof module !== "undefined" && module.exports) module.exports = GoRules;
  global.GoRules = GoRules;
})(typeof window !== "undefined" ? window : globalThis);
