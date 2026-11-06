import { cloudComputerCallProblem, type CloudComputerResult } from "./cloud-computer-tools.ts";
import type { InstaboxClient } from "./instabox.ts";

const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
const scrollButtons: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

function text(value: string, isError = false): CloudComputerResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: value }] };
}

/** Arguments are checked with the same schema as the other cloud desktop. The machine id is the bot's assignment. */
export async function runInstaboxComputerTool(
  client: Pick<InstaboxClient, "screenshot" | "click" | "move" | "drag" | "scroll" | "typeText" | "press" | "openUrl" | "shell" | "desktopCommand">,
  machineId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CloudComputerResult> {
  const problem = cloudComputerCallProblem(name, args);
  if (problem) return text(problem, true);
  try {
    if (name === "screenshot") {
      const shot = await client.screenshot(machineId);
      return { content: [{ type: "image", mimeType: "image/png", data: shot.png }] };
    }
    const point = args as { x: number; y: number; to_x?: number; to_y?: number; button?: string; count?: number; text?: string; key?: string; direction?: string; amount?: number; url?: string; command?: string };
    let result;
    switch (name) {
      case "get_screen_size":
        result = await client.desktopCommand(machineId, "xdotool getdisplaygeometry");
        break;
      case "click":
        result = await client.click(machineId, point.x, point.y, buttons[point.button ?? "left"] ?? 1, point.count ?? 1);
        break;
      case "move":
        result = await client.move(machineId, point.x, point.y);
        break;
      case "drag":
        result = await client.drag(machineId, point.x, point.y, point.to_x ?? point.x, point.to_y ?? point.y);
        break;
      case "type_text":
        result = await client.typeText(machineId, String(point.text));
        break;
      case "key_press":
        result = await client.press(machineId, String(point.key));
        break;
      case "scroll":
        result = await client.scroll(machineId, point.x, point.y, scrollButtons[String(point.direction)] ?? 5, point.amount ?? 3);
        break;
      case "open_url":
        result = await client.openUrl(machineId, String(point.url));
        break;
      case "exec":
        result = await client.shell(machineId, String(point.command));
        break;
      default:
        return text("Unknown cloud computer tool.", true);
    }
    if (name === "open_url" && result.exitCode === 0) {
      return text("Browser launch requested. Page loading is not confirmed; inspect the screen before continuing.");
    }
    return text(JSON.stringify({ ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }), result.exitCode !== 0);
  } catch (error) {
    return text(error instanceof Error ? error.message : "InstaBox did not complete that action.", true);
  }
}
