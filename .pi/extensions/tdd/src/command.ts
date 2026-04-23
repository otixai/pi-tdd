import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createRunRoot, streamFilePath, writeRoundArtifacts, writeSummary } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { commitPathspecs, hasCommits, isGitRepo, workingTreeIsClean } from "./diff.js";
import { detectRunner, getRunner, type Runner, type RunnerResult } from "./runners/index.js";
import { spawnPi } from "./spawn.js";

const RED_AUTHOR = { name: "Red (tdd-harness)", email: "red@tdd-harness.local" };
const BLUE_AUTHOR = { name: "Blue (tdd-harness)", email: "blue@tdd-harness.local" };
const BASELINE_AUTHOR = { name: "tdd-harness baseline", email: "baseline@tdd-harness.local" };

const SPEC_CANDIDATES = [
	"GildedRoseRequirements.md",
	"REQUIREMENTS.md",
	"SPEC.md",
	"README.md",
	"README",
	"requirements.md",
	"spec.md",
];

function findSpec(kataDir: string): { specPath: string; content: string } | undefined {
	const searchDirs = [kataDir, path.dirname(kataDir), path.dirname(path.dirname(kataDir))];
	for (const dir of searchDirs) {
		for (const name of SPEC_CANDIDATES) {
			const p = path.join(dir, name);
			if (existsSync(p)) return { specPath: p, content: readFileSync(p, "utf8") };
		}
	}
	return undefined;
}

function loadRolePrompt(role: "red" | "blue"): { promptPath: string; content: string } {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const promptPath = path.join(here, "..", "prompts", `${role}.md`);
	const content = readFileSync(promptPath, "utf8");
	return { promptPath, content };
}

function formatCoverage(r: RunnerResult): string {
	const c = r.coverage;
	if (!c) return "coverage: n/a";
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	return `lines=${pct(c.lines)} branches=${pct(c.branches)} functions=${pct(c.functions)} statements=${pct(c.statements)}`;
}

function truncate(s: string, max = 4000): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function buildRedPrompt(
	kataDir: string,
	spec: string,
	runnerName: string,
	testPathspecs: string[],
	round: number,
	maxRounds: number,
	previousTestOutput: string,
): string {
	return [
		`Kata directory: ${kataDir}`,
		`Runner: ${runnerName}`,
		`Tests should live under one of: ${testPathspecs.join(", ")}`,
		`Round: ${round} of ${maxRounds}`,
		"",
		"Specification to satisfy:",
		"<<<SPEC",
		spec,
		"SPEC>>>",
		"",
		"Current test-run output (may be empty in round 1):",
		"<<<OUTPUT",
		truncate(previousTestOutput) || "(no previous output)",
		"OUTPUT>>>",
		"",
		"Task: write or extend tests so the suite covers the spec. Add failing tests that expose gaps. You may only write to test files. Do not change source code.",
	].join("\n");
}

function buildBluePrompt(
	kataDir: string,
	spec: string,
	runnerName: string,
	srcPathspecs: string[],
	round: number,
	maxRounds: number,
	failingTestOutput: string,
): string {
	return [
		`Kata directory: ${kataDir}`,
		`Runner: ${runnerName}`,
		`Source lives under: ${srcPathspecs.filter((s) => !s.startsWith(":(")).join(", ")}`,
		`Round: ${round} of ${maxRounds}`,
		"",
		"Specification:",
		"<<<SPEC",
		spec,
		"SPEC>>>",
		"",
		"Failing tests produced by the test agent:",
		"<<<OUTPUT",
		truncate(failingTestOutput),
		"OUTPUT>>>",
		"",
		"Task: edit source code to make the failing tests pass without changing any test file. You may not write or edit anything under a test path.",
	].join("\n");
}

export interface OrchestratorDeps {
	spawn: typeof spawnPi;
	getRunner: (name: Runner["name"]) => Promise<Runner>;
}

export const defaultDeps: OrchestratorDeps = {
	spawn: spawnPi,
	getRunner,
};

export interface RunOptions {
	kataDir: string;
	ctx?: ExtensionCommandContext;
	now?: Date;
}

function log(ctx: ExtensionCommandContext | undefined, msg: string): void {
	if (ctx?.hasUI) {
		ctx.ui.notify(msg, "info");
	} else {
		process.stdout.write(`[tdd] ${msg}\n`);
	}
}

export async function runHarness(opts: RunOptions, deps: OrchestratorDeps = defaultDeps): Promise<void> {
	const { kataDir, ctx } = opts;
	const absKata = path.resolve(kataDir);
	const config = loadConfig(absKata);
	const runnerName = config.runner === "auto" ? detectRunner(absKata) : config.runner;
	if (!runnerName) {
		throw new Error(`Could not detect runner in ${absKata}. Set runner explicitly in config.`);
	}
	const runner = await deps.getRunner(runnerName);
	const spec = findSpec(absKata);
	if (!spec) {
		throw new Error(`Could not find a spec file (looked for ${SPEC_CANDIDATES.join(", ")}) in ${absKata} or parents.`);
	}
	const redPrompt = loadRolePrompt("red");
	const bluePrompt = loadRolePrompt("blue");

	const root = createRunRoot(absKata, opts.now ?? new Date());
	const startedAt = new Date().toISOString();

	log(
		ctx,
		`tdd: run ${root.runId} | runner=${runner.name} | red=${config.red.model} | blue=${config.blue.model} | threshold=${config.coverageThreshold} | cap=${config.maxRounds}`,
	);

	if (!(await isGitRepo(absKata))) {
		throw new Error(`${absKata} is not a git repository. Run \`git init\` or run /tdd from a git repo.`);
	}
	if (!(await hasCommits(absKata))) {
		throw new Error(`${absKata} has no commits. Make at least one commit before running /tdd.`);
	}
	if (!(await workingTreeIsClean(absKata))) {
		log(ctx, "working tree is dirty: committing current state as tdd-harness baseline");
		await commitPathspecs({
			cwd: absKata,
			pathspecs: ["."],
			authorName: BASELINE_AUTHOR.name,
			authorEmail: BASELINE_AUTHOR.email,
			message: `tdd: baseline for run ${root.runId}`,
		});
	}

	const abortCtl = new AbortController();
	const onSigint = () => {
		log(ctx, "SIGINT received: will stop after current tool call finishes");
		abortCtl.abort();
	};
	process.on("SIGINT", onSigint);

	let lastResult: RunnerResult = { passing: false, output: "(no tests run yet)", coverage: undefined };
	let exitReason: "green" | "cap" | "sigint" | "error" = "cap";
	let rounds = 0;
	let lastError: string | undefined;

	try {
		for (let round = 1; round <= config.maxRounds; round++) {
			if (abortCtl.signal.aborted) {
				exitReason = "sigint";
				break;
			}
			rounds = round;
			log(ctx, `round ${round}: Red turn`);

			const redUser = buildRedPrompt(
				absKata,
				spec.content,
				runner.name,
				runner.testPathspecs,
				round,
				config.maxRounds,
				lastResult.output,
			);
			await deps.spawn(
				{
					role: "red",
					kataDir: absKata,
					systemPromptPath: redPrompt.promptPath,
					userPrompt: redUser,
					model: config.red.model,
					thinking: config.red.thinking,
					streamFile: streamFilePath(root, round, "red"),
					signal: abortCtl.signal,
					onEvent: (line) => forwardEventToUi(ctx, "red", line),
				},
				redPrompt.content,
			);

			const redCommit = await commitPathspecs({
				cwd: absKata,
				pathspecs: runner.testPathspecs,
				authorName: RED_AUTHOR.name,
				authorEmail: RED_AUTHOR.email,
				message: `round ${round}: Red tests`,
			});
			const redDiff = redCommit.diff;

			if (abortCtl.signal.aborted) {
				exitReason = "sigint";
				writeRoundArtifacts(root, round, {
					redDiff,
					blueDiff: "",
					testOutput: "(round interrupted after Red)",
					coverage: undefined,
					passing: false,
				});
				break;
			}

			log(ctx, `round ${round}: running tests after Red`);
			const postRed = await runner.run(absKata, abortCtl.signal);

			log(ctx, `round ${round}: Blue turn`);
			const blueUser = buildBluePrompt(
				absKata,
				spec.content,
				runner.name,
				runner.srcPathspecs,
				round,
				config.maxRounds,
				postRed.output,
			);
			await deps.spawn(
				{
					role: "blue",
					kataDir: absKata,
					systemPromptPath: bluePrompt.promptPath,
					userPrompt: blueUser,
					model: config.blue.model,
					thinking: config.blue.thinking,
					streamFile: streamFilePath(root, round, "blue"),
					signal: abortCtl.signal,
					onEvent: (line) => forwardEventToUi(ctx, "blue", line),
				},
				bluePrompt.content,
			);

			const blueCommit = await commitPathspecs({
				cwd: absKata,
				pathspecs: runner.srcPathspecs,
				authorName: BLUE_AUTHOR.name,
				authorEmail: BLUE_AUTHOR.email,
				message: `round ${round}: Blue implementation`,
			});
			const blueDiff = blueCommit.diff;

			log(ctx, `round ${round}: running final tests`);
			const endResult = await runner.run(absKata, abortCtl.signal);
			lastResult = endResult;

			writeRoundArtifacts(root, round, {
				redDiff,
				blueDiff,
				testOutput: endResult.output,
				coverage: endResult.coverage,
				passing: endResult.passing,
			});

			log(ctx, `round ${round}: ${endResult.passing ? "passing" : "failing"} | ${formatCoverage(endResult)}`);

			const coverageOk = !!endResult.coverage && endResult.coverage.lines >= config.coverageThreshold;
			if (endResult.passing && coverageOk) {
				exitReason = "green";
				break;
			}
		}
	} catch (err) {
		exitReason = "error";
		lastError = err instanceof Error ? err.message : String(err);
		log(ctx, `error: ${lastError}`);
	} finally {
		process.off("SIGINT", onSigint);
		const endedAt = new Date().toISOString();
		writeSummary(root, {
			rounds,
			exitReason,
			finalCoverage: lastResult.coverage,
			passing: lastResult.passing,
			redModel: config.red.model,
			blueModel: config.blue.model,
			startedAt,
			endedAt,
			partial: exitReason === "sigint" || exitReason === "error",
			sigintAt: exitReason === "sigint" ? new Date().toISOString() : undefined,
			error: lastError,
		});
		log(ctx, `run ${root.runId}: ${exitReason} after ${rounds} round(s). Artifacts in ${root.dir}`);
	}
}

function forwardEventToUi(ctx: ExtensionCommandContext | undefined, role: "red" | "blue", line: string): void {
	if (!ctx?.hasUI) return;
	try {
		const parsed = JSON.parse(line) as { type?: string; toolName?: string; text?: string };
		if (parsed.type === "tool_call" && parsed.toolName) {
			ctx.ui.notify(`${role}: ${parsed.toolName}`, "info");
		} else if (parsed.type === "message_end" && typeof parsed.text === "string") {
			ctx.ui.notify(`${role}: ${truncate(parsed.text, 120)}`, "info");
		}
	} catch {
	}
}
