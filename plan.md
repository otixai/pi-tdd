# Plan — Adversarial TDD Harness (pi extension)

Phase 2. Awaits approval before phase 3.

## Architecture

```
  user types /tdd <kata-dir>
        |
        v
  tdd extension (command handler, in the user's pi session)
        |
        +--round loop (orchestrator)--+
        |                             |
        v                             v
   spawn Red                     spawn Blue
   pi -p --mode json             pi -p --mode json
     --no-extensions               --no-extensions
     -e role-hook.ts               -e role-hook.ts
   PI_TDD_ROLE=red               PI_TDD_ROLE=blue
   PI_TDD_PROMPT=red.md          PI_TDD_PROMPT=blue.md
        |                             |
        v                             v
  writes tests/**                writes src/**
  tool_call blocks               tool_call blocks
  non-test writes                test writes
        |                             |
        +-------- stream json --------+
                   |
                   v
            test runner adapter
            (jest / maven / ...)
                   |
                   v
            coverage + pass/fail
                   |
                   v
            stop check -> next round | done
                   |
                   v
          .harness/runs/<iso>/ artifacts
```

The user is always in their own pi session. `/tdd` is a command in *that*
session. Red and Blue are two separate pi subprocesses spawned by the
command handler. The user sees both agents' streamed output in real time
through the orchestrator's renderer.

## Lever 1 — Context

**Red sees:** the kata spec (e.g. `GildedRoseRequirements.md` / `README`)
and nothing else. No access to the current failing test file. No access
to Blue's scratch.

**Blue sees:** the same kata spec *and* the current content of the test
file Red last wrote. Nothing else.

**Enforcement:** separate subprocesses, each started with `pi -p` and a
prompt assembled by the orchestrator. We do not use `--mode rpc` or pass
a shared session file. Each round constructs fresh prompt strings; no
session is reused across rounds, no session is shared across agents.

API used:
- `pi.exec(command, args, options)` from `ExtensionAPI` (`docs/extensions.md`)
  to launch the `pi` CLI subprocess.
- `--mode json`, `-p`, `--no-extensions`, `-e` CLI flags
  (`packages/coding-agent/README.md`).

## Lever 2 — Tools (structural, not prompted)

Both agents get pi's default four tools (`read`, `write`, `edit`, `bash`).
Restrictions are enforced by a `tool_call` hook in the role-hook extension
that each subprocess loads via `-e`.

**Red's hook** (copied shape of `examples/extensions/protected-paths.ts`,
inverted predicate):

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "write" || event.toolName === "edit") {
    const p = String(event.input.path);
    if (!isInsideTests(p)) return { block: true, reason: `Red may only write tests/**, got: ${p}` };
  }
  if (event.toolName === "bash" && bashEscapesTestTree(event.input.command)) {
    return { block: true, reason: "Red's bash may not touch files outside tests/**" };
  }
  return undefined;
});
```

**Blue's hook:** the inverse — reject writes/edits to `tests/**` or any
`**/*.test.*` / `**/*Test.java` / `**/test/**` path, and reject bash that
mutates those trees.

Return shape `{ block: true, reason: string }` is verbatim from
`examples/extensions/protected-paths.ts`. This runs *before* the tool
executes (`docs/extensions.md`: "**tool_call**: Pre-execution (can block,
mutate arguments)").

**Bash policy details** — the bash hole closes by parsing the command
with `shell-quote` (conservative: if we can't parse, we reject) and
checking every token that looks like a path. Rejected operations:
`mv`/`cp`/`rm`/`sed -i`/`>`/`>>`/`tee` into the forbidden tree;
`git add/checkout/reset` targeting forbidden paths.

**Read is not restricted.** Both agents may read anywhere — restricting
reads would break legitimate exploration (e.g. Blue reading the test
file to understand what to implement).

## Lever 3 — Role

Two markdown files, one per role, not inline strings. Convention mirrors
the first-party `examples/extensions/subagent/agents/*.md` layout.

- `.pi/extensions/tdd/prompts/red.md`
- `.pi/extensions/tdd/prompts/blue.md`

Each subprocess injects its role prompt via the role-hook extension,
which subscribes to `before_agent_start` (`docs/extensions.md`:
"**before_agent_start**: Modify system prompt or inject messages before
LLM call"). The hook reads the path from env var `PI_TDD_PROMPT` and
replaces the system prompt with that file's contents.

**Fallback if `before_agent_start` mutation shape is stricter than the
public doc suggests:** write the role prompt into a per-run temp
directory as `.pi/SYSTEM.md` (project-scope system prompt replacement
per `packages/coding-agent/README.md`) and `cwd` the subprocess there.
Phase 3 starts with the `before_agent_start` approach and falls back
only if the API rejects mutation; we'll verify by reading
`packages/coding-agent/src/` once we clone it locally.

Role prompts are short. Red's tells it: the kata spec is in `<path>`,
write a failing test suite in `tests/`, do not implement. Blue's tells
it: tests in `<path>` are failing, make them pass by editing source,
do not touch tests. Neither prompt describes the other agent or the
orchestrator. They do not know they are in a red/blue harness.

## Lever 4 — Stop

Orchestrator loop. First condition wins:

1. All tests pass *and* coverage ≥ threshold (default 0.95, configurable
   via `config.coverageThreshold`).
2. Round cap reached (default 20, configurable via `config.maxRounds`).
3. SIGINT received. **Semantics (confirmed):** let the currently-running
   subprocess finish its in-flight tool call, then terminate. Orchestrator
   installs a `SIGINT` listener that flips a flag; between tool events
   (streamed via `--mode json`) it sends `SIGTERM` to the child at the
   next tool-call boundary. Partial artifacts for the in-progress round
   are written with `partial: true` in `summary.json`.

Exit reasons recorded in `summary.json.exitReason`: `"green"`, `"cap"`,
`"sigint"`, `"error"`.

## File layout

```
.pi/extensions/tdd/
  index.ts                       # default export: extension factory
  src/
    command.ts                   # registerCommand("/tdd") + orchestrator
    spawn.ts                     # subprocess launcher (pi -p --mode json ...)
    jsonStream.ts                # line-delimited JSON event parser
    restrictions.ts              # shared path predicates
    red-hook.ts                  # installed into Red subprocess via -e
    blue-hook.ts                 # installed into Blue subprocess via -e
    config.ts                    # loader: defaults + file + env
    artifacts.ts                 # round-<N>-*.* writer
    runners/
      index.ts                   # Runner interface + registry
      jest.ts                    # npx jest --coverage --json
      maven.ts                   # mvn test + jacoco
      # phase 3 ships jest + maven; others added on demand
  prompts/
    red.md
    blue.md
  package.json                   # deps: shell-quote only (everything else
                                 # from pi's peer deps)
  README.md                      # install, invoke, config, artifacts
  test/
    restrictions.test.ts         # CANARY (see below)
    integration.test.ts          # 2-round toy loop

.harness/                        # created per-run; git-ignored
  runs/
    2026-04-23T10-00-00Z/
      round-1-red.diff
      round-1-blue.diff
      round-1-test-output.txt
      round-1-coverage.json
      round-2-*.*
      summary.json
```

## Config

`.pi/extensions/tdd/config.json` (optional), merged over defaults, env
overrides take precedence:

```json
{
  "red":   { "model": "ollama/qwen3-coder", "thinking": "low" },
  "blue":  { "model": "ollama/qwen3-coder", "thinking": "low" },
  "maxRounds": 20,
  "coverageThreshold": 0.95,
  "runner": "auto",
  "testsRoot": "auto",
  "srcRoots": "auto"
}
```

Env overrides: `PI_TDD_RED_MODEL`, `PI_TDD_BLUE_MODEL`, `PI_TDD_MAX_ROUNDS`,
`PI_TDD_COVERAGE`, `PI_TDD_RUNNER`.

`runner: "auto"` detects: `package.json` with jest → `jest`; `pom.xml` →
`maven`; else: command fails with instructions to set `runner`
explicitly. `testsRoot`/`srcRoots` = `"auto"` uses per-runner defaults
(jest: `__tests__` or `test/`; maven: `src/test/**`, `src/main/**`).

Default models (`ollama/qwen3-coder` per your call). Adversarial
diversity knob exists — you can flip one side to a different model
(e.g. `openrouter/minimax/minimax-m2.5`) by editing `config.json`.

## CLI flow (what happens when you type `/tdd Java`)

1. `tdd/index.ts` registers the `tdd` command at extension-load time.
2. User types `/tdd Java` in their own pi session.
3. Command handler resolves the kata dir, detects the runner, loads
   config, creates `.harness/runs/<iso>/`.
4. Handler prints a one-line banner: `TDD harness: Red=<model>,
   Blue=<model>, runner=<x>, threshold=<y>, cap=<z>`.
5. **Round loop** — for N in 1..cap:
   - Spawn Red: `pi -p "<red task>" --mode json --no-extensions
     -e <red-hook.ts> --cwd <kata>` with env `PI_TDD_PROMPT=red.md`,
     `PI_TDD_ROLE=red`.
   - Stream Red's events to the user's TUI and to
     `round-N-red.stream.jsonl`. Capture the diff of `tests/**` → `round-N-red.diff`.
   - Spawn Blue symmetrically. Capture diff of non-test paths.
   - Run the test runner via its adapter. Write `round-N-test-output.txt`
     and `round-N-coverage.json`.
   - Evaluate stop. If green: write `summary.json`, done. If cap: done.
     Else: next round.
6. On SIGINT at any point: set shutdown flag, wait for current child's
   in-flight tool call to complete (observed via `tool_execution_end`
   event from `--mode json` stream), send `SIGTERM`, write partial
   artifacts + `summary.json` with `exitReason: "sigint"`.

The user sees a continuous stream — Red turn, Blue turn, test output,
repeat — all in their existing pi session. Nothing is hidden. Matches
pi's anti-subagent philosophy (Nov 30 blog: no opaque black boxes).

## Artifacts

Per-round, per your spec:
- `round-<N>-red.diff` — `git diff` of `tests/**` after Red's turn
- `round-<N>-blue.diff` — `git diff` of non-test paths after Blue's turn
- `round-<N>-test-output.txt` — raw runner output
- `round-<N>-coverage.json` — normalized `{ lines, branches, functions,
  statements }` as decimals in [0,1]
- `round-<N>-red.stream.jsonl`, `round-<N>-blue.stream.jsonl` — raw
  pi event streams for post-mortem

Final:
- `summary.json` — `{ rounds, exitReason, finalCoverage, passing,
  redModel, blueModel, startedAt, endedAt, partial: boolean,
  sigintAt?: string }`

## Tests

**Canary (unit, one file).** `test/restrictions.test.ts` builds a fake
`tool_call` event (`{ toolName: "write", input: { path: "src/Foo.java" }}`)
and asserts Blue's hook returns `{ block: true }`. Also asserts Red's
hook rejects a write to `src/**`, rejects a bash `echo x > src/Foo.java`,
and allows a write to `src/test/java/FooTest.java`. This is the single
canary — without it, a refactor silently turns the harness into a
cooperative one.

**Integration (one file).** `test/integration.test.ts` spins a
throwaway directory containing a trivial spec (`sum(a,b)==a+b`), a
jest config, and an empty source file. Runs the orchestrator with
`maxRounds: 2` and tiny model-off stubs (provider swapped to a fake
that emits pre-canned tool calls via pi's custom-provider extension
mechanism, `pi.registerProvider` — `docs/extensions.md`). Asserts: the
loop terminates, Red's diff touches only `tests/**`, Blue's diff
touches only non-test paths, `summary.json` is well-formed.

The integration test does not hit the network or a real LLM. It
verifies wiring, not agent quality. Quality is verified by the
Gilded Rose smoke test in phase 4.

## What's in scope vs. out

**In:** extension structure, `/tdd` command, Red/Blue subprocess
spawn, `tool_call` enforcement, `before_agent_start` role injection
(with SYSTEM.md fallback), jest + maven runners, config loader,
artifact writer, canary + integration tests, README.

**Out (phase 3 ships without):** pytest/go/cargo runners, per-round
git checkpoint/rollback, coverage diffing between rounds, UI overlays,
a web dashboard. All are additive — the runner registry and event
streams support them later.

## Presentation flow (what you show the room)

1. `cat .pi/extensions/tdd/prompts/red.md` — 10 lines, terse.
2. `cat .pi/extensions/tdd/prompts/blue.md` — 10 lines, terse.
3. `cat .pi/extensions/tdd/src/red-hook.ts` — 30 lines, the enforcement.
   "This is why Blue cannot cheat."
4. `pi` → `/tdd Java` → scroll through round 1: Red writes tests,
   Blue writes code, tests run, round 2.
5. `ls .harness/runs/<iso>/` — per-round diffs, the paper trail.
6. `git log tests/` — only Red's commits. "I didn't touch tests."

## Open items — flagged, not blocking phase 3

- `before_agent_start` exact mutation shape — verified by reading
  `packages/coding-agent/src/` first thing in phase 3. If the public
  doc is aspirational, fall back to SYSTEM.md-in-cwd.
- Ollama model id string format — confirmed by `pi --list-models`
  at phase 3 start (your `.pi/agent/models.json` uses key `ollama`,
  so `ollama/qwen3-coder` is expected).
- Windows support — not targeted. macOS + Linux only.

---

**Requesting approval to start phase 3.**
