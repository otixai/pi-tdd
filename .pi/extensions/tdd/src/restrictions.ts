import path from "node:path";

export type Role = "red" | "blue";

export interface PathDecision {
	allow: boolean;
	reason?: string;
}

const TEST_DIR_SEGMENTS = new Set(["tests", "test", "__tests__", "spec", "specs"]);
const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.js"];
const TEST_FILE_REGEXES = [/Test\.java$/, /Tests\.java$/, /IT\.java$/, /_test\.go$/, /_spec\.rb$/];

export function normalizeUnderCwd(p: string, cwd: string): string {
	const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
	return path.relative(cwd, abs);
}

export function isTestPath(p: string, cwd: string): boolean {
	const rel = normalizeUnderCwd(p, cwd);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
	const segments = rel.split(path.sep).filter(Boolean);
	if (segments.some((s) => TEST_DIR_SEGMENTS.has(s))) return true;
	const base = segments[segments.length - 1] ?? "";
	if (TEST_FILE_SUFFIXES.some((s) => base.endsWith(s))) return true;
	if (TEST_FILE_REGEXES.some((re) => re.test(base))) return true;
	return false;
}

export function isInsideCwd(p: string, cwd: string): boolean {
	const rel = normalizeUnderCwd(p, cwd);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function decide(role: Role, targetPath: string, cwd: string): PathDecision {
	if (!isInsideCwd(targetPath, cwd)) {
		return { allow: false, reason: `Path escapes kata directory: ${targetPath}` };
	}
	const testPath = isTestPath(targetPath, cwd);
	if (role === "red") {
		if (!testPath) return { allow: false, reason: `Red may only write tests. Path is not a test file: ${targetPath}` };
		return { allow: true };
	}
	if (testPath) return { allow: false, reason: `Blue may not modify tests. Path is a test file: ${targetPath}` };
	return { allow: true };
}

export interface MinimalToolEvent {
	toolName: string;
	input: Record<string, unknown>;
}

export interface BlockResult {
	block: true;
	reason: string;
}

const WRITE_LIKE_TOOLS = new Set(["write", "edit"]);

export function evaluateToolCall(
	role: Role,
	event: MinimalToolEvent,
	cwd: string,
): BlockResult | undefined {
	if (event.toolName === "bash") {
		return { block: true, reason: `The bash tool is disabled in TDD harness sessions (role=${role}).` };
	}
	if (!WRITE_LIKE_TOOLS.has(event.toolName)) return undefined;
	const target = event.input.path;
	if (typeof target !== "string" || target.length === 0) {
		return { block: true, reason: `${event.toolName} tool called without a path argument` };
	}
	const decision = decide(role, target, cwd);
	if (decision.allow) return undefined;
	return { block: true, reason: decision.reason ?? "blocked" };
}
