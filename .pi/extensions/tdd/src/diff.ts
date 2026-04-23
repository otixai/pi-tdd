import { spawn } from "node:child_process";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		child.on("error", (err) => resolve({ code: -1, stdout: "", stderr: err.message }));
	});
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await runGit(cwd, ["rev-parse", "--git-dir"]);
	return r.code === 0;
}

export async function hasCommits(cwd: string): Promise<boolean> {
	const r = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	return r.code === 0;
}

export async function workingTreeIsClean(cwd: string): Promise<boolean> {
	const r = await runGit(cwd, ["status", "--porcelain"]);
	return r.code === 0 && r.stdout.trim() === "";
}

export interface CommitOptions {
	cwd: string;
	pathspecs: string[];
	authorName: string;
	authorEmail: string;
	message: string;
}

export async function commitPathspecs(opts: CommitOptions): Promise<{ committed: boolean; diff: string }> {
	const addResult = await runGit(opts.cwd, ["add", "--", ...opts.pathspecs]);
	if (addResult.code !== 0) {
		return {
			committed: false,
			diff: `# git add failed: ${addResult.stderr.trim()}\n# pathspecs: ${opts.pathspecs.join(" ")}\n`,
		};
	}
	const staged = await runGit(opts.cwd, ["diff", "--cached", "--name-only"]);
	if (staged.stdout.trim() === "") {
		return { committed: false, diff: "# (no changes staged for this turn)\n" };
	}
	const commit = await runGit(opts.cwd, [
		"-c",
		`user.name=${opts.authorName}`,
		"-c",
		`user.email=${opts.authorEmail}`,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--no-verify",
		"-m",
		opts.message,
	]);
	if (commit.code !== 0) {
		return {
			committed: false,
			diff: `# git commit failed: ${commit.stderr.trim()}\n`,
		};
	}
	const show = await runGit(opts.cwd, ["show", "--no-color", "HEAD"]);
	return { committed: true, diff: show.stdout };
}
