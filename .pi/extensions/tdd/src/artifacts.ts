import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Coverage } from "./runners/index.js";

export interface RunArtifactsRoot {
	dir: string;
	runId: string;
}

export function createRunRoot(kataDir: string, now: Date = new Date()): RunArtifactsRoot {
	const runId = now.toISOString().replace(/[:.]/g, "-");
	const harnessRoot = path.join(kataDir, ".harness");
	const dir = path.join(harnessRoot, "runs", runId);
	mkdirSync(dir, { recursive: true });
	const gitignore = path.join(harnessRoot, ".gitignore");
	if (!existsSync(gitignore)) {
		writeFileSync(gitignore, "*\n!.gitignore\n");
	}
	return { dir, runId };
}

export function writeRoundArtifacts(
	root: RunArtifactsRoot,
	round: number,
	artifacts: {
		redDiff: string;
		blueDiff: string;
		testOutput: string;
		coverage: Coverage | undefined;
		passing: boolean;
	},
): void {
	const prefix = `round-${round}`;
	writeFileSync(path.join(root.dir, `${prefix}-red.diff`), artifacts.redDiff);
	writeFileSync(path.join(root.dir, `${prefix}-blue.diff`), artifacts.blueDiff);
	writeFileSync(path.join(root.dir, `${prefix}-test-output.txt`), artifacts.testOutput);
	writeFileSync(
		path.join(root.dir, `${prefix}-coverage.json`),
		JSON.stringify(
			{
				passing: artifacts.passing,
				coverage: artifacts.coverage ?? null,
			},
			null,
			2,
		),
	);
}

export function streamFilePath(root: RunArtifactsRoot, round: number, role: "red" | "blue"): string {
	return path.join(root.dir, `round-${round}-${role}.stream.jsonl`);
}

export interface SummaryInput {
	rounds: number;
	exitReason: "green" | "cap" | "sigint" | "error";
	finalCoverage: Coverage | undefined;
	passing: boolean;
	redModel: string;
	blueModel: string;
	startedAt: string;
	endedAt: string;
	partial: boolean;
	sigintAt?: string;
	error?: string;
}

export function writeSummary(root: RunArtifactsRoot, summary: SummaryInput): void {
	writeFileSync(path.join(root.dir, "summary.json"), JSON.stringify(summary, null, 2));
}
