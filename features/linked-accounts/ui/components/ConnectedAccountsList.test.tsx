// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ConnectedAccountsList } from "./ConnectedAccountsList";

test.each([
  { configured: false, status: "disconnected", button: undefined },
  { configured: true, status: "disconnected", button: "Connect" },
  { configured: false, status: "reconnect_required", button: undefined },
  { configured: true, status: "reconnect_required", button: "Reconnect" },
  { configured: true, status: "expired", button: "Reconnect" },
  { configured: false, status: "connected", button: "Disconnect" },
] as const)(
  "X $status with connection enabled=$configured leaves LinkedIn usable",
  ({ configured, status, button }) => {
    const html = renderToStaticMarkup(
      createElement(ConnectedAccountsList, {
        loading: false,
        googleEmail: "owner@example.com",
        isGoogleConnected: true,
        xStatus: {
          isConnected: status === "connected",
          status,
          connectionConfigured: configured,
          missingScopes: status === "reconnect_required" ? ["dm.write"] : [],
        },
        linkedinStatus: {
          isConnected: true,
          status: "connected",
          publicIdentifier: "owner",
        },
        onConnectX: vi.fn(),
        onDisconnectX: vi.fn(),
        onConnectLinkedIn: vi.fn(),
        onDisconnectLinkedIn: vi.fn(),
      })
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const [google, twitter, linkedin] = container.querySelectorAll("article");
    expect(google.textContent).toContain("owner@example.com");
    expect(twitter.querySelector("button")?.textContent).toBe(button);
    if (!configured && status !== "connected") {
      expect(twitter.textContent).toContain("Not enabled");
      expect(twitter.textContent).not.toContain("Reconnect");
    }
    expect(linkedin.textContent).toContain("@owner");
    expect(linkedin.querySelector("button")?.textContent).toBe("Disconnect");
  }
);
