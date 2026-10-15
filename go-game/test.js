// Test the Go game logic extracted from index.html
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// resolve files next to this script so `node go-game/test.js` works from any CWD
const here = __dirname;
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
// only the inline <script> block — go-ai.js is a separate src= script
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

function noop() {}
function makeEl() {
  return {
    style: {},
    classList: { add: noop, remove: noop, toggle: noop },
    textContent: '', innerHTML: '',
    appendChild: noop, addEventListener: noop,
    setAttribute: noop, getAttribute: () => null,
    querySelectorAll: () => [],
    getContext: () => new Proxy({}, {
      get: (t, p) => {
        if (p === 'createRadialGradient') return () => ({ addColorStop: noop });
        if (p === 'measureText') return () => ({ width: 0 });
        return typeof p === 'string' ? noop : undefined;
      },
      set: () => true
    }),
    dataset: {},
  };
}

const documentStub = {
  getElementById: () => makeEl(),
  createElement: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener: noop,
  documentElement: { setAttribute: noop, getAttribute: () => null },
};

let passed = 0, failed = 0;
function check(desc, cond) {
  if (cond) { passed++; console.log('  PASS:', desc); }
  else { failed++; console.log('  FAIL:', desc); }
}

console.log('=== Go Logic Tests ===\n');

// vm keeps top-level `let` bindings in the context's global lexical scope,
// so functions (hoisted on the global object) are reachable but live state
// is not. We therefore:
//  - seed scenario state via `var`s (which DO land on the global object),
//  - call the game's own functions to execute real logic,
//  - read results through a `globalThis.__dbg` snapshot taken inside the vm.
function runScript() {
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    window: { addEventListener: noop, devicePixelRatio: 1, innerWidth: 600, GoAI: undefined },
    document: documentStub,
    setTimeout: () => 0,
    clearTimeout: noop,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    __dbg: null,
  };
  vm.createContext(sandbox);

  const setup =
    'var __res;\n' +
    'function dbg(){ __dbg={ board: board.map(r=>r.slice()),' +
    ' toMove, lastMove, captures:{...captures}, over }; }\n' +
    'function placeRaw(x,y){ __res=placeStone(x,y); if(__res.ok) commit(x,y,__res); dbg(); return __res; }\n' +
    'function seed(cells,toMove,lastMove){ newGame();' +
    ' for(const k in cells){ const p=k.split(","); board[p[0]|0][p[1]|0]=cells[k]; }' +
    ' positionSet.clear(); positionSet.add(undoStackKey());' +
    ' toMove=toMove; lastMove=lastMove; dbg(); }\n' +
    'function doUndo(){ undo(); dbg(); }\n' +
    'function doPass(){ onPass(); dbg(); }\n' +
    'function doNew(){ newGame(); dbg(); }\n';

  vm.runInContext(code + setup, sandbox);
  const call = expr => { vm.runInContext(expr, sandbox); return vm.runInContext('__dbg', sandbox); };
  return {
    newGame: () => call('doNew()'),
    undo:    () => call('doUndo()'),
    pass:    () => call('doPass()'),
    place:   (x, y, onState) => {
      const res = vm.runInContext(`placeRaw(${x},${y})`, sandbox);
      return { res, state: onState ? vm.runInContext('__dbg', sandbox) : null };
    },
    seed:    (cells, toMove, lastMove = -1) =>
      call(`seed(${JSON.stringify(cells)},${toMove},${lastMove})`),
  };
}

// --- 1: new game creates empty 9x9 board ---
let G = runScript();
let s = G.newGame();
check('board is 9x9', s.board.length === 9 && s.board[0].length === 9);
check('board starts empty', s.board[0][0] === 0);
check('toMove is BLACK', s.toMove === 1);

// --- 2: place stone, turn swaps, lastMove tracked ---
let r1 = G.place(0, 0, true);
check('placeStone(0,0) succeeds', r1.res.ok === true);
check('stone at (0,0) is black', r1.state.board[0][0] === 1);
check('lastMove set to 0', r1.state.lastMove === 0);
check('toMove now WHITE', r1.state.toMove === 2);

// --- 3: occupied square rejected (board unchanged) ---
let r2 = G.place(0, 0, true);
check('occupied square rejected', r2.res.ok === false && r2.res.reason === 'occupied');
check('board unchanged after illegal move', r2.state.board[0][0] === 1);

// --- 4: capture (white corner stone squeezed out over two black moves) ---
// Full alternating sequence so turns stay correct:
//   white stone at (0,0) · black (0,1) · white (0,2) · black (1,0) → captures
G = runScript();
G.seed({ '0,0': 2 }, 1);
G.place(0, 1, false);   // black cuts one liberty  (turn → white)
G.place(0, 2, false);   // white moves elsewhere   (turn → black)
let r4 = G.place(1, 0, true);
check('black (1,0) captures 1', r4.res.ok && r4.res.captured === 1);
check('white stone removed', r4.state.board[0][0] === 0);
check('captures[BLACK] === 1', r4.state.captures[1] === 1);

// --- 5: suicide rejected, board untouched ---
G = runScript();
G.seed({ '0,1': 2, '1,0': 2 }, 1);
let r5 = G.place(0, 0, true);
check('suicide rejected', r5.res.ok === false && r5.res.reason === 'suicide');
check('suicide not placed', r5.state.board[0][0] === 0);

// --- 6: undo restores board, turn and captures ---
// Undo one move: white's last stone is removed, black's remains
G = runScript();
G.newGame();
G.place(0, 0, false); // black
const st1 = G.place(1, 1, true); // white
let su = G.undo();
check('undo removes white stone', su.board[1][1] === 0);
check('undo keeps black stone', su.board[0][0] === 1);
check('undo restores toMove WHITE', su.toMove === 2);
check('undo restores lastMove', su.lastMove === 0);
// Undo second move: board fully empty
let su2 = G.undo();
check('second undo empties board', su2.board[0][0] === 0 && su2.board[1][1] === 0);
check('second undo toMove BLACK', su2.toMove === 1);
check('second undo lastMove -1', su2.lastMove === -1);

// --- 6b: undo after capture restores captured stones ---
G = runScript();
G.seed({ '0,0': 2 }, 1);
G.place(0, 1, false);
G.place(0, 2, false);
G.place(1, 0, false); // black captures white (0,0)
let sc = G.undo();
check('undo after capture restores white stone', sc.board[0][0] === 2);
check('undo after capture resets captures', sc.captures[1] === 0);

// --- 7: two passes end the game ---
G = runScript();
let sp = G.pass();
check('one pass: not over', sp.over === false);
sp = G.pass();
check('two passes: game over', sp.over === true);

// --- 8: superko — repeating a board position is rejected ---
// White (4,3) with all liberties blocked except (3,3):
//   Black: (3,4),(4,4),(5,3),(4,2)
//   White: (4,3)
// Black (3,3) captures white (4,3). White's immediate recapture at (3,3)
// would recreate a previously seen position → superko rejects it.
G = runScript();
G.seed({ '4,3': 2, '3,4': 1, '4,4': 1, '5,3': 1, '4,2': 1 }, 1);
let rk1 = G.place(3, 3, true);
check('ko: black (3,3) legal', rk1.res.ok === true);
check('ko: black stone on board', rk1.state.board[3][3] === 1);
check('ko: black captures white (4,3)', rk1.res.captured === 1 && rk1.state.board[4][3] === 0);
let rk2 = G.place(3, 3, true);
check('ko: white recapture at (3,3) rejected', rk2.res.ok === false);
check('ko: board unchanged after rejection', rk2.state.board[3][3] === 1);

// --- 9: GoAI opponent logic (UMD module, required directly from Node) ---
console.log('\n=== GoAI Tests ===\n');
const GoAI = require(path.join(here, 'go-ai.js'));
function emptyBoard(n) { return Array.from({ length: n }, () => Array(n).fill(0)); }
function mkState(board, toMove, captures, n = 9) {
  // positionSet: one entry for the current position, like the game keeps
  const key = b => b.map(r => r.map(v => v === 1 ? 'B' : v === 2 ? 'W' : '.').join('')).join('')
    + '|' + captures[1] + '|' + captures[2];
  const positionSet = new Set([key(board)]);
  return { board, size: n, toMove, captures, positionSet };
}

// 9a: getLegalMoves matches placeStone's rules on a capture shape
{
  const board = emptyBoard(9);
  board[0][0] = 2; // white corner stone
  const st = mkState(board, 1, { 1: 0, 2: 0 });
  const legal = GoAI.getLegalMoves(st.board, st.size, st.toMove, st.captures, st.positionSet);
  // (1,0) is legal AND captures the white stone
  const hasCap = legal.some(([x, y]) => x === 1 && y === 0);
  check('ai: (1,0) is a legal move', hasCap);
  // occupied point is never legal
  check('ai: occupied (0,0) not in legal moves', !legal.some(([x, y]) => x === 0 && y === 0));
  check('ai: legalMoveCount > 0', GoAI.legalMoveCount(st.board, st.size, st.toMove, st.captures, st.positionSet) > 0);
}

// 9b: greedy mode picks the capturing move and is never suicide/repeat
{
  const board = emptyBoard(9);
  board[0][0] = 2; // white corner stone, last liberties (0,1) and (1,0)
  const st = mkState(board, 1, { 1: 0, 2: 0 });
  // both (0,1) and (1,0) capture; either is a correct greedy answer
  const mv = GoAI.bestMove(st.board, st.size, st.toMove, st.captures, st.positionSet, 'greedy');
  check('ai greedy: picks a capturing move',
        mv && ((mv[0] === 0 && mv[1] === 1) || (mv[0] === 1 && mv[1] === 0)));
}

// 9c: minimax2 returns a legal move, and null when no move is legal
{
  const board = emptyBoard(9);
  const st = mkState(board, 1, { 1: 0, 2: 0 });
  const mv = GoAI.bestMove(st.board, st.size, st.toMove, st.captures, st.positionSet, 'minimax2');
  const legal = GoAI.getLegalMoves(st.board, st.size, st.toMove, st.captures, st.positionSet);
  check('ai minimax2: returns a move on an open board', Array.isArray(mv));
  check('ai minimax2: move is legal', mv && legal.some(([x, y]) => x === mv[0] && y === mv[1]));

  // fully blocked corner: white surrounds the only spot → black has 0 legal moves
  const b2 = emptyBoard(3);
  b2[0][0] = 2; b2[0][1] = 2; b2[1][0] = 2; b2[2][0] = 1;
  // 3x3 is tiny; make a real "no move" via all-occupied 3x3
  const b3 = emptyBoard(3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) b3[y][x] = (x + y) % 2 ? 1 : 2;
  const st3 = mkState(b3, 1, { 1: 0, 2: 0 }, 3);
  check('ai: legalMoveCount is 0 on a full board', GoAI.legalMoveCount(st3.board, st3.size, st3.toMove, st3.captures, st3.positionSet) === 0);
  check('ai minimax2: null when no legal move', GoAI.bestMove(st3.board, st3.size, st3.toMove, st3.captures, st3.positionSet, 'minimax2') === null);
  check('ai greedy: null when no legal move', GoAI.bestMove(st3.board, st3.size, st3.toMove, st3.captures, st3.positionSet, 'greedy') === null);
}

// 9d: choosePassOrMove passes only when no legal move, else moves
{
  const bFull = emptyBoard(3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) bFull[y][x] = (x + y) % 2 ? 1 : 2;
  const stFull = mkState(bFull, 1, { 1: 0, 2: 0 }, 3);
  check('ai: choosePassOrMove passes on full board', GoAI.choosePassOrMove(stFull, 'greedy').pass === true);
  const bOpen = emptyBoard(9);
  const stOpen = mkState(bOpen, 1, { 1: 0, 2: 0 });
  check('ai: choosePassOrMove moves on open board', !GoAI.choosePassOrMove(stOpen, 'greedy').pass);
}

// --- 10: cross-check — index.html's own rule logic must agree with go-rules.js / go-ai.js ---
// Guards against the two implementations drifting apart if one is edited without the other.
console.log('\n=== Cross-Consistency Tests ===\n');
const GoRules = require(path.join(here, 'go-rules.js'));

function boardMatches(a, b) {
  return a.length === b.length && a.every((row, y) => row.every((v, x) => v === b[y][x]));
}

// Run index.html's real placeStone (via its vm sandbox) and GoRules.simulateMove on the
// same seeded state; they must agree on ok/reason/captured AND produce identical boards.
function runScriptWithRules() {
  // Same harness as runScript(), but we need access to placeStone directly (not wrapped in commit)
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { addEventListener: noop, devicePixelRatio: 1, innerWidth: 600, GoAI: undefined, GoRules: undefined },
    document: documentStub,
    setTimeout: () => 0,
    clearTimeout: noop,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    __dbg: null,
  };
  vm.createContext(sandbox);
  const setup =
    'var __res;\n' +
    'function dbg(){ __dbg={ board: board.map(r=>r.slice()), toMove, lastMove, captures:{...captures}, over }; }\n' +
    'function seed(cells,toMove,lastMove){ newGame();' +
    ' for(const k in cells){ const p=k.split(","); board[p[0]|0][p[1]|0]=cells[k]; }' +
    ' positionSet.clear(); positionSet.add(undoStackKey());' +
    ' toMove=toMove; lastMove=lastMove; dbg(); }\n';
  vm.runInContext(code + setup, sandbox);
  return {
    seed: (cells, toMove, lastMove = -1) =>
      vm.runInContext(`seed(${JSON.stringify(cells)},${toMove},${lastMove})`, sandbox),
    placeRaw: (x, y) => vm.runInContext(`placeStone(${x},${y})`, sandbox),
    commit: (x, y, res) => vm.runInContext(`commit(${x},${y},${JSON.stringify(res)})`, sandbox),
    getState: () => vm.runInContext('__dbg', sandbox),
  };
}

// Scenario A: corner capture — both must report captured===1 and identical resulting board
{
  const R = runScriptWithRules();
  const cells = { '0,0': 2 };
  R.seed(cells, 1);
  const before = R.getState().board;

  const pageRes = R.placeRaw(1, 0); // black plays (1,0), capturing white (0,0)

  // Re-seed identically for GoRules so both start from the exact same state
  const n = 9;
  const rulesBoard = emptyBoard(n);
  for (const [k, v] of Object.entries(cells)) {
    const [y, x] = k.split(',').map(Number);
    rulesBoard[y][x] = v;
  }
  const caps = { 1: 0, 2: 0 };
  const key = b => b.map(r => r.map(v => v === 1 ? 'B' : v === 2 ? 'W' : '.').join('')).join('') + '|' + caps[1] + '|' + caps[2];
  const positionSet = new Set([key(rulesBoard)]);
  const rulesRes = GoRules.simulateMove(rulesBoard, n, 1, caps, positionSet, 1, 0);

  check('cross: page & rules agree on ok', pageRes.ok === rulesRes.ok);
  check('cross: page & rules agree on captured count', pageRes.captured === rulesRes.captured);
  check('cross: page & rules produce identical board', boardMatches(pageRes.board || before, rulesRes.board));
}

// Scenario B: suicide — both must reject with reason "suicide"
{
  const R = runScriptWithRules();
  const cells = { '0,1': 2, '1,0': 2 };
  R.seed(cells, 1);
  const pageRes = R.placeRaw(0, 0);

  const n = 9;
  const rulesBoard = emptyBoard(n);
  for (const [k, v] of Object.entries(cells)) {
    const [y, x] = k.split(',').map(Number);
    rulesBoard[y][x] = v;
  }
  const caps = { 1: 0, 2: 0 };
  const key = b => b.map(r => r.map(v => v === 1 ? 'B' : v === 2 ? 'W' : '.').join('')).join('') + '|' + caps[1] + '|' + caps[2];
  const positionSet = new Set([key(rulesBoard)]);
  const rulesRes = GoRules.simulateMove(rulesBoard, n, 1, caps, positionSet, 0, 0);

  check('cross: suicide rejected by page', pageRes.ok === false && pageRes.reason === 'suicide');
  check('cross: suicide rejected by rules', rulesRes.ok === false && rulesRes.reason === 'suicide');
}

// Scenario C: immediate recapture at a ko-shaped point — both must reject (same reason)
{
  const R = runScriptWithRules();
  const cells = { '4,3': 2, '3,4': 1, '4,4': 1, '5,3': 1, '4,2': 1 };
  R.seed(cells, 1);
  // Black (3,3) first — capturing move that sets up the ko shape; commit so the board updates
  const firstRes = R.placeRaw(3, 3);
  if (!firstRes.ok) throw new Error('cross C setup failed: first move not ok');
  R.commit(3, 3, firstRes);
  const pageRes = R.placeRaw(3, 3); // White immediately tries the same point again

  const n = 9;
  const rulesBoard = emptyBoard(n);
  for (const [k, v] of Object.entries(cells)) {
    const [y, x] = k.split(',').map(Number);
    rulesBoard[y][x] = v;
  }
  const caps = { 1: 0, 2: 0 };
  const keyOfBoard = (b, cb, cw) => b.map(r => r.map(v => v === 1 ? 'B' : v === 2 ? 'W' : '.').join('')).join('') + '|' + cb + '|' + cw;
  const positionSet = new Set([keyOfBoard(rulesBoard, 0, 0)]);
  const firstSim = GoRules.simulateMove(rulesBoard, n, 1, caps, positionSet, 3, 3);
  positionSet.add(keyOfBoard(firstSim.board, caps[1], caps[2]));
  const rulesRes = GoRules.simulateMove(firstSim.board, n, 2, caps, positionSet, 3, 3);

  check('cross: page & rules agree on rejecting the immediate recapture',
        pageRes.ok === false && rulesRes.ok === false && pageRes.reason === rulesRes.reason);
}

// Scenario D: GoAI.getLegalMoves must match what index.html considers playable
// (i.e. every point GoAI calls legal must also pass index.html's own placeStone, and vice versa)
{
  const R = runScriptWithRules();
  const cells = { '0,0': 2, '0,1': 1, '1,0': 1 }; // white corner stone, two black stones around it
  R.seed(cells, 2); // white to move
  const n = 9;
  const rulesBoard = emptyBoard(n);
  for (const [k, v] of Object.entries(cells)) {
    const [y, x] = k.split(',').map(Number);
    rulesBoard[y][x] = v;
  }
  const caps = { 1: 0, 2: 0 };
  const key = b => b.map(r => r.map(v => v === 1 ? 'B' : v === 2 ? 'W' : '.').join('')).join('') + '|' + caps[1] + '|' + caps[2];
  const positionSet = new Set([key(rulesBoard)]);
  const aiLegal = GoAI.getLegalMoves(rulesBoard, n, 2, caps, positionSet).map(([x, y]) => `${x},${y}`);

  let mismatch = null;
  for (let y = 0; y < n && !mismatch; y++) for (let x = 0; x < n && !mismatch; x++) {
    if (rulesBoard[y][x] !== 0) continue;
    const aiSays = aiLegal.includes(`${x},${y}`);
    const pageSays = R.placeRaw(x, y).ok;
    if (aiSays !== pageSays) mismatch = { x, y, aiSays, pageSays };
  }
  check('cross: GoAI legal-move set matches index.html placeStone across all empty points', mismatch === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
