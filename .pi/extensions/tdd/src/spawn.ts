import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "./restrictions.js";

const ROLE_HOOK_PATH = (() => {
	const here = fileURLToPath(new URL(".", import.meta.url));
	return path.join(here, "role-hook.ts");
})();

export interface SpawnOptions {
	role: Role;
	kataDir: string;
	systemPromptPath: string;
	userPrompt: string;
	model: string;
	thinking: string;
	streamFile: string;
	signal: AbortSignal;
	onEvent?: (line: string) => void;
}

export interface SpawnResult {
	exitCode: number | null;
	finalAssistantMessage: string;
	toolEventsAtShutdown: number;
}

function buildArgv(opts: SpawnOptions, systemPromptText: string): string[] {
	return [
		"-p",
		opts.userPrompt,
		"--mode",
		"json",
		"--no-extensions",
		"-e",
		ROLE_HOOK_PATH,
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-session",
		"--tools",
		"read,write,edit,grep,find,ls",
		"--model",
		opts.model,
		"--thinking",
		opts.thinking,
		"--system-prompt",
		systemPromptText,
	];
}

export async function spawnPi(opts: SpawnOptions, systemPromptText: string): Promise<SpawnResult> {
	return runSpawn(opts, systemPromptText);
}

function runSpawn(opts: SpawnOptions, systemPromptText: string): Promise<SpawnResult> {
	return new Promise<SpawnResult>((resolve) => {
		const stream: WriteStream = createWriteStream(opts.streamFile, { flags: "a" });
		const argv = buildArgv(opts, systemPromptText);
		const child: ChildProcess = spawn("pi", argv, {
			cwd: opts.kataDir,
			env: {
				...process.env,
				PI_TDD_ROLE: opts.role,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		let finalAssistantMessage = "";
		let toolEventsAtShutdown = 0;
		let shutdownRequested = false;
		let inToolCall = 0;

		const handleLine = (line: string) => {
			stream.write(`${line}\n`);
			opts.onEvent?.(line);
			try {
				const parsed = JSON.parse(line) as { type?: string; text?: string; content?: unknown };
				if (parsed.type === "tool_call") inToolCall += 1;
				if (parsed.type === "tool_execution_end") {
					inToolCall = Math.max(0, inToolCall - 1);
					toolEventsAtShutdown += 1;
					if (shutdownRequested && inToolCall === 0) child.kill("SIGTERM");
				}
				if (parsed.type === "message_end" && typeof parsed.text === "string") {
					finalAssistantMessage = parsed.text;
				}
			} catch {
			}
		};

		const drain = () => {
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				const line = part.trim();
				if (line.length > 0) handleLine(line);
			}
		};

		child.stdout?.on("data", (d: Buffer) => {
			buffer += d.toString();
			drain();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stream.write(`# stderr: ${d.toString()}`);
		});

		const abortListener = () => {
			shutdownRequested = true;
			if (inToolCall === 0) child.kill("SIGTERM");
		};
		opts.signal.addEventListener("abort", abortListener, { once: true });

		child.on("close", (code) => {
			if (buffer.trim().length > 0) {
				const line = buffer.trim();
				buffer = "";
				handleLine(line);
			}
			opts.signal.removeEventListener("abort", abortListener);
			stream.end();
			resolve({ exitCode: code, finalAssistantMessage, toolEventsAtShutdown });
		});

		child.on("error", (err) => {
			opts.signal.removeEventListener("abort", abortListener);
			stream.write(`# spawn error: ${err.message}\n`);
			stream.end();
			resolve({ exitCode: null, finalAssistantMessage: `spawn error: ${err.message}`, toolEventsAtShutdown });
		});
	});
}

export { ROLE_HOOK_PATH };
