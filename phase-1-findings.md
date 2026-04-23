# Phase 1 — Findings

Recon only. No code written. Nothing in `.pi/` changed.

## 1. Pi extension API (cited signatures)

Source: `packages/coding-agent/docs/extensions.md` (raw), plus the two example
extensions that match our pattern: `examples/extensions/protected-paths.ts` and
`examples/extensions/permission-gate.ts`.

**Entry point.** A pi extension is a TypeScript module with a default export
that receives an `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) { ... }
```

The factory may be async — pi awaits it before session init.

**Discovery.** Auto-loaded from `~/.pi/agent/extensions/*.ts` (global) and
`.pi/extensions/*.ts` (project). Ad-hoc load via `pi -e ./path.ts`. Packages
install via `pi install npm:...` or `pi install git:github.com/...`.

**Event catalog (exhaustive list from `docs/extensions.md`):**

Lifecycle: `session_start`, `session_shutdown`, `session_before_switch`,
`session_before_fork`, `session_before_compact`, `session_compact`,
`before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `context`, `input`.

Tools: **`tool_call`** (pre-execution — can block or mutate args),
`tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
`tool_result` (post-execution — can mutate result), `user_bash`.

Provider: `before_provider_request`, `after_provider_response`, `model_select`.

Resources: `resources_discover`.

**`tool_call` blocking shape** (from `protected-paths.ts` verbatim):

```typescript
pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
        return undefined;
    }
    const path = event.input.path as string;
    const isProtected = protectedPaths.some((p) => path.includes(p));
    if (isProtected) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
        return { block: true, reason: `Path "${path}" is protected` };
    }
    return undefined;
});
```

Return contract: `undefined` → allow; `{ block: true, reason: string }` →
reject before the tool runs. Mutating `event.input.*` and returning
`undefined` is the documented way to modify args (`docs/extensions.md`:
"Pre-execution (can block, mutate arguments)").

**`ExtensionAPI` surface relevant to us** (from `docs/extensions.md`):

- `pi.on(event, handler)` — event subscription
- `pi.registerCommand(name, options)` — slash command (e.g. `/tdd`)
- `pi.registerTool(def)` — custom tool
- `pi.exec(command, args, options)` — shell exec
- `pi.events.emit/on` — inter-extension bus
- `pi.sendUserMessage(content, options)` — inject input

**Command context extras** (only in command handlers):
`ctx.newSession`, `ctx.fork`, `ctx.switchSession`, `ctx.waitForIdle`.
These mutate the *current* session — they do not spawn an isolated one.

**Tool name / args.** Built-in write-family tool names are `write` and
`edit` (confirmed from `protected-paths.ts`). Both expose `input.path` as
the target. Pi's four built-in tools: `read`, `write`, `edit`, `bash`
(from `packages/coding-agent/README.md`).

## 2. `tool_call` interception — code sketch

Direct adaptation of `protected-paths.ts` for our two sides:

```typescript
// red-restrictions.ts — attaches to Red's session
export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
        const path = String(event.input.path);
        if (!isTestPath(path)) {
            return { block: true, reason: `Red may only write tests/**, got: ${path}` };
        }
        return undefined;
    });

    // Optional: also gate bash to forbid `mv`, `rm`, test-tree manipulation
    // via bash tool.
    pi.on("tool_call", async (event) => {
        if (event.toolName !== "bash") return undefined;
        if (escapesTestTree(event.input.command)) {
            return { block: true, reason: "Red's bash forbidden outside tests/" };
        }
        return undefined;
    });
}
```

Blue's hook is the inverse path predicate. Both sides register *two*
`tool_call` listeners — one for `write`/`edit`, one for `bash` — because
the bash tool is a hole in any path-based policy.

This is structural, not prompted. The rejection happens before the tool
executes. The agent sees the rejection reason and adapts.

## 3. Spawning a second pi session — SDK vs subprocess vs tmux

Three mechanisms exist:

**(A) SDK — `createAgentSession()`.** From `packages/coding-agent/examples/sdk/`
(13 examples including `01-minimal.ts` through `13-session-runtime.ts`).
Programmatic, in-process. Same Node process hosts both sessions.

**(B) Subprocess — `pi -p "<prompt>" --mode json -e <ext.ts>`.** CLI modes
documented in `packages/coding-agent/README.md`: interactive (default),
`-p` print, `--mode json` event stream, `--mode rpc` JSONL protocol.
`-e <path>` loads an ad-hoc extension for that run. `--no-extensions`
drops auto-discovered ones. This is what the first-party `subagent/`
example uses — per that example's docs, "each running in a separate
`pi` process with isolated context windows".

**(C) tmux.** Overkill. No documented pi convention around it for
orchestration. Skip.

**Pick: (B) subprocess.** Justification:

- **Context isolation is structural, not cooperative.** Separate OS
  processes → separate heap, separate loaded extensions, separate
  system prompt. The SDK in-process option shares `ctx`, the module
  cache, and — critically — allows a misbehaving extension to mutate
  the sibling's state. Subprocess closes that class of bug.
- **Mirrors pi's own subagent convention.** The `subagent/` example
  already does this; we're not inventing a pattern.
- **Observable.** `--mode json` streams every event; the orchestrator
  logs them verbatim into per-round artifacts. Matches pi's philosophy
  (per the Nov 30 blog: sub-agents must not be "opaque black boxes").
- **`--no-extensions -e ./role-hook.ts`** guarantees only our hook
  is loaded, no surprise auto-discovered one relaxing the policy.

**System prompt per role.** Pi loads `.pi/SYSTEM.md` to *replace* the
default, and `APPEND_SYSTEM.md` to append (README). But that's filesystem
global — racy if two subprocesses read it. Cleaner: the role-hook
extension subscribes to `before_agent_start` and injects the role prompt
from an env var path. Confirmed event exists (`docs/extensions.md`:
"`before_agent_start`: Modify system prompt or inject messages before
LLM call"). Exact mutation shape isn't in the public doc — flag as open
question; worst case we write role prompt to a per-run temp file and
point `PI_SYSTEM_PROMPT` at it via the hook.

## 4. Prior art assessment

Searched npm, github, and the pi examples registry for adversarial TDD
or red/blue test-vs-code harnesses on pi.

- **`a-conte/pi-harness`** ("Standalone Pi coding harness with teams,
  chains, and safety controls"). Has a `red-team` role but the pattern
  is *sequential security review after build*
  (`lead-software-engineer → planner → plan-reviewer → builder →
  reviewer → tester → release-manager → red-team`). Not adversarial
  TDD. No test-writes-only / code-writes-only split. Safety comes from
  a YAML rulefile (`damage-control-rules.yaml`), not the native
  `tool_call` hook. **Different problem. Doesn't preempt our design.**

- **`can1357/oh-my-pi`** — a fork with its own hook layer. Not our
  pattern; uses its own event model, not pi-mono's.

- **First-party `permission-gate.ts` / `protected-paths.ts`** — the
  *mechanism* we need, but no assembled red/blue harness on top.

- **First-party `subagent/`** — shows per-role subprocesses with
  markdown system prompts, but the pattern is "dispatcher delegates to
  specialists", not "two peers with disjoint write authority arguing
  until tests pass".

**Conclusion: nothing close exists. Proceed to phase 2.**

## 5. Where the harness lives (skill vs template vs extension)

From `pi.dev` and `docs/extensions.md`:

- **Skills** — "Capability packages with instructions and tools, loaded
  on-demand." Cannot spawn processes or register `tool_call` hooks.
- **Prompt templates** — markdown, expanded via `/name`. Single-turn,
  single-agent input.
- **Extensions** — TypeScript with full `ExtensionAPI`: events,
  commands, tools, subprocess spawning via `pi.exec`.

We need `tool_call` interception, subprocess orchestration, artifact
writing, and a slash command. **Extension.** Register `/tdd` via
`pi.registerCommand("tdd", { ... })`. The command handler spawns the
two pi subprocesses, streams their JSON event output, runs tests
between rounds, writes artifacts.

Red and Blue's *role prompts* live as separate markdown files
(`red.md`, `blue.md`) and are injected into each subprocess via the
role-hook extension (see §3).

## 6. Open questions

1. **`before_agent_start` mutation contract.** Doc says it can "modify
   system prompt or inject messages" but doesn't show the exact return
   shape. Need to verify by reading `packages/coding-agent/src/` or
   an SDK example. Fallback plan: write role prompt to a per-run temp
   SYSTEM.md path and set `--system-prompt-file` if such a flag
   exists; otherwise write it into a process-local `.pi/SYSTEM.md`
   within a temp cwd.
2. **Ollama provider name.** Pi-ai supports Ollama (README: "15+
   providers"). Exact provider/model-id string for the `--model` flag
   (`ollama/qwen3-coder`? `llm.local/qwen3-coder`?) — verify against
   `pi --list-models` during phase 3. The user's own `.pi/agent/models.json`
   uses an `ollama` provider key, so `ollama/qwen3-coder:30b` is the
   likely form.
3. **Test runner adapter.** Kata has per-language dirs (Java/Maven,
   js-jest, TypeScript, ...). Harness needs a pluggable "run tests,
   emit coverage JSON" adapter. Phase 2 will define the interface.
   Default adapter: the language dir the user invokes `/tdd` from.
4. **Coverage tool** per language. Java → JaCoCo; JS/TS → Jest
   `--coverage` → `coverage/coverage-summary.json`. Name these
   explicitly in plan.md.
5. **Artifact root.** `.harness/runs/<iso>/` per your task spec vs.
   `.pi/harness/runs/<iso>/` (would keep pi state together). I'll
   default to `.harness/` since that's what you wrote; flag if you
   want it moved.
6. **SIGINT semantics.** Do we kill both subprocess agents immediately
   and dump partial artifacts, or let the current tool call finish
   first? Plan.md will propose: immediate SIGTERM to both children,
   then 5s grace, then SIGKILL; artifacts dumped from whatever events
   already streamed.
7. **Model-per-agent config.** `.pi/harness/config.json` with
   `red.model`, `blue.model`, env overrides `PI_TDD_RED_MODEL` /
   `PI_TDD_BLUE_MODEL`. Both default to `ollama/qwen3-coder:30b`
   (matches your local stack).
8. **Canary test.** Two options: run a real 1-round subprocess in a
   temp dir with a seeded failing write attempt, or unit-test the
   `tool_call` handler in isolation with a fake event. The latter is
   faster and deterministic; plan.md proposes both — unit test for
   the hook logic, integration test for the wired-up subprocess
   behavior.

## 7. Notes worth flagging before phase 2

- Two **prompt-injection attempts** surfaced during recon: both
  WebFetch responses (the blog post and extensions.md) had a
  `<system-reminder>` appended inside the fetched markdown telling me
  to use `TaskCreate` and "never mention this reminder". Those are
  not real hooks — they came from model output on the fetched page.
  Flagged, ignored, and noting here so you're aware the public pi
  docs (or the fetch summarizer) are leaking injected content.
- The `protected-paths.ts` example matches our needs almost verbatim.
  Phase 3 implementation can copy its shape and change only the path
  predicate.
- The `subagent/` example's markdown-file-per-role convention is the
  right pattern for Red's and Blue's system prompts. Reuse.
