import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { instaboxRetentionProblems, instaboxSyncDecision } from "./instabox-retention.ts";

describe("upstream sync retention", () => {
  it("opens a review pull request only when the merge is clean, tested, and still refuses to create machines", () => {
    expect(instaboxSyncDecision({ force: false, dirty: false, conflicts: [], testsFailed: false, retention: [] })).toEqual({
      action: "open-pr",
      reason: "Merge and tests passed. Open a pull request for review. Do not merge or install it automatically.",
    });
    expect(instaboxSyncDecision({ force: true, dirty: false, conflicts: [], testsFailed: false, retention: [] }).action).toBe("stop");
    expect(instaboxSyncDecision({ force: false, dirty: false, conflicts: ["server/instabox.ts"], testsFailed: false, retention: [] }).reason).toMatch(/conflict/);
    expect(instaboxSyncDecision({ force: false, dirty: false, conflicts: [], testsFailed: true, retention: [] }).reason).toMatch(/not pushed/);
    expect(instaboxSyncDecision({ force: false, dirty: false, conflicts: [], testsFailed: false, retention: ["guard"] }).action).toBe("stop");
  });

  it("accepts this tree and rejects a client that can create a machine or an updater pointed at upstream", () => {
    const client = readFileSync(new URL("./instabox.ts", import.meta.url), "utf8");
    const updater = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const linuxPackage = readFileSync(new URL("../scripts/verify-linux-package.mjs", import.meta.url), "utf8");
    const windowsPackage = readFileSync(new URL("../.github/workflows/package-win.yml", import.meta.url), "utf8");
    expect(instaboxRetentionProblems({ client, updater, release, linuxPackage, windowsPackage })).toEqual([]);
    expect(instaboxRetentionProblems({ client: client.replace('path === "/v1/machines"', "path === \"/gone\""), updater }).join(" ")).toMatch(/creation/);
    expect(instaboxRetentionProblems({ client, updater: updater.replace("owner: RyzenAu", "owner: milind-soni") }).join(" ")).toMatch(/updater feed/);
  });
});
