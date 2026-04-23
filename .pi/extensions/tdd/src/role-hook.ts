import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { evaluateToolCall, type Role } from "./restrictions.js";

function readRole(): Role {
	const raw = process.env.PI_TDD_ROLE;
	if (raw !== "red" && raw !== "blue") {
		throw new Error(`PI_TDD_ROLE must be "red" or "blue", got: ${String(raw)}`);
	}
	return raw;
}

export default function (pi: ExtensionAPI) {
	const role = readRole();
	const cwd = process.cwd();

	pi.on("tool_call", async (event, ctx) => {
		const result = evaluateToolCall(role, { toolName: event.toolName, input: event.input as Record<string, unknown> }, cwd);
		if (!result) return undefined;
		if (ctx.hasUI) ctx.ui.notify(result.reason, "warning");
		return { block: true, reason: result.reason };
	});
}
