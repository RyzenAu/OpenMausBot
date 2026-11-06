import type { AppConfig } from "../config.ts";
import {
  INSTABOX_NO_CREATE,
  instaboxApiKey,
  instaboxBotStatus,
  instaboxClient,
  instaboxComputerActionError,
  instaboxOwner,
  isInstaboxMachineId,
  planInstaboxAssignment,
  scrubInstaboxSecret,
  type InstaboxClient,
  type InstaboxMachine,
} from "../instabox.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InstaboxRouteDeps {
  store: Pick<Store, "bot" | "bots" | "patchBot">;
  cfg: () => Pick<AppConfig, "instabox">;
  client?: () => InstaboxClient;
}

function assignmentBots(bots: readonly BotRecord[]) {
  return bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    ...(bot.instaboxMachineId ? { instaboxMachineId: bot.instaboxMachineId } : {}),
    busy: bot.busy === true,
  }));
}

function publicMachine(machine: InstaboxMachine, bots: readonly BotRecord[]) {
  const owners = bots.filter((bot) => bot.instaboxMachineId === machine.id);
  const owner = owners.length === 1 ? owners[0] : undefined;
  return {
    id: machine.id,
    name: machine.name,
    state: machine.state,
    ready: machine.ready && owners.length <= 1,
    templateId: machine.templateId,
    assignedBotId: owner?.id ?? null,
    assignedBotName: owner?.name ?? null,
    shared: owners.length > 1,
  };
}

function ownedBy(deps: InstaboxRouteDeps, botId: string, machineId: string): string | null {
  return instaboxOwner(assignmentBots(deps.store.bots), machineId, botId);
}

export function createInstaboxRoutes(deps: InstaboxRouteDeps): RouteHandler {
  const clientFor = () => deps.client?.() ?? instaboxClient(deps.cfg());
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const botAction = path.match(/^\/api\/bots\/([\w-]+)\/computer(?:\/([\w-]+))?$/);
    if (botAction) {
      const bot = deps.store.bot(botAction[1]!);
      if (!bot || bot.cloudBackend !== "instabox") return PASS;
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "InstaBox settings are an admin's." });
      res.setHeader("cache-control", "private, no-store");
      if (method === "GET" && !botAction[2]) {
        const status = await instaboxBotStatus(deps.cfg(), bot, instaboxApiKey(deps.cfg()) ? clientFor() : null);
        return json(res, 200, { surface: "cloud", backend: "instabox", ...status });
      }
      if (method === "POST" && botAction[2]) {
        const refusal = instaboxComputerActionError(botAction[2]);
        if (refusal) return json(res, 409, { error: refusal });
        if (!instaboxApiKey(deps.cfg()) || !isInstaboxMachineId(bot.instaboxMachineId)) {
          return json(res, 409, { error: !instaboxApiKey(deps.cfg()) ? "InstaBox is not connected. Add an API key in Settings → API keys." : "No InstaBox machine is assigned to this bot." });
        }
        const isolation = ownedBy(deps, bot.id, bot.instaboxMachineId);
        if (isolation) return json(res, 409, { error: isolation });
        try {
          const shot = await clientFor().screenshot(bot.instaboxMachineId);
          return json(res, 200, { png: shot.png, format: "png" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "The InstaBox desktop could not be read.";
          return json(res, 409, { error: scrubInstaboxSecret(message, instaboxApiKey(deps.cfg()) ?? undefined) });
        }
      }
      return PASS;
    }
    if (!path.startsWith("/api/instabox/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "InstaBox settings are an admin's." });
    res.setHeader("cache-control", "private, no-store");
    if (!instaboxApiKey(deps.cfg())) {
      if (method === "GET" && path === "/api/instabox/machines") {
        return json(res, 200, { configured: false, machines: [], problem: "InstaBox is not connected. Add an API key in Settings → API keys." });
      }
      return json(res, 409, { error: "InstaBox is not connected. Add an API key in Settings → API keys." });
    }
    try {
      if (method === "GET" && path === "/api/instabox/machines") {
        const machines = await clientFor().listMachines();
        return json(res, 200, { configured: true, machines: machines.map((machine) => publicMachine(machine, deps.store.bots)), problem: null });
      }
      if (method === "POST" && (path === "/api/instabox/assignments" || path === "/api/instabox/reconnect")) {
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        const body = await readBody(req);
        const botId = typeof body?.botId === "string" ? body.botId : "";
        if (path === "/api/instabox/reconnect") {
          const bot = deps.store.bot(botId);
          if (!bot) return json(res, 404, { error: "no such bot" });
          if (!isInstaboxMachineId(bot.instaboxMachineId)) return json(res, 409, { error: "No InstaBox machine is assigned to this bot." });
          const isolation = ownedBy(deps, bot.id, bot.instaboxMachineId);
          if (isolation) return json(res, 409, { error: isolation });
          if (bot.busy) return json(res, 409, { error: "stop the active turn before reconnecting this bot's InstaBox machine" });
          const machine = await clientFor().reconnect(bot.instaboxMachineId);
          return json(res, 200, { machine: publicMachine(machine, deps.store.bots) });
        }
        const machineId = body?.machineId === null || body?.machineId === "" ? null : body?.machineId;
        if (machineId !== null && !isInstaboxMachineId(machineId)) {
          return json(res, 400, { error: "machineId must be an existing InstaBox machine id, or null to clear it" });
        }
        if (machineId !== null) {
          const known = await clientFor().listMachines();
          if (!known.some((machine) => machine.id === machineId)) {
            return json(res, 404, { error: "That machine is not in this InstaBox account. Nothing was created." });
          }
        }
        const planned = planInstaboxAssignment(assignmentBots(deps.store.bots), botId, machineId);
        if (!planned.ok) return json(res, planned.status, { error: planned.error });
        const patch = { ...planned.patch };
        if (machineId === null) delete patch.computer;
        const saved = deps.store.patchBot(botId, patch);
        if (!saved) return json(res, 404, { error: "no such bot" });
        return json(res, 200, {
          botId: saved.id,
          cloudBackend: saved.cloudBackend ?? null,
          instaboxMachineId: saved.instaboxMachineId ?? null,
          computer: saved.computer ?? null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "InstaBox could not be reached.";
      return json(res, 502, { error: scrubInstaboxSecret(message, instaboxApiKey(deps.cfg()) ?? undefined) });
    }
    return json(res, 404, { error: INSTABOX_NO_CREATE });
  };
}
