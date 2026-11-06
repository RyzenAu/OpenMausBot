import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InstaboxComputersCard } from "./InstaboxComputersCard";

describe("InstaboxComputersCard", () => {
  it("lists existing machines and offers assign, clear, and reconnect without a create control", () => {
    const onAssign = vi.fn();
    const html = renderToStaticMarkup(createElement(InstaboxComputersCard, {
      configured: true,
      loading: false,
      error: null,
      pendingId: null,
      bots: [{ id: "nomi", name: "Nomi" }, { id: "quinn", name: "Quinn" }],
      machines: [{
        id: "m_agqteugyy5px6hzeadbh4ldjo4",
        name: "nomi-desk",
        state: "running",
        ready: true,
        assignedBotId: "nomi",
        assignedBotName: "Nomi",
      }],
      onRefresh: () => {},
      onAssign,
      onClear: () => {},
      onReconnect: () => {},
    }));
    expect(html).toContain("nomi-desk");
    expect(html).toContain("Assigned to Nomi");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Clear");
    expect(html.toLowerCase()).not.toContain("create machine");
    expect(html).not.toContain("ibx_");
  });

  it("says the key is missing and does not invent a machine", () => {
    const html = renderToStaticMarkup(createElement(InstaboxComputersCard, {
      configured: false,
      loading: false,
      error: null,
      pendingId: null,
      bots: [],
      machines: [],
      onRefresh: () => {},
      onAssign: () => {},
      onClear: () => {},
      onReconnect: () => {},
    }));
    expect(html).toContain("Add an InstaBox API key");
    expect(html).not.toContain("nomi-desk");
  });
});
