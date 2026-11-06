// Direct InstaBox adapter (https://api.instabox.sh). Boat is a different provider.
// This client never creates, forks, deletes, or resizes a machine. Resume and
// start run only from reconnect(), and only for a machine the caller already named.
import { randomBytes, randomUUID } from "node:crypto";

import type { AppConfig } from "./config.ts";

export const INSTABOX_API_ORIGIN = "https://api.instabox.sh";
/** `m_` plus 26 characters, the id shape GET /v1/machines returns. Names are not accepted. */
export const INSTABOX_MACHINE_ID = /^m_[a-z0-9]{26}$/;
const SCREENSHOT_PATH = /^\/tmp\/openmausbot-instabox-[a-f0-9]{16}\.png$/;
const KEY_TOKEN = /^[A-Za-z0-9_+]+$/;

export function isInstaboxMachineId(value: unknown): value is string {
  return typeof value === "string" && INSTABOX_MACHINE_ID.test(value);
}

/** Last-ditch scrub. Callers must not log the key; this only cleans an error that echoed it. */
export function scrubInstaboxSecret(text: string, secret: string | undefined): string {
  const key = secret?.trim() ?? "";
  if (key.length < 8 || !text.includes(key)) return text;
  return text.split(key).join("••••••");
}

export class InstaboxError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "InstaboxError";
    this.status = status;
    this.code = code;
  }
}

export interface InstaboxMachine {
  id: string;
  name: string;
  state: string;
  ready: boolean;
  templateId: string | null;
}

export interface InstaboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface InstaboxDesktopStatus {
  installed: boolean;
  running: boolean;
  width?: number;
  height?: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface InstaboxClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  /** Tests only. Production ignores anything other than the public API origin. */
  baseUrl?: string;
  now?: () => number;
}

const MACHINE_PATH = /^\/v1\/machines\/m_[a-z0-9]{26}$/;
const MACHINE_WRITE = /^\/v1\/machines\/m_[a-z0-9]{26}\/(?:exec|desktop|resume|start)$/;
const SCREENSHOT_QUERY = /^\/v1\/machines\/m_[a-z0-9]{26}\/files\/content$/;

/** Only the calls this adapter makes. POST /v1/machines (create) is refused, as are stop, delete, fork, and resize. */
export function instaboxRequestAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const [pathname, query, extra] = path.split("?");
  if (extra !== undefined || pathname === undefined) return false;
  if (verb === "POST" && pathname === "/v1/machines") return false;
  if (verb === "GET" && pathname === "/v1/machines") {
    if (!query) return false;
    const params = new URLSearchParams(query);
    const names = [...params.keys()];
    return names.length > 0 && names.every((name) => name === "limit" || name === "cursor") && params.get("limit") === "100";
  }
  if (verb === "GET" && MACHINE_PATH.test(pathname)) return query === undefined;
  if (verb === "GET" && SCREENSHOT_QUERY.test(pathname)) {
    const params = new URLSearchParams(query ?? "");
    const file = params.get("path");
    return file !== null && SCREENSHOT_PATH.test(file) && [...params.keys()].every((name) => name === "path");
  }
  return verb === "POST" && query === undefined && MACHINE_WRITE.test(pathname);
}

function pixel(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 32767) {
    throw new InstaboxError(`${name} must be a whole number of pixels from 0 to 32767.`, 400, "bad_request");
  }
  return value;
}

/** Desktop commands are fixed templates. A model shell uses shell(), which is one JSON cmd on the assigned machine. */
function assertDesktopCommand(command: string): void {
  const pixel = "(?:0|[1-9]\\d{0,4})";
  const allowed = new RegExp(
    `^(?:xdotool getdisplaygeometry|xdotool mousemove ${pixel} ${pixel}(?: click --repeat [1-3] --delay 80 [1-3]| click --repeat (?:[1-9]|[12]\\d|30) --delay 30 [4-7]| mousedown 1 sleep 0\\.1 mousemove ${pixel} ${pixel} sleep 0\\.1 mouseup 1)|xdotool type --delay 12 --file -|xdotool key --clearmodifiers '(?:[A-Za-z0-9_+]{1,100})'|nohup xdg-open 'https?:\\/\\/[^'\\s]{1,2000}' >/dev/null 2>&1 </dev/null &)$`,
  );
  if (!allowed.test(command)) throw new InstaboxError("That desktop command is not allowed.", 400, "bad_request");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function publicMachine(value: unknown): InstaboxMachine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { id?: unknown; name?: unknown; state?: unknown; runtime?: { ready?: unknown }; template?: { id?: unknown } };
  if (!isInstaboxMachineId(row.id)) return null;
  const name = typeof row.name === "string" && row.name.length <= 80 ? row.name : row.id;
  const state = typeof row.state === "string" && /^[a-z_]{1,32}$/.test(row.state) ? row.state : "unknown";
  return {
    id: row.id,
    name,
    state,
    ready: state === "running" && row.runtime?.ready !== false,
    templateId: typeof row.template?.id === "string" ? row.template.id.slice(0, 80) : null,
  };
}

export function instaboxApiKey(cfg: Pick<AppConfig, "instabox">): string | null {
  const key = cfg.instabox?.apiKey?.trim();
  return key ? key : null;
}

export function createInstaboxClient(options: InstaboxClientOptions) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new InstaboxError("InstaBox is not connected. Add an API key in Settings → API keys.", 409, "not_configured");
  const base = options.baseUrl ?? INSTABOX_API_ORIGIN;
  let origin: URL;
  try { origin = new URL(base); } catch { throw new InstaboxError("InstaBox API address is invalid.", 400, "bad_request"); }
  if (origin.origin !== INSTABOX_API_ORIGIN && origin.hostname !== "127.0.0.1") {
    throw new InstaboxError("InstaBox requests stay on the public API.", 400, "bad_request");
  }
  const fetchImpl = options.fetch ?? fetch;
  const lanes = new Map<string, Promise<void>>();

  async function request(method: string, path: string, init: { body?: unknown; idempotent?: boolean; accept?: string; timeoutMs?: number } = {}): Promise<Response> {
    if (!instaboxRequestAllowed(method, path)) {
      throw new InstaboxError("OpenMausBot will not create, delete, fork, or resize an InstaBox machine.", 403, "refused");
    }
    const headers: Record<string, string> = { accept: init.accept ?? "application/json", "x-api-key": apiKey };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotent) headers["idempotency-key"] = randomUUID();
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin).toString(), {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "InstaBox did not answer in time."
        : "InstaBox could not be reached.";
      throw new InstaboxError(message, 503, "unreachable");
    }
    return response;
  }

  async function readJson(response: Response): Promise<unknown> {
    if (response.ok) {
      const text = await response.text();
      if (!text) return null;
      try { return JSON.parse(text) as unknown; }
      catch { throw new InstaboxError("InstaBox sent a response OpenMausBot could not read.", response.status, "invalid_response"); }
    }
    const raw = await response.text();
    let code = "http_error";
    let message = `InstaBox answered HTTP ${response.status}.`;
    try {
      const body = JSON.parse(raw) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
      const nested = body.error && typeof body.error === "object" ? body.error : undefined;
      const foundCode = typeof nested?.code === "string" ? nested.code : typeof body.code === "string" ? body.code : "";
      const foundMessage = typeof nested?.message === "string" ? nested.message : typeof body.message === "string" ? body.message : "";
      if (/^[a-z0-9_]{1,64}$/.test(foundCode)) code = foundCode;
      if (foundMessage && foundMessage.length <= 300) message = foundMessage;
    } catch { /* a non-JSON error page stays a status line */ }
    throw new InstaboxError(scrubInstaboxSecret(message, apiKey), response.status, code);
  }

  function machinePath(id: string, suffix = ""): string {
    if (!isInstaboxMachineId(id)) throw new InstaboxError("That is not an InstaBox machine id.", 400, "bad_request");
    return `/v1/machines/${id}${suffix}`;
  }

  async function getMachine(id: string): Promise<InstaboxMachine> {
    const body = await readJson(await request("GET", machinePath(id)));
    const machine = publicMachine(body);
    if (!machine) throw new InstaboxError("InstaBox did not return that machine.", 502, "invalid_response");
    return machine;
  }

  async function listMachines(): Promise<InstaboxMachine[]> {
    const machines: InstaboxMachine[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const path = cursor ? `/v1/machines?limit=100&cursor=${encodeURIComponent(cursor)}` : "/v1/machines?limit=100";
      const body = await readJson(await request("GET", path)) as { machines?: unknown; nextCursor?: unknown };
      const rows = Array.isArray(body?.machines) ? body.machines : [];
      for (const row of rows) {
        const machine = publicMachine(row);
        if (!machine || seen.has(machine.id)) continue;
        seen.add(machine.id);
        machines.push(machine);
      }
      cursor = typeof body?.nextCursor === "string" && body.nextCursor.length > 0 && body.nextCursor.length <= 512
        ? body.nextCursor
        : null;
      if (!cursor) break;
    }
    return machines;
  }

  async function exec(id: string, cmd: string, extra: { stdin?: string; timeoutSeconds?: number } = {}): Promise<InstaboxExecResult> {
    const body = await readJson(await request("POST", machinePath(id, "/exec"), {
      body: {
        cmd,
        ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}),
        timeoutSeconds: extra.timeoutSeconds ?? 60,
      },
      timeoutMs: ((extra.timeoutSeconds ?? 60) + 15) * 1000,
    })) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; timedOut?: unknown };
    return {
      stdout: typeof body?.stdout === "string" ? body.stdout : "",
      stderr: typeof body?.stderr === "string" ? body.stderr : "",
      exitCode: typeof body?.exitCode === "number" ? body.exitCode : 1,
      timedOut: body?.timedOut === true,
    };
  }

  async function desktop(id: string, action: "status" | "start" | "install"): Promise<InstaboxDesktopStatus & { failed?: boolean; hint?: string }> {
    const body = await readJson(await request("POST", machinePath(id, "/desktop"), {
      body: action === "start" ? { action, width: 1280, height: 800 } : { action },
      timeoutMs: 90_000,
    })) as { installed?: unknown; running?: unknown; failed?: unknown; hint?: unknown; width?: unknown; height?: unknown };
    return {
      installed: body?.installed === true,
      running: body?.running === true,
      failed: body?.failed === true,
      ...(typeof body?.hint === "string" ? { hint: scrubInstaboxSecret(body.hint, apiKey).slice(0, 300) } : {}),
      ...(typeof body?.width === "number" ? { width: body.width } : {}),
      ...(typeof body?.height === "number" ? { height: body.height } : {}),
    };
  }

  async function withLane<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = lanes.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settled = previous.then(() => undefined, () => undefined);
    const tail = settled.then(() => gate);
    lanes.set(id, tail);
    await settled;
    try { return await fn(); }
    finally {
      release();
      if (lanes.get(id) === tail) lanes.delete(id);
    }
  }

  async function waitUntilRunning(id: string, deadline: number): Promise<InstaboxMachine> {
    let machine = await getMachine(id);
    while (machine.state !== "running") {
      if (machine.state === "error" || machine.state === "deleting") {
        throw new InstaboxError(`This InstaBox machine is ${machine.state}. Nothing was created.`, 409, "machine_unavailable");
      }
      if ((options.now?.() ?? Date.now()) > deadline) {
        throw new InstaboxError(`This InstaBox machine is still ${machine.state}. Try reconnect again.`, 504, "operation_timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      machine = await getMachine(id);
    }
    return machine;
  }

  return {
    listMachines,
    getMachine,
    async reconnect(id: string): Promise<InstaboxMachine> {
      return withLane(id, async () => {
        const deadline = (options.now?.() ?? Date.now()) + 90_000;
        let machine = await getMachine(id);
        if (machine.state === "deleting") {
          throw new InstaboxError("This InstaBox machine is being deleted. Nothing was created.", 409, "machine_unavailable");
        }
        if (machine.state === "suspended" || machine.state === "suspending") {
          await readJson(await request("POST", machinePath(id, "/resume"), { idempotent: true }));
        } else if (machine.state === "stopped" || machine.state === "stopping") {
          await readJson(await request("POST", machinePath(id, "/start"), { idempotent: true }));
        } else if (machine.state === "error") {
          throw new InstaboxError("This InstaBox machine is in an error state. Nothing was created.", 409, "machine_unavailable");
        }
        machine = await waitUntilRunning(id, deadline);
        let desktopStatus = await desktop(id, "status").catch(() => ({ installed: false, running: false, failed: false as boolean, hint: undefined as string | undefined }));
        if (!desktopStatus.installed) {
          desktopStatus = await desktop(id, "install");
          const installDeadline = (options.now?.() ?? Date.now()) + 60_000;
          while (!desktopStatus.installed) {
            if (desktopStatus.failed) {
              throw new InstaboxError(desktopStatus.hint || "The desktop could not be installed on this existing machine.", 409, "desktop_install_failed");
            }
            if ((options.now?.() ?? Date.now()) > installDeadline) {
              throw new InstaboxError("The desktop install did not finish. Try reconnect again.", 504, "operation_timeout");
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            desktopStatus = await desktop(id, "status");
          }
        }
        if (!desktopStatus.running) await desktop(id, "start");
        return getMachine(id);
      });
    },
    async screenshot(id: string): Promise<{ png: string }> {
      return withLane(id, async () => {
        const machine = await getMachine(id);
        if (machine.state !== "running") {
          throw new InstaboxError(`This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`, 409, "machine_not_running");
        }
        const path = `/tmp/openmausbot-instabox-${randomBytes(8).toString("hex")}.png`;
        const quoted = shellQuote(path);
        const shot = await exec(id, `export DISPLAY=:1; if command -v scrot >/dev/null; then scrot -o ${quoted}; elif command -v import >/dev/null; then import -window root png:${quoted}; else echo 'no screenshot tool on this machine' >&2; exit 127; fi`, { timeoutSeconds: 30 });
        if (shot.exitCode !== 0) {
          throw new InstaboxError(scrubInstaboxSecret(shot.stderr.trim().slice(0, 300) || "The desktop screenshot failed.", apiKey), 409, "desktop_not_running");
        }
        try {
          const response = await request("GET", `${machinePath(id, "/files/content")}?path=${encodeURIComponent(path)}`, { accept: "application/octet-stream", timeoutMs: 30_000 });
          if (!response.ok) throw new InstaboxError("The screenshot could not be read back.", response.status, "screenshot_read_failed");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength < 8 || bytes.byteLength > 8_000_000 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
            throw new InstaboxError("The screenshot was not a PNG.", 502, "invalid_response");
          }
          return { png: Buffer.from(bytes).toString("base64") };
        } finally {
          if (SCREENSHOT_PATH.test(path)) await exec(id, `rm -f ${quoted}`, { timeoutSeconds: 15 }).catch(() => undefined);
        }
      });
    },
    async desktopCommand(id: string, command: string, stdin?: string): Promise<InstaboxExecResult> {
      assertDesktopCommand(command);
      return withLane(id, async () => {
        const machine = await getMachine(id);
        if (machine.state !== "running") {
          throw new InstaboxError(`This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`, 409, "machine_not_running");
        }
        const result = await exec(id, `export DISPLAY=:1; ${command}`, stdin === undefined ? { timeoutSeconds: 30 } : { stdin, timeoutSeconds: 30 });
        return { ...result, stdout: scrubInstaboxSecret(result.stdout, apiKey), stderr: scrubInstaboxSecret(result.stderr, apiKey) };
      });
    },
    click(id: string, x: number, y: number, button = 1, repeat = 1) {
      if (!Number.isInteger(button) || button < 1 || button > 3) throw new InstaboxError("That mouse button is not allowed.", 400, "bad_request");
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new InstaboxError("That click count is not allowed.", 400, "bad_request");
      return this.desktopCommand(id, `xdotool mousemove ${pixel("x", x)} ${pixel("y", y)} click --repeat ${repeat} --delay 80 ${button}`);
    },
    move(id: string, x: number, y: number) {
      return this.desktopCommand(id, `xdotool mousemove ${pixel("x", x)} ${pixel("y", y)}`);
    },
    drag(id: string, x: number, y: number, toX: number, toY: number) {
      return this.desktopCommand(id, `xdotool mousemove ${pixel("x", x)} ${pixel("y", y)} mousedown 1 sleep 0.1 mousemove ${pixel("toX", toX)} ${pixel("toY", toY)} sleep 0.1 mouseup 1`);
    },
    scroll(id: string, x: number, y: number, button: number, amount: number) {
      if (!Number.isInteger(button) || button < 4 || button > 7) throw new InstaboxError("That scroll direction is not allowed.", 400, "bad_request");
      if (!Number.isInteger(amount) || amount < 1 || amount > 30) throw new InstaboxError("That scroll amount is not allowed.", 400, "bad_request");
      return this.desktopCommand(id, `xdotool mousemove ${pixel("x", x)} ${pixel("y", y)} click --repeat ${amount} --delay 30 ${button}`);
    },
    typeText(id: string, text: string) {
      return this.desktopCommand(id, "xdotool type --delay 12 --file -", text);
    },
    press(id: string, key: string) {
      if (!KEY_TOKEN.test(key)) throw new InstaboxError("That key is not allowed.", 400, "bad_request");
      return this.desktopCommand(id, `xdotool key --clearmodifiers ${shellQuote(key)}`);
    },
    openUrl(id: string, url: string) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new InstaboxError("That URL is not valid.", 400, "bad_request"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new InstaboxError("Only http and https URLs open on the desktop.", 400, "bad_request");
      }
      return this.desktopCommand(id, `nohup xdg-open ${shellQuote(parsed.href)} >/dev/null 2>&1 </dev/null &`);
    },
    shell(id: string, command: string) {
      if (typeof command !== "string" || command.length < 1 || command.length > 4000) {
        throw new InstaboxError("That shell command is not allowed.", 400, "bad_request");
      }
      if (command.includes(apiKey)) throw new InstaboxError("That shell command is not allowed.", 400, "bad_request");
      return withLane(id, async () => {
        const machine = await getMachine(id);
        if (machine.state !== "running") {
          throw new InstaboxError(`This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`, 409, "machine_not_running");
        }
        const result = await exec(id, command, { timeoutSeconds: 60 });
        return { ...result, stdout: scrubInstaboxSecret(result.stdout, apiKey), stderr: scrubInstaboxSecret(result.stderr, apiKey) };
      });
    },
  };
}

export type InstaboxClient = ReturnType<typeof createInstaboxClient>;

let cachedClient: { key: string; client: InstaboxClient } | null = null;

export function instaboxClient(cfg: Pick<AppConfig, "instabox">): InstaboxClient {
  const apiKey = instaboxApiKey(cfg);
  if (!apiKey) throw new InstaboxError("InstaBox is not connected. Add an API key in Settings → API keys.", 409, "not_configured");
  if (cachedClient?.key !== apiKey) cachedClient = { key: apiKey, client: createInstaboxClient({ apiKey }) };
  return cachedClient.client;
}

export function resetInstaboxClients(): void {
  cachedClient = null;
}

export interface InstaboxAssignmentBot {
  id: string;
  name: string;
  instaboxMachineId?: string;
  busy?: boolean;
}

/** One existing machine for one bot. Clearing a bot never assigns it to Boat. */
export function planInstaboxAssignment(
  bots: readonly InstaboxAssignmentBot[],
  botId: string,
  machineId: string | null,
): { ok: true; patch: { instaboxMachineId?: string; cloudBackend: "instabox"; computer?: "cloud" } } | { ok: false; status: number; error: string } {
  const bot = bots.find((candidate) => candidate.id === botId);
  if (!bot) return { ok: false, status: 404, error: "no such bot" };
  if (bot.busy) return { ok: false, status: 409, error: "stop the active turn before changing this bot's InstaBox machine" };
  if (machineId === null) {
    return { ok: true, patch: { instaboxMachineId: undefined, cloudBackend: "instabox" } };
  }
  if (!isInstaboxMachineId(machineId)) return { ok: false, status: 400, error: "machineId must be an existing InstaBox machine id" };
  const holder = bots.find((candidate) => candidate.id !== botId && candidate.instaboxMachineId === machineId);
  if (holder) return { ok: false, status: 409, error: `${holder.name} already uses this InstaBox machine. Choose a different one.` };
  return { ok: true, patch: { instaboxMachineId: machineId, cloudBackend: "instabox", computer: "cloud" } };
}

export function instaboxOwner(bots: readonly InstaboxAssignmentBot[], machineId: string, botId: string): string | null {
  const holders = bots.filter((bot) => bot.instaboxMachineId === machineId);
  if (holders.length !== 1 || holders[0]!.id !== botId) return "This action is limited to the one bot assigned to this InstaBox machine.";
  return null;
}

/** Instabox never falls through to Boat, including when a routine asks for a cloud desktop. */
export function resolveTurnCloudBackend(
  bot: { cloudBackend?: string | null },
  teamComputer: boolean,
  runOn: string | undefined,
): "box" | "vps" | "instabox" {
  if (bot.cloudBackend === "instabox") return "instabox";
  return teamComputer || runOn === "cloud" || bot.cloudBackend !== "vps" ? "box" : "vps";
}

export function instaboxTurnPlan(input: {
  backend: "box" | "vps" | "instabox";
  wants: "cloud" | "vm" | "local" | "off" | undefined;
  configured: boolean;
  assigned: boolean;
}): "mount" | "skip" | "fail-unconfigured" | "fail-unassigned" {
  if (input.backend !== "instabox") return "skip";
  if (input.wants !== "cloud" && input.wants !== undefined) return "skip";
  if (!input.configured) return input.wants === "cloud" ? "fail-unconfigured" : "skip";
  if (!input.assigned) return input.wants === "cloud" ? "fail-unassigned" : "skip";
  return "mount";
}

export const INSTABOX_NOT_CONFIGURED = "InstaBox is not connected. Add an API key in Settings → API keys.";
export const INSTABOX_NOT_ASSIGNED = "No InstaBox machine is assigned to this bot. Choose an existing machine in Settings → Computers.";
export const INSTABOX_NO_CREATE = "OpenMausBot does not create or delete InstaBox machines. Choose an existing machine in Settings → Computers.";

export function instaboxComputerActionError(action: string): string | null {
  if (action === "screenshot") return null;
  if (action === "provision" || action === "remove") return INSTABOX_NO_CREATE;
  if (action === "sleep") return "OpenMausBot does not stop an InstaBox machine. Pause it in InstaBox if you want it to rest.";
  if (action === "join") return "Watch this machine in the InstaBox dashboard. OpenMausBot drives the assigned desktop with the bot's computer actions.";
  if (action === "exec") return "Use the bot's computer actions on its assigned InstaBox machine.";
  return INSTABOX_NO_CREATE;
}

export async function instaboxBotStatus(
  cfg: Pick<AppConfig, "instabox">,
  bot: { instaboxMachineId?: string },
  client: Pick<InstaboxClient, "getMachine"> | null = instaboxApiKey(cfg) ? instaboxClient(cfg) : null,
): Promise<{ configured: boolean; machineId: string | null; name: string | null; state: string | null; ready: boolean; problem: string | null }> {
  if (!instaboxApiKey(cfg) || !client) {
    return { configured: false, machineId: null, name: null, state: null, ready: false, problem: INSTABOX_NOT_CONFIGURED };
  }
  if (!isInstaboxMachineId(bot.instaboxMachineId)) {
    return { configured: true, machineId: null, name: null, state: null, ready: false, problem: INSTABOX_NOT_ASSIGNED };
  }
  try {
    const machine = await client.getMachine(bot.instaboxMachineId);
    const ready = machine.ready;
    return {
      configured: true,
      machineId: machine.id,
      name: machine.name,
      state: machine.state,
      ready,
      problem: ready ? null : `This InstaBox machine is ${machine.state}. Reconnect it in Settings → Computers. Nothing was created.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "InstaBox could not be reached.";
    return { configured: true, machineId: bot.instaboxMachineId, name: null, state: null, ready: false, problem: scrubInstaboxSecret(message, instaboxApiKey(cfg) ?? undefined) };
  }
}
