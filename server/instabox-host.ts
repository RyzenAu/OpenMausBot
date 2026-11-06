import type { AppConfig } from "./config.ts";
import { CLOUD_COMPUTER_TOOLS } from "./cloud-computer-tools.ts";
import {
  INSTABOX_NOT_ASSIGNED,
  INSTABOX_NOT_CONFIGURED,
  instaboxApiKey,
  instaboxClient,
  instaboxOwner,
  instaboxTurnPlan,
  isInstaboxMachineId,
  type InstaboxAssignmentBot,
} from "./instabox.ts";
import { runInstaboxComputerTool } from "./instabox-tools.ts";
import { createInstaboxRoutes } from "./routes/instabox.ts";

export { instaboxClient, resolveTurnCloudBackend } from "./instabox.ts";
export { createInstaboxRoutes };

export async function applyInstaboxSelection(
  cfg: Pick<AppConfig, "instabox">,
  bot: { cloudBackend?: string; instaboxMachineId?: string },
  reason: string,
): Promise<{ handled: true; ready: boolean; canStart: false; canCreate: false; reason: string } | { handled: false }> {
  if (bot.cloudBackend !== "instabox") return { handled: false };
  const assigned = isInstaboxMachineId(bot.instaboxMachineId);
  let ready = Boolean(instaboxApiKey(cfg) && assigned);
  let next = !instaboxApiKey(cfg) ? INSTABOX_NOT_CONFIGURED : !assigned ? INSTABOX_NOT_ASSIGNED : reason;
  if (ready && bot.instaboxMachineId) {
    try {
      const machine = await instaboxClient(cfg).getMachine(bot.instaboxMachineId);
      ready = machine.ready;
      if (!ready) next = `This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`;
    } catch (error) {
      ready = false;
      next = error instanceof Error ? error.message : INSTABOX_NOT_CONFIGURED;
    }
  }
  return { handled: true, ready, canStart: false, canCreate: false, reason: next };
}

export async function claimInstaboxTurn(input: {
  cfg: Pick<AppConfig, "instabox">;
  bot: { id: string; name: string; cloudBackend?: string; instaboxMachineId?: string };
  wants: "cloud" | "vm" | "local" | "off" | undefined;
  cloudBackend: "box" | "vps" | "instabox";
  canUse: boolean;
  bots: readonly InstaboxAssignmentBot[];
  liveBot(): { instaboxMachineId?: string; cloudBackend?: string } | null | undefined;
  mount(machineId: string): void;
  arm(claim: () => Promise<void>): void;
  bind(machineId: string): Promise<void>;
  show(machineId: string): void;
  pin(): void;
}): Promise<"instabox" | null> {
  const plan = instaboxTurnPlan({
    backend: input.cloudBackend,
    wants: input.wants,
    configured: Boolean(instaboxApiKey(input.cfg)),
    assigned: isInstaboxMachineId(input.bot.instaboxMachineId),
  });
  if (plan === "fail-unconfigured") throw new Error(INSTABOX_NOT_CONFIGURED);
  if (plan === "fail-unassigned") throw new Error(INSTABOX_NOT_ASSIGNED);
  if (plan === "mount" && input.wants === "cloud" && !input.canUse) {
    throw new Error("this model can't use the InstaBox desktop — choose a model that can, such as Claude");
  }
  if (plan !== "mount" || !input.canUse || !isInstaboxMachineId(input.bot.instaboxMachineId)) return null;
  const machineId = input.bot.instaboxMachineId;
  input.mount(machineId);
  input.arm(async () => {
    const live = input.liveBot();
    const isolation = instaboxOwner(input.bots, machineId, input.bot.id);
    if (!live || live.instaboxMachineId !== machineId || live.cloudBackend !== "instabox" || isolation) {
      throw new Error(isolation ?? "This bot's InstaBox machine changed.");
    }
    const machine = await instaboxClient(input.cfg).getMachine(machineId);
    if (!machine.ready) throw new Error(`This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`);
    await input.bind(machineId);
    input.show(machineId);
    input.pin();
  });
  return "instabox";
}

export async function instaboxMcpAnswer(
  body: { method?: unknown; params?: unknown } | null | undefined,
  input: {
    machineId: string | undefined;
    botId: string;
    bots: readonly InstaboxAssignmentBot[];
    cfg: Pick<AppConfig, "instabox">;
    assertActive(): void;
  },
): Promise<{ status: number; body: unknown } | null> {
  if (!input.machineId) return null;
  const isolation = instaboxOwner(input.bots, input.machineId, input.botId);
  if (isolation) return { status: 403, body: { error: isolation } };
  const params = (body?.params && typeof body.params === "object" ? body.params : {}) as { name?: unknown; arguments?: unknown };
  if (body?.method === "tools/list") return { status: 200, body: { result: { tools: CLOUD_COMPUTER_TOOLS } } };
  if (body?.method !== "tools/call") return { status: 400, body: { error: "unsupported computer method" } };
  input.assertActive();
  const result = await runInstaboxComputerTool(
    instaboxClient(input.cfg),
    input.machineId,
    String(params.name ?? ""),
    (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>,
  );
  input.assertActive();
  return { status: 200, body: { result } };
}
