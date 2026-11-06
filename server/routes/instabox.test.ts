import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { json } from "../harness/http.ts";
import type { InstaboxClient } from "../instabox.ts";
import { createInstaboxRoutes } from "./instabox.ts";
import type { RouteContext } from "./table.ts";

const MACHINE = "m_agqteugyy5px6hzeadbh4ldjo4";
const KEY = "ibx_route_secret_should_not_leak";

function capture() {
  const res = new EventEmitter() as ServerResponse & { statusCode?: number; payload?: unknown };
  res.setHeader = () => res;
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as ServerResponse["writeHead"];
  res.end = ((data?: string) => {
    res.payload = data ? JSON.parse(data) as unknown : undefined;
    return res;
  }) as ServerResponse["end"];
  return res;
}

function call(path: string, method: string, body: unknown, client: Partial<InstaboxClient>, bots: Array<Record<string, unknown>>) {
  const res = capture();
  const store = {
    bots: bots as never,
    bot: (id: string) => bots.find((bot) => bot.id === id) as never,
    patchBot: vi.fn((id: string, patch: Record<string, unknown>) => {
      const bot = bots.find((candidate) => candidate.id === id);
      if (!bot) return null;
      Object.assign(bot, patch);
      if (patch.instaboxMachineId === undefined) delete bot.instaboxMachineId;
      return bot;
    }),
  };
  const route = createInstaboxRoutes({
    store: store as never,
    cfg: () => ({ instabox: { apiKey: KEY } }),
    client: () => client as InstaboxClient,
  });
  const ctx: RouteContext = {
    req: { headers: { "content-type": "application/json" } } as IncomingMessage,
    res,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method,
    auth: { kind: "loopback", scopes: ["admin"] },
    json,
    readBody: async () => body,
  };
  return route(ctx).then(() => ({ status: res.statusCode, body: res.payload, store }));
}

describe("InstaBox routes", () => {
  it("lists machines and assigns one that already exists, refusing a second owner and a create", async () => {
    const listMachines = vi.fn(async () => [{ id: MACHINE, name: "nomi-desk", state: "running", ready: true, templateId: "agent-browser" }]);
    const bots = [{ id: "nomi", name: "Nomi", busy: false }, { id: "quinn", name: "Quinn", busy: false, instaboxMachineId: MACHINE }];
    const listed = await call("/api/instabox/machines", "GET", null, { listMachines }, bots);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(KEY);
    expect(listed.body).toMatchObject({ configured: true, machines: [{ id: MACHINE, assignedBotName: "Quinn" }] });

    const taken = await call("/api/instabox/assignments", "POST", { botId: "nomi", machineId: MACHINE }, { listMachines }, bots);
    expect(taken.status).toBe(409);

    bots[1]!.instaboxMachineId = undefined;
    const assigned = await call("/api/instabox/assignments", "POST", { botId: "nomi", machineId: MACHINE }, { listMachines }, bots);
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ botId: "nomi", cloudBackend: "instabox", instaboxMachineId: MACHINE, computer: "cloud" });

    const created = await call("/api/instabox/machines", "POST", { name: "paid" }, { listMachines }, bots);
    expect(created.status).toBe(404);
    expect(JSON.stringify(created.body)).toMatch(/does not create/);
  });

  it("refuses provision for an InstaBox bot before any machine can be created", async () => {
    const bots = [{ id: "nomi", name: "Nomi", cloudBackend: "instabox", instaboxMachineId: MACHINE, busy: false }];
    const refused = await call(`/api/bots/nomi/computer/provision`, "POST", {}, {}, bots);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/does not create or delete/);
  });

  it("reconnects only the assigned machine", async () => {
    const reconnect = vi.fn(async () => ({ id: MACHINE, name: "nomi-desk", state: "running", ready: true, templateId: null }));
    const bots = [{ id: "nomi", name: "Nomi", cloudBackend: "instabox", instaboxMachineId: MACHINE, busy: false }];
    const result = await call("/api/instabox/reconnect", "POST", { botId: "nomi" }, { reconnect }, bots);
    expect(result.status).toBe(200);
    expect(reconnect).toHaveBeenCalledWith(MACHINE);
    expect(JSON.stringify(result.body)).not.toContain(KEY);
  });
});
