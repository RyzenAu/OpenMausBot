import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { runInstaboxComputerTool } from "./instabox-tools.ts";
import {
  createInstaboxClient,
  instaboxComputerActionError,
  instaboxOwner,
  instaboxRequestAllowed,
  instaboxTurnPlan,
  planInstaboxAssignment,
  resolveTurnCloudBackend,
  scrubInstaboxSecret,
} from "./instabox.ts";

const MACHINE = "m_agqteugyy5px6hzeadbh4ldjo4";
const OTHER = "m_bgqteugyy5px6hzeadbh4ldjo4";
const KEY = "ibx_test_key_not_for_logs_1234";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function machine(id: string, state = "running", name = "nomi") {
  return { id, name, state, runtime: { ready: state === "running" }, template: { id: "agent-browser" } };
}

describe("InstaBox request guard", () => {
  it("allows reads, exec, desktop, resume and start, and refuses create, delete, fork and resize", () => {
    expect(instaboxRequestAllowed("GET", "/v1/machines?limit=100")).toBe(true);
    expect(instaboxRequestAllowed("GET", `/v1/machines/${MACHINE}`)).toBe(true);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/exec`)).toBe(true);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/desktop`)).toBe(true);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/resume`)).toBe(true);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/start`)).toBe(true);
    expect(instaboxRequestAllowed("POST", "/v1/machines")).toBe(false);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/stop`)).toBe(false);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/suspend`)).toBe(false);
    expect(instaboxRequestAllowed("GET", "/v1/machines")).toBe(false);
    expect(instaboxRequestAllowed("DELETE", `/v1/machines/${MACHINE}`)).toBe(false);
    expect(instaboxRequestAllowed("PATCH", `/v1/machines/${MACHINE}`)).toBe(false);
    expect(instaboxRequestAllowed("PUT", `/v1/machines/${MACHINE}/files`)).toBe(false);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/fork`)).toBe(false);
    expect(instaboxRequestAllowed("POST", `/v1/machines/${MACHINE}/desktop/stream`)).toBe(false);
  });

  it("keeps an InstaBox bot off Boat even when a routine asks for a cloud desktop", () => {
    expect(resolveTurnCloudBackend({ cloudBackend: "instabox" }, true, "cloud")).toBe("instabox");
    expect(resolveTurnCloudBackend({ cloudBackend: "vps" }, false, undefined)).toBe("vps");
    expect(resolveTurnCloudBackend({ cloudBackend: "box" }, false, undefined)).toBe("box");
    expect(resolveTurnCloudBackend({}, false, "cloud")).toBe("box");
    expect(instaboxTurnPlan({ backend: "instabox", wants: "cloud", configured: true, assigned: true })).toBe("mount");
    expect(instaboxTurnPlan({ backend: "instabox", wants: "cloud", configured: false, assigned: true })).toBe("fail-unconfigured");
    expect(instaboxTurnPlan({ backend: "instabox", wants: "local", configured: true, assigned: true })).toBe("skip");
    expect(instaboxTurnPlan({ backend: "box", wants: "cloud", configured: true, assigned: true })).toBe("skip");
  });

  it("assigns one existing machine to one bot and never clears that bot onto Boat", () => {
    const bots = [
      { id: "nomi", name: "Nomi", busy: false },
      { id: "quinn", name: "Quinn", instaboxMachineId: OTHER, busy: false },
    ];
    expect(planInstaboxAssignment(bots, "nomi", MACHINE)).toEqual({
      ok: true,
      patch: { instaboxMachineId: MACHINE, cloudBackend: "instabox", computer: "cloud" },
    });
    expect(planInstaboxAssignment(bots, "nomi", OTHER)).toMatchObject({ ok: false, status: 409 });
    expect(planInstaboxAssignment(bots, "nomi", null)).toEqual({
      ok: true,
      patch: { instaboxMachineId: undefined, cloudBackend: "instabox" },
    });
    expect(planInstaboxAssignment(bots, "nomi", "box_123")).toMatchObject({ ok: false, status: 400 });
    expect(instaboxOwner([{ id: "nomi", name: "Nomi", instaboxMachineId: MACHINE }], MACHINE, "quinn")).toMatch(/one bot/);
    expect(instaboxComputerActionError("provision")).toMatch(/does not create or delete/);
    expect(instaboxComputerActionError("screenshot")).toBeNull();
  });

  it("scrubs the API key out of text", () => {
    expect(scrubInstaboxSecret(`rejected ${KEY}`, KEY)).toBe("rejected ••••••");
    expect(scrubInstaboxSecret("no secret here", KEY)).toBe("no secret here");
  });
});

describe("InstaBox client", () => {
  let server: Server;
  const calls: Array<{ method: string; url: string; key: string | undefined; body: string }> = [];
  let state = "running";
  let desktopInstalled = true;
  let desktopRunning = true;

  afterEach(async () => {
    calls.length = 0;
    state = "running";
    desktopInstalled = true;
    desktopRunning = true;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function listen() {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        calls.push({
          method: req.method ?? "",
          url,
          key: req.headers["x-api-key"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (url.startsWith("/v1/machines?") || url === "/v1/machines") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            machines: [machine(MACHINE, "running", "nomi"), machine(OTHER, "suspended", "quinn")],
            nextCursor: null,
          }));
          return;
        }
        if (url === `/v1/machines/${MACHINE}` || url === `/v1/machines/${OTHER}`) {
          const id = url.endsWith(OTHER) ? OTHER : MACHINE;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(machine(id, id === MACHINE ? state : "suspended")));
          return;
        }
        if (url.endsWith("/resume") || url.endsWith("/start")) {
          state = "running";
          res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ id: "op_1", state: "queued" }));
          return;
        }
        if (url.endsWith("/desktop")) {
          const action = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").action;
          if (action === "install") desktopInstalled = true;
          if (action === "start") desktopRunning = true;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            installed: desktopInstalled, running: desktopRunning,
          }));
          return;
        }
        if (url.includes("/exec")) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false }));
          return;
        }
        if (url.includes("/files/content")) {
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(PNG);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: "not_found", message: `missing and ${KEY}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return createInstaboxClient({ apiKey: KEY, baseUrl: `http://127.0.0.1:${address.port}` });
  }

  it("lists existing machines and does not send a create", async () => {
    const client = await listen();
    const machines = await client.listMachines();
    expect(machines.map((machine) => machine.id)).toEqual([MACHINE, OTHER]);
    expect(calls.some((call) => call.method === "POST" && call.url === "/v1/machines")).toBe(false);
    expect(calls.every((call) => call.key === KEY)).toBe(true);
  });

  it("screenshots a running machine and refuses one that is not running without waking it", async () => {
    const client = await listen();
    const shot = await client.screenshot(MACHINE);
    expect(shot.png).toBe(PNG.toString("base64"));
    expect(calls.some((call) => call.url.includes("/exec") && call.body.includes("scrot"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/start") || call.url.endsWith("/resume"))).toBe(false);
    state = "suspended";
    await expect(client.screenshot(MACHINE)).rejects.toThrow(/suspended/);
    expect(calls.filter((call) => call.url.endsWith("/resume"))).toHaveLength(0);
  });

  it("reconnect resumes a suspended machine and never posts a create", async () => {
    state = "suspended";
    const client = await listen();
    const machine = await client.reconnect(MACHINE);
    expect(machine.state).toBe("running");
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/resume"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url === "/v1/machines")).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("hides the API key when InstaBox echoes it in an error", async () => {
    const client = await listen();
    await expect(client.getMachine("m_not_a_real_machine_id_xxxxx")).rejects.toThrow(/That is not an InstaBox machine id/);
    await expect(client.getMachine("m_cgqteugyy5px6hzeadbh4ldjo4")).rejects.toThrow(/••••••/);
    await expect(client.getMachine("m_cgqteugyy5px6hzeadbh4ldjo4")).rejects.not.toThrow(KEY);
  });

  it("refuses a base URL that is not the public API or a loopback test", () => {
    expect(() => createInstaboxClient({ apiKey: KEY, baseUrl: "https://evil.example/v1" })).toThrow(/public API/);
  });

  it("rejects a desktop command that is not one of the fixed templates before any request", async () => {
    const client = createInstaboxClient({
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:9",
      fetch: () => { throw new Error("network"); },
    });
    await expect(client.desktopCommand(MACHINE, "xdotool mousemove 1;id")).rejects.toThrow(/not allowed/);
    expect(() => client.click(MACHINE, Number.NaN, 1)).toThrow(/pixels/);
    expect(() => client.shell(MACHINE, KEY)).toThrow(/not allowed/);
  });

  it("runs a click and an exec only against the assigned machine", async () => {
    const client = await listen();
    const click = await runInstaboxComputerTool(client, MACHINE, "click", { x: 10, y: 20, button: "left" });
    expect(click.isError).toBeUndefined();
    expect(calls.at(-1)?.url).toBe(`/v1/machines/${MACHINE}/exec`);
    expect(calls.at(-1)?.body).toContain("xdotool mousemove 10 20");
    const shell = await runInstaboxComputerTool(client, MACHINE, "exec", { command: "echo hi" });
    expect(shell.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse((shell.content[0] as { text: string }).text).ok).toBe(true);
    const reddit = await runInstaboxComputerTool(client, MACHINE, "open_url", { url: "https://www.reddit.com/r/test" });
    expect(reddit.isError).toBe(true);
    expect(calls.some((call) => call.body.includes("reddit.com"))).toBe(false);
  });
});
