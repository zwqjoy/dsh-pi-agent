# DSH 0.2 compatibility port

This branch/fork ports `dsh-pi-agent` from DSH 0.1.x to DSH 0.2.x. The published
0.1.1 release cannot load on 0.2: it imports `Inbox` (removed) and `CallId`
(renamed), appends `assistant/chunk` (event removed), and its resume path uses
the old `sessionPersistence.prepare()` API.

## What changed

| Area | 0.1 implementation | 0.2 implementation |
| --- | --- | --- |
| Call ids | `CallId(...)` from `dsh-llm` | `ToolCallId(...)` |
| Pending input | `new Inbox(session, callbacks)` class from `dsh-agent` | `src/inbox.ts`: agent-owned `Inbox` facade that folds and appends durable `agent/inbox/spliced` events (same event shape the stock loop writes) |
| Live streaming | `assistant/chunk` session events | `agent/assistant-stream` start/chunk/end frames + an `AssistantStreamAccumulator`; the final `assistant/message` embeds the compact `stream` record |
| Assistant message | `sourceEventSeqs` citation | `{ surfaceOp: 'append' }` only (0.2 forbids citing source events for assistant messages) |
| Agent publish | `agents.announce(agent)` + `agent/session-start` | `agents.enter(agent, parentAgent)` then `await agents.announce(agent, source, signal)`; `agent/created` replaces `agent/session-start` |
| Create/resume | `sessionPersistence.prepare()` | `sessionPersistence.create(header)` / `open(id, 'write')` + `handle.read()`; pre-publication events are flushed through the handle before announce |
| Session reads | `session.events` | `session.snapshotEvents()` |
| Subagent capabilities | 4 flags | 5 flags (`agentOptions` added) |

`src/index.ts` is unchanged apart from the peer versions in `package.json`.

## Mounting

The stock `agent-loop` owns the single `ctx.agents` factory slot and 0.2 throws
when a second factory registers. The package therefore ships as a DSH bundle:
`dsh.bundle.patch` points at `dsh.bundle.yml`, whose layer disables the stock
loop and inserts the pi factory.

Install it like any other bundle:

```bash
dsh plugin --profile <name> add dsh-pi-agent
```

`dsh plugin` appends the package to `dsh.profile.bundles`, so the DSH plugin
manager / market lists it as a normal switch. Turning it **off** removes the
package from `dsh.profile.bundles`; the whole layer (both the pi insert and the
`agent-loop` disable) stops applying, and the native loop is back. Turning it
**on** re-adds the layer. A restart — or the host's HMR reload — applies the
change.

Bundle defaults live in `dsh.bundle.yml`; a profile's own `cordis.patch.yml`
can still override `pi-agent` config by id (for example `model` or `cwd`).

The manual equivalent, for profiles without a plugin manager, is the same two
rows copied into `cordis.patch.yml`:

```yaml
- id: agent-loop
  disabled: true

- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config:
        piPath: 'pi'
        # cwd is a fallback only; live sessions use the workspace DSH passes in meta.cwd
        # model is a fallback only; the DSH-selected provider/model wins when present
        debug: true
```

The DSH-selected model route must exist in pi's own provider config
(`~/.pi/agent/models.json`); otherwise pi's `set_model` fails.

## Host integration notes

- The plugin declares the same dependency surface as the stock `AgentLoop`
  (`agents`, `sessions`, `llm`, `tools`, `systemPrompt`, `sessionProjections`).
  Agent scopes inherit that API, and DSH's gateway / agent-preset setup
  callbacks compose prompt sections and tools through those services; declaring
  only `sessions`/`agents` makes every new session fail with
  `cannot get property "systemPrompt" without inject`.
- `piPath` defaults to the bare name `pi`, which is first resolved against the
  common absolute install locations (`/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`). GUI hosts launch with a
  minimal PATH, so a terminal-only `pi` lookup fails with `spawn pi ENOENT`.
  An explicitly configured path always wins.

## Verified

- DSH `0.2.0-rc.2` CLI — headless session and the Web UI (session completed,
  streamed answer rendered, `1 turns 1 steps`) with `agent-loop` disabled.
- DSH `0.2.1-rc.3` CLI — headless session completed, both with the manual
  patch mount and as an installed bundle.
- Bundle toggle semantics: with `dsh-pi-agent` in `dsh.profile.bundles` the
  composed config disables `agent-loop` and inserts `pi-agent`; removing the
  bundle name restores the native `agent-loop` and drops `pi-agent`.
- Desktop-style preset wiring (`agent-preset-registry` default `standard`,
  which is what the app's gateway requests): session creation and a full turn
  complete after the dependency-surface fix, including a preset-composed
  session (`PRESET_PI_OK`).

## Known limitations

- The stock loop also registers the `inbox` / `turnBoundary` session
  projections. This plugin keeps its own inbox state and does not register
  those projections; the tested UIs tolerated their absence, but any plugin
  that calls `sessionProjections.stateOf(session, 'inbox')` on the host gets
  `undefined`.
- DSH prompt assembly and tool surface are bypassed by design (pi keeps its own
  ~300-token prompt and four tools).
- Image blocks are still skipped when rebuilding pi history.

## Rollback

Bundle install: turn `dsh-pi-agent` off in the plugin manager (or remove it
from `dsh.profile.bundles`), then restart DSH. Manual mount: remove the
`pi-agent` insert and the `agent-loop` disable from `cordis.patch.yml`, or
restore the profile's `.bak-*` backups, then restart.
