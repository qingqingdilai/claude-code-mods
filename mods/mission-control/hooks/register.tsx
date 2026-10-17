// Mission Control: /mission opens a pane with two views of the current turn.
//   who  · the main loop, its subagents and every tool call they make, live
//   code · a rendered map of the files Claude reads and edits, the imports between
//          them, a glow on what it touches right now, and one line on each change
// A band line sums it up while Claude works.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MapFile, MissionNode } from '../types'
import { importsOf, svg } from './map'
import { label, lines, summary } from './tree'

const PANE = 'mission-control'
const MAX_NODES = 300
const MAX_FILES = 14
const BAND_AFTER_MS = 30_000 // the band stays this long after a turn ends

// Candidate headless-browser binaries, in order of preference: Chrome first, then Edge.
// The list depends only on the platform, so it is easy to test; `exists` filters it.
export function browserCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (platform === 'win32') {
    const roots = ['C:/Program Files', 'C:/Program Files (x86)']
    return [
      ...roots.map(r => `${r}/Google/Chrome/Application/chrome.exe`),
      ...roots.map(r => `${r}/Microsoft/Edge/Application/msedge.exe`),
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge']
}

// The host's platform. `process` does not exist where the engine sandbox runs the mod,
// so ask the environment instead: TEMP is set on Windows, TMPDIR on macOS and Linux.
export async function platformOf($: EngineInterface): Promise<'win32' | 'darwin' | 'linux'> {
  if ((await $.env.get('TEMP')) ?? (await $.env.get('TMP'))) return 'win32'
  return (await $.env.get('TMPDIR')) ? 'darwin' : 'linux'
}

// The first candidate that exists; null when no known browser is installed.
export async function findBrowser($: EngineInterface): Promise<string | null> {
  for (const c of browserCandidates(await platformOf($))) if (await $.fs.exists(c)) return c
  return null
}

// Tools that are Claude Code's own bookkeeping, not work: kept out of the tree.
const INTERNAL = new Set(['SubagentHandback', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
// Files that belong on a code map: source, config and docs, not images or binaries.
export const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|md|mdx|json|ya?ml|toml|sh|sql|lua|ex|exs)$/i

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission-control', key: 'nodes' } as const, [] as MissionNode[])
const files = atom({ plugin: 'mission-control', key: 'files' } as const, [] as MapFile[])
const view = atom({ plugin: 'mission-control', key: 'view' } as const, 'who' as 'who' | 'code')
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, null as { file: string; n: number } | null)
const turn = atom({ plugin: 'mission-control', key: 'turn' } as const, 0)
const now = atom({ plugin: 'mission-control', key: 'now' } as const, 0)

// Drawing bookkeeping; a reload starts it over.
const draw = { size: { columns: 100, rows: 30 }, pending: false, dirty: false, n: 0, error: '' }
const changes = new Map<string, string[]>() // path → this turn's edits, for the one-line "why"

// Under the cap, the oldest tool calls go first; main and the agents always stay.
export function cap(list: MissionNode[]) {
  if (list.length <= MAX_NODES) return list
  const tools = list.filter(n => n.kind === 'tool')
  const room = Math.max(0, MAX_NODES - (list.length - tools.length))
  const keep = new Set(room === 0 ? [] : tools.slice(-room))
  return list.filter(n => n.kind !== 'tool' || keep.has(n))
}

// The first `max` characters, cut at a word.
function words(text: string, max: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return `${t.slice(0, cut > max * 0.5 ? cut : max)}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mission', description: 'Open the live map of agents and tool calls; /mission code opens the code map', argumentHint: '[who|code]' }).catch(() => {})
    $.clock.every(1000, () => {
      void (async () => {
        const busy = (await read($, nodes)).some(n => n.status === 'running')
        if (busy) await update($, now, () => Date.now())
      })().catch(() => {})
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    const t = (await read($, turn)) + 1
    await update($, turn, () => t)
    changes.clear()
    const main: MissionNode = { id: 'main', parent: null, kind: 'main', label: `main · ${words(e.text, 50)}`, family: 'main', status: 'running', start: Date.now() }
    // A background agent still running from the last turn carries over, with its open calls.
    await update($, nodes, list => {
      const agents = list.filter(n => n.kind === 'agent' && n.status === 'running').map(a => ({ ...a, parent: 'main' }))
      const ids = new Set(agents.map(a => a.id))
      const open = list.filter(n => n.kind === 'tool' && n.status === 'running' && ids.has(n.parent ?? ''))
      return [main, ...agents, ...open]
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const agent: MissionNode = { id, parent: e.parentAgentId ?? 'main', kind: 'agent', label: e.description || e.subagentType, family: 'agent', status: 'running', start: Date.now() }
      await update($, nodes, list => cap([...list, agent]))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') return next(e) // its subagent shows up through agent.spawn
    if (INTERNAL.has(e.tool)) return next(e) // bookkeeping, not work a person would follow
    const args = e as unknown as Record<string, unknown>
    const { label: text, family } = label(args)
    const id = e.tool_use_id
    await update($, nodes, list => {
      // A call from an agent this tree does not know hangs off main rather than nowhere.
      const parent = e.agentId && list.some(n => n.id === e.agentId) ? e.agentId : 'main'
      return cap([...list, { id, parent, kind: 'tool', label: text, family, status: 'running', start: Date.now() }])
    })
    const path = typeof args.file_path === 'string' ? args.file_path : undefined
    if (path) await touch($, path, e.tool === 'Read' ? 'read' : e.tool === 'Write' ? 'write' : e.tool === 'Edit' ? 'edit' : 'search', false)

    let failed = true
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
      failed = r.deny !== undefined || r.isError === true
    } finally {
      await update($, nodes, list => list.map(n => (n.id === id ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n)))
    }
    if (path && !failed && (e.tool === 'Edit' || e.tool === 'Write')) {
      const what = e.tool === 'Edit' ? `- ${String(args.old_string ?? '').slice(0, 300)}\n+ ${String(args.new_string ?? '').slice(0, 300)}` : `wrote ${String(args.content ?? '').slice(0, 400)}`
      changes.set(path, [...(changes.get(path) ?? []), what])
      await touch($, path, e.tool === 'Edit' ? 'edit' : 'write', true)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId ?? 'main'
    const failed = e.reason === 'error' || e.reason === 'aborted'
    const isMain = !e.agentId
    // The main turn ending closes everything it left marked running, so the clock can rest.
    await update($, nodes, list => {
      // Only main's own leftovers: a background agent still running keeps its open calls.
      const live = new Set(list.filter(n => n.kind === 'agent' && n.status === 'running' && n.id !== id).map(n => n.id))
      const close = (n: MissionNode) => n.id === id || (isMain && n.kind === 'tool' && !live.has(n.parent ?? ''))
      return list.map(n => (close(n) && n.status === 'running' ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n))
    })
    if (isMain) {
      const t = await read($, turn)
      void explain($, t, new Map(changes)).catch(() => {}) // in the background, so the turn ends at once
    }
    return r
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'code' || arg === 'who') await update($, view, () => arg)
    await $.ui.open({ id: PANE, title: 'Mission Control', focus: true })
    void renderSoon($)
    const s = summary(await read($, nodes))
    return { text: `Mission Control: ${s.agents} agents · ${s.tools} tool calls · ${(await read($, files)).length} files. w: who · c: code · q: close` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, now) // subscribes the pane to the clock
    const v = await read($, view)
    const rows = Math.max(6, (e.props.scroll?.bodyRows ?? 30) - 3)
    const columns = Math.max(20, e.props.bodyColumns)
    const head = (
      <Box flexDirection="row" gap={1}>
        <Button key="who" label="Who" hotkey="w" variant={v === 'who' ? 'primary' : undefined} onPress={() => update($, view, () => 'who')} />
        <Button key="code" label="Code" hotkey="c" variant={v === 'code' ? 'primary' : undefined} onPress={() => void setCode($)} />
        <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    if (v === 'code') {
      if (e.surface !== 'terminal') {
        return (
          <Box flexDirection="column">
            {head}
            <Text dimColor>The code map draws in the terminal.</Text>
          </Box>
        )
      }
      const { Image } = $.ui.resolve(e)
      // A fixed 16:10 shape from the pane's width: lines coming and going above the prompt
      // change the pane's height, and must not resize (and jolt) the picture.
      const imageRows = Math.min(rows, Math.round(columns * 0.3))
      if (draw.size.columns !== columns || draw.size.rows !== imageRows) {
        draw.size = { columns, rows: imageRows }
        void renderSoon($)
      }
      const f = await read($, frame)
      return (
        <Box flexDirection="column">
          {head}
          {f ? (
            <Image key="map" source={{ file: f.file, format: 'png', generation: f.n }} columns={draw.size.columns} rows={draw.size.rows} alt="Code map" />
          ) : (
            <Text dimColor>{draw.error || 'Drawing the code map…'}</Text>
          )}
        </Box>
      )
    }

    const at = Date.now()
    const ls = lines(await read($, nodes), at)
    const s = summary(await read($, nodes))
    return (
      <Box flexDirection="column">
        {head}
        <Text dimColor>{`${s.agents} agents (${s.running} running) · ${s.tools} tool calls${s.failed ? ` · ${s.failed} failed` : ''}`}</Text>
        {ls.length === 0 && <Text dimColor>Nothing yet. Start a task and watch it fill in.</Text>}
        {ls.slice(-rows + 1).map(l => (
          <Text wrap="truncate-end">
            <Text dimColor>{l.prefix}</Text>
            <Text color={l.status === 'running' ? 'yellow' : l.status === 'failed' ? 'red' : l.node.kind === 'tool' ? undefined : 'green'} bold={l.node.kind !== 'tool'} dimColor={l.status === 'done' && l.node.kind === 'tool'}>
              {l.text}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })

  // The band: one summary line while Claude works, and for a short while after.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const list = await read($, nodes)
    const main = list.find(n => n.kind === 'main')
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS)
    if (e.props.hasSurvey || !isRecent || s.tools + s.agents === 0) return rest
    const t = await read($, turn)
    const edited = (await read($, files)).filter(f => f.changedTurn === t).length
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="blue" bold>{' ◈ mission: '}</Text>
          <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}${edited ? ` · ${edited} files changed` : ''}`}</Text>
          <Text dimColor>{'  ·  /mission'}</Text>
        </Text>
        {rest}
      </Box>
    )
  })
}

async function setCode($: EngineInterface) {
  await update($, view, () => 'code')
  await renderSoon($)
}

// Notes a file Claude touched, with the relative imports it has.
async function touch($: EngineInterface, path: string, act: MapFile['act'], isChange: boolean) {
  if (!CODE_FILE.test(path)) return // an image, a PDF, a lockfile: not code to map
  const t = await read($, turn)
  const text = await $.fs.read(path).catch(() => '')
  const imports = typeof text === 'string' ? importsOf(path, text.slice(0, 200_000)) : [] // imports sit near the top
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const next: MapFile = { path, act, at: Date.now(), changedTurn: isChange ? t : (old?.changedTurn ?? 0), imports: imports.length ? imports : (old?.imports ?? []), why: isChange ? undefined : old?.why }
    return [...list.filter(f => f.path !== path), next].sort((a, b) => b.at - a.at).slice(0, MAX_FILES)
  })
  await renderSoon($)
  $.clock.after(5500, () => void renderSoon($).catch(() => {})) // again once the glow has faded
}

// One plain line per changed file, from what changed this turn.
async function explain($: EngineInterface, forTurn: number, edits: Map<string, string[]>) {
  if (edits.size === 0) return
  const paths = [...edits.keys()]
  const plain = (t: string) => t.replace(/[<>"]/g, ' ')
  const body = paths.map((p, i) => `<file n="${i + 1}" name="${plain(p.split('/').slice(-2).join('/'))}">\n${plain((edits.get(p) ?? []).join('\n').slice(0, 1500))}\n</file>`).join('\n')
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 400,
    system: 'For each file, say in plain words what changed, at most 60 characters, no em dashes. Reply with a JSON array of strings only, one per file, in the same order.',
    prompt: `${body}\n\nReply with the JSON array only: ${paths.length} strings.`,
  })
  if (!r.isAnswered) return
  let whys: unknown
  try {
    whys = JSON.parse(r.text.slice(r.text.indexOf('['), r.text.lastIndexOf(']') + 1))
  } catch {
    return
  }
  if (!Array.isArray(whys)) return
  // By position, so nothing has to match a path the model may have rewritten.
  const byPath = new Map(paths.map((p, i) => [p, typeof whys[i] === 'string' ? (whys[i] as string).replace(/\s*—\s*/g, ', ').slice(0, 80) : undefined]))
  // A slow answer from an earlier turn must not label this turn's changes.
  if ((await read($, turn)) !== forTurn) return
  await update($, files, list => list.map(f => (byPath.get(f.path) && f.changedTurn === forTurn ? { ...f, why: byPath.get(f.path) } : f)))
  await renderSoon($)
}

// Draws the code map at most about once a second, only while someone looks at it.
async function renderSoon($: EngineInterface) {
  if (draw.pending) {
    draw.dirty = true // drawing now: draw once more when it is done
    return
  }
  if ((await read($, view)) !== 'code') return
  const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  if (!isUp) return
  draw.pending = true
  draw.dirty = false
  $.clock.after(700, () => {
    void renderMap($)
      .catch(() => {})
      .finally(() => {
        draw.pending = false // only now: two Chromes must never share the profile
        if (draw.dirty) void renderSoon($).catch(() => {})
      })
  })
}

// Headless Chrome writes the screenshot but does not always exit: wait for the file,
// then close that Chrome (its own throwaway profile, never the person's browser).
// POSIX shell on macOS and Linux; a PowerShell script file on Windows, where `sh`
// and `pkill` do not exist. `-File` is used (not `-Command`) because only `-File`
// passes positional arguments into `$args` inside the script.
const SHOT_SH =
  'mkdir -p "$(dirname "$2")"; rm -f "$2"; "$1" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --no-first-run --no-default-browser-check ' +
  '--user-data-dir="$3" --window-size="$4" --screenshot="$2" "$5" >/dev/null 2>&1 & pid=$!; ' +
  'i=0; while [ ! -s "$2" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done; sleep 0.2; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; [ -s "$2" ]'
const SHOT_PS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$dir = Split-Path -Parent $args[2]',
  'if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }',
  'Remove-Item $args[2] -Force',
  // A single argument string, not an array: Start-Process splits arrays on
  // whitespace, which breaks `--screenshot=C:\path with space` into two tokens.
  "$argStr = '--headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --no-first-run --no-default-browser-check --user-data-dir=\"' + $args[3] + '\" --window-size=' + $args[4] + ' --screenshot=\"' + $args[2] + '\" \"' + $args[5] + '\"'",
  '$p = Start-Process -FilePath $args[1] -ArgumentList $argStr -PassThru',
  '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
  'while ((-not (Test-Path $args[2]) -or (Get-Item $args[2]).Length -eq 0) -and $sw.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 100 }',
  'Start-Sleep -Milliseconds 200',
  'if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }',
  'if (Test-Path $args[2]) { exit 0 } else { exit 1 }',
].join('\r\n')

async function renderMap($: EngineInterface) {
  const plat = await platformOf($)
  const chrome = await findBrowser($)
  if (!chrome) {
    draw.error = `The code map needs Google Chrome or Microsoft Edge${plat === 'win32' ? '' : ' (Chromium works too)'}.`
    await update($, now, () => Date.now()) // redraw the pane with the message
    return
  }
  draw.error = ''
  const tmp = plat === 'win32'
    ? ((await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? 'C:/Temp')
    : (await $.env.get('TMPDIR')) ?? '/tmp'
  const dir = `${tmp.replace(/\/+$/, '')}/mission-control`
  const n = ++draw.n
  const width = Math.round(draw.size.columns * 9)
  const height = Math.round(draw.size.rows * 19)
  const svgPath = `${dir}/map.svg`
  const png = `${dir}/map-${n % 2}.png` // two files in turn, so the shown one is never half written
  const userData = `${dir}/chrome-${n % 2}` // same: a profile locked by one run must not block the next
  await $.fs.write(svgPath, svg(await read($, files), { width, height, at: Date.now(), turn: await read($, turn) }))
  const r = plat === 'win32'
    ? await shotWin($, chrome, png, userData, `${width},${height}`, svgPath)
    : await $.process.run(['sh', '-c', SHOT_SH, chrome, png, userData, `${width},${height}`, `file://${encodeURI(svgPath)}`], { timeoutMs: 20_000 })
  if (r.exitCode === 0) await update($, frame, () => ({ file: png, n }))
}

// On Windows the screenshot runs through PowerShell. `-Command` swallows
// positional arguments (they never reach `$args`), so write the script to a
// `.ps1` file and invoke it with `-File`, the only mode that passes them
// through. The script lives in the temp dir, not inside the user-data-dir,
// so Chrome's profile management never touches it.
async function shotWin($: EngineInterface, chrome: string, png: string, userData: string, size: string, svgPath: string) {
  const dir = png.slice(0, png.lastIndexOf('/'))
  const ps = `${dir}/shot.ps1`
  await $.fs.write(ps, SHOT_PS)
  const fileUri = `file:///${svgPath.replace(/\\/g, '/').replace(/^\/?/, '')}`
  return $.process.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, chrome, png, userData, size, fileUri], { timeoutMs: 20_000 })
}
