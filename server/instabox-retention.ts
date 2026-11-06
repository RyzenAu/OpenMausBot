/** What a sync may do after merging upstream. A failed check never becomes a push. */
export function instaboxSyncDecision(input: {
  force: boolean;
  dirty: boolean;
  conflicts: readonly string[];
  testsFailed: boolean;
  retention: readonly string[];
}): { action: "stop" | "open-pr"; reason: string } {
  if (input.force) return { action: "stop", reason: "Refusing to force-push." };
  if (input.dirty) return { action: "stop", reason: "The worktree was dirty before the merge." };
  if (input.conflicts.length > 0) {
    return { action: "stop", reason: `Merge conflict in ${input.conflicts.join(", ")}. The default branch was not changed.` };
  }
  if (input.retention.length > 0) {
    return { action: "stop", reason: `InstaBox retention failed: ${input.retention.join("; ")}. The merge was not pushed.` };
  }
  if (input.testsFailed) return { action: "stop", reason: "Tests failed. The merge was not pushed and nothing was installed." };
  return { action: "open-pr", reason: "Merge and tests passed. Open a pull request for review. Do not merge or install it automatically." };
}

/** The files a clean upstream merge must still satisfy. Missing text stops the sync. */
export function instaboxRetentionProblems(files: { client?: string; updater?: string; release?: string; linuxPackage?: string; windowsPackage?: string }): string[] {
  const problems: string[] = [];
  const client = files.client ?? "";
  if (!client.includes("export function instaboxRequestAllowed")) problems.push("the InstaBox client lost its request guard");
  if (!client.includes('path === "/v1/machines"')) problems.push("the InstaBox client no longer refuses machine creation");
  if (/\bfunction create\(/.test(client) || client.includes('"/v1/machines", { method: "POST"')) {
    problems.push("the InstaBox client gained a create call");
  }
  const updater = files.updater ?? "";
  if (!/owner:\s*RyzenAu\b/.test(updater) || !/repo:\s*OpenMausBot\b/.test(updater)) {
    problems.push("the desktop updater feed is not this fork (RyzenAu/OpenMausBot)");
  }
  for (const [label, text] of [["release workflow", files.release], ["linux package check", files.linuxPackage], ["Windows package workflow", files.windowsPackage]] as const) {
    if (text !== undefined && !text.includes("owner: RyzenAu")) problems.push(`the ${label} no longer expects this fork's updater feed`);
  }
  return problems;
}
