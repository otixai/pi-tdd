import { describe, expect, it } from "vitest";
import { decide, evaluateToolCall, isTestPath, normalizeUnderCwd } from "../src/restrictions.js";

const CWD = "/tmp/kata";

describe("isTestPath", () => {
	it("recognizes tests/ segment", () => {
		expect(isTestPath("tests/foo.ts", CWD)).toBe(true);
		expect(isTestPath("tests/sub/foo.ts", CWD)).toBe(true);
	});
	it("recognizes test/ segment", () => {
		expect(isTestPath("src/test/java/FooTest.java", CWD)).toBe(true);
	});
	it("recognizes __tests__ directory", () => {
		expect(isTestPath("src/__tests__/foo.ts", CWD)).toBe(true);
	});
	it("recognizes .test.ts suffix", () => {
		expect(isTestPath("src/foo.test.ts", CWD)).toBe(true);
		expect(isTestPath("any/dir/foo.spec.js", CWD)).toBe(true);
	});
	it("recognizes Test.java suffix", () => {
		expect(isTestPath("src/main/java/FooTest.java", CWD)).toBe(true);
		expect(isTestPath("src/FooIT.java", CWD)).toBe(true);
	});
	it("rejects pure source paths", () => {
		expect(isTestPath("src/main/java/Foo.java", CWD)).toBe(false);
		expect(isTestPath("src/foo.ts", CWD)).toBe(false);
		expect(isTestPath("pom.xml", CWD)).toBe(false);
	});
	it("rejects paths escaping cwd", () => {
		expect(isTestPath("../other/tests/foo.ts", CWD)).toBe(false);
	});
	it("normalizes absolute paths inside cwd", () => {
		expect(isTestPath(`${CWD}/tests/foo.ts`, CWD)).toBe(true);
	});
});

describe("decide (Red)", () => {
	it("allows writes inside tests/", () => {
		expect(decide("red", "tests/foo.test.ts", CWD).allow).toBe(true);
	});
	it("blocks writes to src/", () => {
		expect(decide("red", "src/main/java/Foo.java", CWD).allow).toBe(false);
	});
	it("blocks writes to build config", () => {
		expect(decide("red", "pom.xml", CWD).allow).toBe(false);
	});
	it("blocks writes escaping cwd", () => {
		expect(decide("red", "../elsewhere/tests/x.ts", CWD).allow).toBe(false);
	});
});

describe("decide (Blue)", () => {
	it("blocks writes to tests/", () => {
		expect(decide("blue", "tests/foo.test.ts", CWD).allow).toBe(false);
	});
	it("blocks writes to test file by suffix", () => {
		expect(decide("blue", "src/Foo.test.ts", CWD).allow).toBe(false);
	});
	it("blocks writes to Java test file", () => {
		expect(decide("blue", "src/test/java/GildedRoseTest.java", CWD).allow).toBe(false);
	});
	it("allows writes to src/", () => {
		expect(decide("blue", "src/main/java/Foo.java", CWD).allow).toBe(true);
	});
	it("allows writes to build config", () => {
		expect(decide("blue", "pom.xml", CWD).allow).toBe(true);
	});
});

describe("evaluateToolCall (canary)", () => {
	it("rejects Blue writing to a test file — the canary", () => {
		const result = evaluateToolCall(
			"blue",
			{ toolName: "write", input: { path: "tests/gilded_rose.test.ts" } },
			CWD,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Blue may not modify tests"),
		});
	});
	it("rejects Red writing to source", () => {
		const result = evaluateToolCall(
			"red",
			{ toolName: "edit", input: { path: "src/main/java/GildedRose.java" } },
			CWD,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Red may only write tests"),
		});
	});
	it("allows Red writing to a test file", () => {
		const result = evaluateToolCall(
			"red",
			{ toolName: "write", input: { path: "src/test/java/GildedRoseTest.java" } },
			CWD,
		);
		expect(result).toBeUndefined();
	});
	it("allows Blue writing to source", () => {
		const result = evaluateToolCall(
			"blue",
			{ toolName: "write", input: { path: "src/main/java/GildedRose.java" } },
			CWD,
		);
		expect(result).toBeUndefined();
	});
	it("blocks the bash tool outright for Red", () => {
		const result = evaluateToolCall("red", { toolName: "bash", input: { command: "echo hi" } }, CWD);
		expect(result).toEqual({ block: true, reason: expect.stringContaining("bash tool is disabled") });
	});
	it("blocks the bash tool outright for Blue", () => {
		const result = evaluateToolCall("blue", { toolName: "bash", input: { command: "echo hi" } }, CWD);
		expect(result).toEqual({ block: true, reason: expect.stringContaining("bash tool is disabled") });
	});
	it("lets read-only tools through for both", () => {
		for (const role of ["red", "blue"] as const) {
			expect(evaluateToolCall(role, { toolName: "read", input: { path: "src/Foo.java" } }, CWD)).toBeUndefined();
			expect(evaluateToolCall(role, { toolName: "grep", input: { pattern: "x" } }, CWD)).toBeUndefined();
			expect(evaluateToolCall(role, { toolName: "find", input: { pattern: "*.java" } }, CWD)).toBeUndefined();
			expect(evaluateToolCall(role, { toolName: "ls", input: { path: "." } }, CWD)).toBeUndefined();
		}
	});
	it("rejects write/edit without a path argument", () => {
		const result = evaluateToolCall("red", { toolName: "write", input: {} }, CWD);
		expect(result).toEqual({ block: true, reason: expect.stringContaining("without a path") });
	});
});

describe("normalizeUnderCwd", () => {
	it("produces a relative path", () => {
		expect(normalizeUnderCwd("foo/bar.ts", CWD)).toBe("foo/bar.ts");
		expect(normalizeUnderCwd(`${CWD}/foo/bar.ts`, CWD)).toBe("foo/bar.ts");
	});
});
