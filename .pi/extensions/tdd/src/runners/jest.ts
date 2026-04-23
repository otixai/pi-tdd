import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Coverage, Runner, RunnerResult } from "./index.js";

function zero(): Coverage {
	return { lines: 0, branches: 0, functions: 0, statements: 0 };
}

function readCoverageSummary(kataDir: string): Coverage | undefined {
	const summaryPath = path.join(kataDir, "coverage", "coverage-summary.json");
	if (!existsSync(summaryPath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
		const total = data.total as Record<string, { pct: number }> | undefined;
		if (!total) return undefined;
		return {
			lines: (total.lines?.pct ?? 0) / 100,
			branches: (total.branches?.pct ?? 0) / 100,
			functions: (total.functions?.pct ?? 0) / 100,
			statements: (total.statements?.pct ?? 0) / 100,
		};
	} catch {
		return undefined;
	}
}

export const jestRunner: Runner = {
	name: "jest",
	testPathspecs: ["test/", "tests/", "__tests__/", "spec/", "*.test.*", "*.spec.*", "**/*.test.*", "**/*.spec.*"],
	srcPathspecs: [
		".",
		":(exclude)test",
		":(exclude)tests",
		":(exclude)__tests__",
		":(exclude)spec",
		":(exclude)**/*.test.*",
		":(exclude)**/*.spec.*",
		":(exclude)node_modules",
		":(exclude).harness",
		":(exclude).pi",
		":(exclude)coverage",
	],
	async run(kataDir: string, signal: AbortSignal): Promise<RunnerResult> {
		const useNpm = existsSync(path.join(kataDir, "package.json"));
		if (!useNpm) {
			return { passing: false, output: "jest runner: no package.json found", coverage: undefined };
		}
		return new Promise<RunnerResult>((resolve) => {
			const child = spawn(
				"npx",
				[
					"--no-install",
					"jest",
					"--coverage",
					"--coverageReporters=json-summary",
					"--coverageReporters=text-summary",
					"--colors=false",
				],
				{ cwd: kataDir, env: { ...process.env, CI: "1" } },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			const abortListener = () => child.kill("SIGTERM");
			signal.addEventListener("abort", abortListener, { once: true });
			child.on("close", (code) => {
				signal.removeEventListener("abort", abortListener);
				const combined = `${stdout}\n${stderr}`.trim();
				const coverage = readCoverageSummary(kataDir) ?? zero();
				resolve({ passing: code === 0, output: combined, coverage });
			});
			child.on("error", (err) => {
				signal.removeEventListener("abort", abortListener);
				resolve({ passing: false, output: `jest spawn error: ${err.message}`, coverage: undefined });
			});
		});
	},
};
