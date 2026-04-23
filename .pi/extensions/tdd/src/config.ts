import { readFileSync } from "node:fs";
import path from "node:path";

export interface AgentConfig {
	model: string;
	thinking: string;
}

export interface HarnessConfig {
	red: AgentConfig;
	blue: AgentConfig;
	maxRounds: number;
	coverageThreshold: number;
	runner: "auto" | "jest" | "maven";
}

export const DEFAULT_CONFIG: HarnessConfig = {
	red: { model: "ollama/qwen3-coder:30b", thinking: "low" },
	blue: { model: "ollama/qwen3-coder:30b", thinking: "low" },
	maxRounds: 20,
	coverageThreshold: 0.95,
	runner: "auto",
};

function parseFloatEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseFloat(raw);
	if (Number.isNaN(n)) throw new Error(`${name} is not a number: ${raw}`);
	return n;
}

function parseIntEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) throw new Error(`${name} is not an integer: ${raw}`);
	return n;
}

export function loadConfig(kataDir: string): HarnessConfig {
	const merged: HarnessConfig = structuredClone(DEFAULT_CONFIG);

	const configPath = path.join(kataDir, ".pi", "extensions", "tdd", "config.json");
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<HarnessConfig>;
		if (parsed.red) Object.assign(merged.red, parsed.red);
		if (parsed.blue) Object.assign(merged.blue, parsed.blue);
		if (typeof parsed.maxRounds === "number") merged.maxRounds = parsed.maxRounds;
		if (typeof parsed.coverageThreshold === "number") merged.coverageThreshold = parsed.coverageThreshold;
		if (parsed.runner) merged.runner = parsed.runner;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") throw err;
	}

	const redModel = process.env.PI_TDD_RED_MODEL;
	if (redModel) merged.red.model = redModel;
	const blueModel = process.env.PI_TDD_BLUE_MODEL;
	if (blueModel) merged.blue.model = blueModel;
	const maxRounds = parseIntEnv("PI_TDD_MAX_ROUNDS");
	if (maxRounds !== undefined) merged.maxRounds = maxRounds;
	const threshold = parseFloatEnv("PI_TDD_COVERAGE");
	if (threshold !== undefined) merged.coverageThreshold = threshold;
	const runner = process.env.PI_TDD_RUNNER;
	if (runner === "jest" || runner === "maven" || runner === "auto") merged.runner = runner;

	if (merged.maxRounds < 1) throw new Error(`maxRounds must be >= 1, got ${merged.maxRounds}`);
	if (merged.coverageThreshold < 0 || merged.coverageThreshold > 1) {
		throw new Error(`coverageThreshold must be in [0,1], got ${merged.coverageThreshold}`);
	}

	return merged;
}
