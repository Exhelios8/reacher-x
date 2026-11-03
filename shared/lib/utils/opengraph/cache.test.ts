import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

test("server cache imports without global timers and still expires entries", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", undefined);
  const interval = vi.spyOn(globalThis, "setInterval");
  const { openGraphCache } = await import("./cache");
  expect(interval).not.toHaveBeenCalled();

  openGraphCache.set("https://example.com", null, 10);
  expect(openGraphCache.has("https://example.com")).toBe(true);
  vi.advanceTimersByTime(11);
  expect(openGraphCache.get("https://example.com")).toBeUndefined();
  openGraphCache.destroy();
});
