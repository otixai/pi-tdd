import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Coverage, Runner, RunnerResult } from "./index.js";

function parseJacocoCsv(kataDir: string): Coverage | undefined {
	const csvPath = path.join(kataDir, "target", "site", "jacoco", "jacoco.csv");
	if (!existsSync(csvPath)) return undefined;
	try {
		const content = readFileSync(csvPath, "utf8").trim();
		const lines = content.split(/\r?\n/);
		if (lines.length < 2) return undefined;
		const header = lines[0].split(",");
		const idx = (name: string) => header.indexOf(name);
		const instMissed = idx("INSTRUCTION_MISSED");
		const instCovered = idx("INSTRUCTION_COVERED");
		const branchMissed = idx("BRANCH_MISSED");
		const branchCovered = idx("BRANCH_COVERED");
		const lineMissed = idx("LINE_MISSED");
		const lineCovered = idx("LINE_COVERED");
		const methodMissed = idx("METHOD_MISSED");
		const methodCovered = idx("METHOD_COVERED");
		let im = 0;
		let ic = 0;
		let bm = 0;
		let bc = 0;
		let lm = 0;
		let lc = 0;
		let mm = 0;
		let mc = 0;
		for (const row of lines.slice(1)) {
			const cols = row.split(",");
			im += Number.parseInt(cols[instMissed] ?? "0", 10) || 0;
			ic += Number.parseInt(cols[instCovered] ?? "0", 10) || 0;
			bm += Number.parseInt(cols[branchMissed] ?? "0", 10) || 0;
			bc += Number.parseInt(cols[branchCovered] ?? "0", 10) || 0;
			lm += Number.parseInt(cols[lineMissed] ?? "0", 10) || 0;
			lc += Number.parseInt(cols[lineCovered] ?? "0", 10) || 0;
			mm += Number.parseInt(cols[methodMissed] ?? "0", 10) || 0;
			mc += Number.parseInt(cols[methodCovered] ?? "0", 10) || 0;
		}
		const ratio = (covered: number, missed: number) => (covered + missed === 0 ? 1 : covered / (covered + missed));
		return {
			statements: ratio(ic, im),
			branches: ratio(bc, bm),
			lines: ratio(lc, lm),
			functions: ratio(mc, mm),
		};
	} catch {
		return undefined;
	}
}

export const mavenRunner: Runner = {
	name: "maven",
	testPathspecs: ["src/test/"],
	srcPathspecs: ["src/main/", "pom.xml", ":(exclude).harness", ":(exclude).pi", ":(exclude)target"],
	async run(kataDir: string, signal: AbortSignal): Promise<RunnerResult> {
		if (!existsSync(path.join(kataDir, "pom.xml"))) {
			return { passing: false, output: "maven runner: no pom.xml found", coverage: undefined };
		}
		return new Promise<RunnerResult>((resolve) => {
			const child = spawn(
				"mvn",
				["-B", "-q", "verify"],
				{ cwd: kataDir, env: { ...process.env, MAVEN_OPTS: process.env.MAVEN_OPTS ?? "" } },
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
				const coverage = parseJacocoCsv(kataDir);
				resolve({ passing: code === 0, output: combined, coverage });
			});
			child.on("error", (err) => {
				signal.removeEventListener("abort", abortListener);
				resolve({ passing: false, output: `mvn spawn error: ${err.message}`, coverage: undefined });
			});
		});
	},
};
