import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runHarness } from "./src/command.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tdd", {
		description: "Run the adversarial TDD harness against <kata-dir> (default: cwd).",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const kataDir = trimmed.length > 0 ? trimmed : ctx.cwd;
			try {
				await runHarness({ kataDir, ctx });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) {
					ctx.ui.notify(`tdd failed: ${message}`, "error");
				} else {
					process.stderr.write(`tdd failed: ${message}\n`);
				}
			}
		},
	});
}
