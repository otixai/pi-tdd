# pi-tdd-harness

Adversarial TDD as a pi extension. Two isolated pi agents play tester
and implementer. The extension is the referee.

- **Red** writes failing tests. Cannot touch source.
- **Blue** makes tests pass. Cannot touch tests.
- Enforcement is a `tool_call` hook in each subprocess — structural, not
  prompted. Blue trying to write a test file is rejected before the
  tool executes.

## How it works

`/tdd <kata-dir>` spawns Red and Blue as separate `pi` subprocesses
per round. Each round:

1. Orchestrator gives Red the spec and the most recent test output.
2. Red runs in its own `pi` process, with `role-hook.ts` blocking any
   write to a non-test path.
3. Red's changes are committed as author `Red (tdd-harness)`.
4. Orchestrator runs the test suite.
5. Blue runs in its own `pi` process, with the same hook blocking any
   write to a test path. Blue sees the failing tests and the spec.
6. Blue's changes are committed as author `Blue (tdd-harness)`.
7. Orchestrator runs the test suite again, records coverage.
8. If tests pass and coverage is at or above the threshold, the run
   ends. Otherwise, the next round starts.

Red and Blue are separate OS processes. Neither can read the other's
system prompt, scratch, or memory. The sandbox is structural, not a
rule the agent is asked to follow.

## Install

This extension lives at `.pi/extensions/tdd/` in your kata root. pi
auto-discovers project-local extensions from that path (subdirectory +
`index.ts`). No install step needed.

To test:

```bash
cd .pi/extensions/tdd && npm install && npm test
```

## Run

From the kata directory:

```bash
pi              # launch pi
/tdd            # run against the current kata (cwd)
/tdd path/to/Java  # run against a specific kata directory
```

Prerequisites:

- The kata directory must be a git repo with at least one commit.
- An Ollama daemon with `qwen3-coder:30b` pulled (`ollama pull
  qwen3-coder:30b`), or another model configured in the per-agent
  config below.
- A supported runner in the kata: `jest` (detected via `package.json`)
  or `maven` (detected via `pom.xml`).

If the working tree is dirty when `/tdd` starts, the orchestrator
commits the current state as author `tdd-harness baseline` so that
per-round diffs stay clean.

## Configuration

Optional file: `.pi/extensions/tdd/config.json`. Environment variables
take precedence over the file, which takes precedence over defaults.

```json
{
  "red":   { "model": "ollama/qwen3-coder:30b", "thinking": "low" },
  "blue":  { "model": "ollama/qwen3-coder:30b", "thinking": "low" },
  "maxRounds": 20,
  "coverageThreshold": 0.95,
  "runner": "auto"
}
```

Environment overrides:

| variable              | effect                                |
| --------------------- | ------------------------------------- |
| `PI_TDD_RED_MODEL`    | Red's `--model` value                  |
| `PI_TDD_BLUE_MODEL`   | Blue's `--model` value                 |
| `PI_TDD_MAX_ROUNDS`   | Integer, overrides `maxRounds`         |
| `PI_TDD_COVERAGE`     | Float in `[0,1]`, overrides threshold  |
| `PI_TDD_RUNNER`       | `jest`, `maven`, or `auto`             |

To run Red and Blue on different models for adversarial diversity:

```bash
PI_TDD_RED_MODEL=openrouter/minimax/minimax-m2.5 \
PI_TDD_BLUE_MODEL=ollama/qwen3-coder:30b \
pi
```

Then `/tdd` inside the pi session.

## Artifacts

Each run writes to `.harness/runs/<iso-ts>/`:

```
round-1-red.diff              # git show HEAD after Red's commit
round-1-blue.diff             # git show HEAD after Blue's commit
round-1-test-output.txt       # full test-runner output
round-1-coverage.json         # normalized coverage [0,1]
round-1-red.stream.jsonl      # pi's --mode json event stream for Red
round-1-blue.stream.jsonl     # pi's --mode json event stream for Blue
round-2-*.*
...
summary.json                  # rounds, exitReason, models, timestamps
```

`exitReason` is one of: `green` (tests pass + coverage met), `cap`
(hit `maxRounds`), `sigint` (user interrupted — harness finishes the
current tool call, then stops), `error` (unexpected failure).

`git log` on the kata will show alternating Red and Blue commits per
round. Blue is provably never the author of a test change — that's the
point.

## Testing the harness itself

```bash
cd .pi/extensions/tdd
npm test              # canary + integration
npm run typecheck
```

The canary test (`test/restrictions.test.ts`) asserts the hook rejects
a Blue write to a test path with a fake `tool_call` event. Without this
test, a refactor could silently flip the predicate and the harness
would stop being adversarial.

The integration test (`test/orchestrator.test.ts`) mocks the subprocess
and the runner, then verifies the round loop writes all expected
artifacts, respects model-per-agent env vars, and exits green when the
mock runner reports passing + adequate coverage.

## Layout

```
.pi/extensions/tdd/
  index.ts                 # registers /tdd slash command
  src/
    command.ts             # orchestrator
    spawn.ts               # pi subprocess launcher + JSON stream
    role-hook.ts           # loaded into each subprocess via -e
    restrictions.ts        # path predicates + tool_call logic
    config.ts              # defaults + file + env
    diff.ts                # git commit + git show per turn
    artifacts.ts           # .harness/runs/<id>/ writer
    runners/
      index.ts             # Runner interface + registry
      jest.ts              # npx jest --coverage
      maven.ts             # mvn -B -q verify + jacoco csv parse
  prompts/
    red.md                 # role prompt for Red
    blue.md                # role prompt for Blue
  test/
    restrictions.test.ts   # canary
    orchestrator.test.ts   # integration
```

## What's not in v1

- pytest, go, cargo runners. The `Runner` interface is extensible.
- Per-round rollback. The harness commits forward-only. Discard by
  resetting the repo.
- UI overlays or dashboards. All state lives in text files.
