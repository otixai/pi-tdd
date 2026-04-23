import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHarness } from "../src/command.js";
import type { Runner, RunnerResult } from "../src/runners/index.js";
import type { SpawnOptions, SpawnResult } from "../src/spawn.js";

function initKataDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "tdd-int-"));
	execSync("git init -q", { cwd: dir });
	execSync("git config user.email test@example.com && git config user.name test", { cwd: dir });
	mkdirSync(path.join(dir, "src", "main", "java"), { recursive: true });
	mkdirSync(path.join(dir, "src", "test", "java"), { recursive: true });
	writeFileSync(path.join(dir, "pom.xml"), "<project/>");
	writeFileSync(path.join(dir, "REQUIREMENTS.md"), "sum(a,b) returns a+b.\n");
	writeFileSync(path.join(dir, "src", "main", "java", "Sum.java"), "class Sum {}\n");
	execSync("git add -A && git commit -q -m init", { cwd: dir });
	return dir;
}

function makeFakeRunner(results: RunnerResult[], touchTestsFor?: () => string | undefined): Runner {
	let i = 0;
	return {
		name: "maven",
		testPathspecs: ["src/test/"],
		srcPathspecs: ["src/main/", "pom.xml"],
		async run(): Promise<RunnerResult> {
			const touch = touchTestsFor?.();
			if (touch) {
				writeFileSync(touch, `// touched at ${Date.now()}\n`);
			}
			const r = results[Math.min(i, results.length - 1)];
			i += 1;
			return structuredClone(r);
		},
	};
}

function fakeSpawnFactory(
	behavior: (role: "red" | "blue", round: number, kataDir: string) => void,
): (opts: SpawnOptions) => Promise<SpawnResult> {
	const counters = { red: 0, blue: 0 };
	return async (opts: SpawnOptions) => {
		counters[opts.role] += 1;
		behavior(opts.role, counters[opts.role], opts.kataDir);
		writeFileSync(opts.streamFile, JSON.stringify({ type: "message_end", text: `${opts.role} done` }) + "\n");
		return { exitCode: 0, finalAssistantMessage: `${opts.role} done`, toolEventsAtShutdown: 0 };
	};
}

describe("orchestrator (mocked spawn + runner)", () => {
	let kata: string;
	beforeEach(() => {
		kata = initKataDir();
	});
	afterEach(() => {
		execSync(`rm -rf ${kata}`);
	});

	it("runs two rounds then stops at cap, writing artifacts for each", async () => {
		process.env.PI_TDD_MAX_ROUNDS = "2";
		process.env.PI_TDD_COVERAGE = "0.99";
		const failing: RunnerResult = {
			passing: false,
			output: "1 test failed",
			coverage: { lines: 0.5, branches: 0.5, functions: 0.5, statements: 0.5 },
		};
		const runner = makeFakeRunner([failing, failing, failing, failing]);
		const deps = {
			getRunner: async () => runner,
			spawn: fakeSpawnFactory((role, _n, dir) => {
				if (role === "red") {
					const f = path.join(dir, "src", "test", "java", "SumTest.java");
					writeFileSync(f, "class SumTest { /* red round */ }\n");
				} else {
					const f = path.join(dir, "src", "main", "java", "Sum.java");
					writeFileSync(f, "class Sum { int add(int a,int b){return a+b;} }\n");
				}
			}),
		};

		await runHarness({ kataDir: kata, now: new Date("2026-04-23T10:00:00Z") }, deps);

		const runsDir = path.join(kata, ".harness", "runs");
		const [runId] = readdirSync(runsDir);
		const dir = path.join(runsDir, runId);
		const files = readdirSync(dir).sort();
		expect(files).toEqual(
			expect.arrayContaining([
				"round-1-red.diff",
				"round-1-blue.diff",
				"round-1-test-output.txt",
				"round-1-coverage.json",
				"round-1-red.stream.jsonl",
				"round-1-blue.stream.jsonl",
				"round-2-red.diff",
				"round-2-blue.diff",
				"round-2-test-output.txt",
				"round-2-coverage.json",
				"summary.json",
			]),
		);
		const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
		expect(summary.exitReason).toBe("cap");
		expect(summary.rounds).toBe(2);
		expect(summary.partial).toBe(false);
		expect(summary.finalCoverage).toEqual({ lines: 0.5, branches: 0.5, functions: 0.5, statements: 0.5 });

		const redDiff = readFileSync(path.join(dir, "round-1-red.diff"), "utf8");
		expect(redDiff).toContain("SumTest.java");
		const blueDiff = readFileSync(path.join(dir, "round-1-blue.diff"), "utf8");
		expect(blueDiff).toContain("Sum.java");
		expect(blueDiff).not.toContain("SumTest.java");
	});

	it("stops early with exitReason=green when tests pass and coverage meets threshold", async () => {
		process.env.PI_TDD_MAX_ROUNDS = "5";
		process.env.PI_TDD_COVERAGE = "0.90";
		const failing: RunnerResult = {
			passing: false,
			output: "failing",
			coverage: { lines: 0.5, branches: 0.5, functions: 0.5, statements: 0.5 },
		};
		const passing: RunnerResult = {
			passing: true,
			output: "all good",
			coverage: { lines: 0.95, branches: 0.95, functions: 0.95, statements: 0.95 },
		};
		const runner = makeFakeRunner([failing, passing]);
		const deps = {
			getRunner: async () => runner,
			spawn: fakeSpawnFactory((role, _n, dir) => {
				if (role === "red") {
					writeFileSync(path.join(dir, "src", "test", "java", "SumTest.java"), "class SumTest {}\n");
				} else {
					writeFileSync(path.join(dir, "src", "main", "java", "Sum.java"), "class Sum {}\n");
				}
			}),
		};

		await runHarness({ kataDir: kata, now: new Date("2026-04-23T10:00:00Z") }, deps);

		const runsDir = path.join(kata, ".harness", "runs");
		const [runId] = readdirSync(runsDir);
		const dir = path.join(runsDir, runId);
		const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
		expect(summary.exitReason).toBe("green");
		expect(summary.rounds).toBe(1);
		expect(summary.passing).toBe(true);
	});

	it("honors PI_TDD_RED_MODEL and PI_TDD_BLUE_MODEL", async () => {
		process.env.PI_TDD_RED_MODEL = "ollama/red-only";
		process.env.PI_TDD_BLUE_MODEL = "ollama/blue-only";
		process.env.PI_TDD_MAX_ROUNDS = "1";
		const runner = makeFakeRunner([
			{
				passing: false,
				output: "x",
				coverage: { lines: 0, branches: 0, functions: 0, statements: 0 },
			},
		]);
		const seen: { role: string; model: string }[] = [];
		const deps = {
			getRunner: async () => runner,
			spawn: async (opts: SpawnOptions): Promise<SpawnResult> => {
				seen.push({ role: opts.role, model: opts.model });
				writeFileSync(opts.streamFile, "");
				return { exitCode: 0, finalAssistantMessage: "", toolEventsAtShutdown: 0 };
			},
		};

		await runHarness({ kataDir: kata, now: new Date("2026-04-23T10:00:00Z") }, deps);

		expect(seen).toEqual([
			{ role: "red", model: "ollama/red-only" },
			{ role: "blue", model: "ollama/blue-only" },
		]);
	});

	afterEach(() => {
		delete process.env.PI_TDD_MAX_ROUNDS;
		delete process.env.PI_TDD_COVERAGE;
		delete process.env.PI_TDD_RED_MODEL;
		delete process.env.PI_TDD_BLUE_MODEL;
	});
});
