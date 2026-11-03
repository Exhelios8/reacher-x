// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PostHogProvider } from "../../../app/PostHogProvider";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { init } }));
vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: ReactNode }) => children,
  usePostHog: () => undefined,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test.each(["", "phc_local_fixture"])(
  "optional analytics preserves the app with key %j",
  async (key) => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", key);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(PostHogProvider, {
          children: createElement("p", null, "App"),
        })
      );
    });
    expect(container.textContent).toBe("App");
    expect(init).toHaveBeenCalledTimes(key ? 1 : 0);
    await act(async () => root.unmount());
  }
);
