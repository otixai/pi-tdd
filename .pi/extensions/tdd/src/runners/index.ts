import { existsSync } from "node:fs";
import path from "node:path";

export interface Coverage {
	lines: number;
	branches: number;
	functions: number;
	statements: number;
}

export interface RunnerResult {
	passing: boolean;
	output: string;
	coverage: Coverage | undefined;
}

export interface Runner {
	name: "jest" | "maven";
	testPathspecs: string[];
	srcPathspecs: string[];
	run(kataDir: string, signal: AbortSignal): Promise<RunnerResult>;
}

export function detectRunner(kataDir: string): Runner["name"] | undefined {
	if (existsSync(path.join(kataDir, "pom.xml"))) return "maven";
	const pkg = path.join(kataDir, "package.json");
	if (existsSync(pkg)) return "jest";
	return undefined;
}

export async function getRunner(name: Runner["name"]): Promise<Runner> {
	if (name === "jest") return (await import("./jest.js")).jestRunner;
	if (name === "maven") return (await import("./maven.js")).mavenRunner;
	throw new Error(`Unknown runner: ${name}`);
}
