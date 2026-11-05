import { afterEach, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";

const { capture } = vi.hoisted(() => ({
  capture: {
    handler: undefined as
      | ((step: unknown, args: unknown) => Promise<unknown>)
      | undefined,
  },
}));
vi.mock("./lib/workflow", () => ({
  workflow: {
    define: (definition: { handler: typeof capture.handler }) => {
      capture.handler = definition.handler;
      return {};
    },
  },
}));
import "./workflows/prospecting";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("journaled named employer queries survive semantic screening and replay despite env/time changes", async () => {
  const named = ["Acme directeur marketing", "Beta directeur marketing"];
  const plan = {
    success: true,
    socialQueries: [...named, "directeur marketing"],
    accountResearchQueries: named,
    queryMetadata: [...named, "directeur marketing"].map((query) => ({
      query,
      platformTargets: ["linkedin"],
      linkedinSurfaceTargets: ["people"],
      queryStyle: "role_title",
      discoveryStage: "strict",
      targetingCriterionIds: [],
      legacyCompatibilitySource: false,
    })),
  };
  const screenCalls: unknown[] = [];
  const savedCalls: unknown[] = [];
  for (const enabled of [true, false]) {
    vi.stubEnv(
      "ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS",
      enabled ? "workspace" : ""
    );
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(enabled ? "2026-11-05" : "2027-11-05")
    );
    const step = {
      workflowId: "replay-account-workflow",
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({ limitReached: false })
        .mockResolvedValueOnce({
          _id: "workspace",
          description: "Find French companies",
          improvedDescription: "Find French companies",
          icps: [
            {
              title: "Companies",
              description: "Growing companies",
              painPoints: ["growth"],
              channels: ["linkedin"],
              syntheticPosts: ["We are expanding"],
            },
          ],
        })
        .mockResolvedValueOnce({ configured: true }),
      runAction: vi.fn(
        async (
          ref: FunctionReference<"action">,
          args: Record<string, unknown>
        ) => {
          const name = getFunctionName(ref);
          if (name.includes("generateProspectingKeywordsAction"))
            return { success: true, prospectingKeywords: ["expansion"] };
          if (name.includes("convertToSocialQueriesAction")) return plan;
          if (name.includes("screenDiscoveryQueryCandidatesInternal")) {
            screenCalls.push(args);
            return { accepted: [{ rawValue: "directeur marketing" }] };
          }
          throw new Error(`Unexpected action ${name}`);
        }
      ),
      runMutation: vi.fn(
        async (
          ref: FunctionReference<"mutation">,
          args: Record<string, unknown>
        ) => {
          if (getFunctionName(ref).includes("saveKeywordsInternal")) {
            savedCalls.push(args);
            throw new Error("Stopped after captured save");
          }
        }
      ),
    };
    await expect(
      capture.handler!(step, { workspaceId: "workspace" })
    ).rejects.toThrow("Stopped after captured save");
  }
  expect(screenCalls[0]).toEqual(screenCalls[1]);
  expect(screenCalls[0]).toMatchObject({
    candidates: [{ rawValue: "directeur marketing" }],
  });
  expect(savedCalls[0]).toEqual(savedCalls[1]);
  expect(savedCalls[0]).toMatchObject({
    socialQueries: [...named, "directeur marketing"],
  });
});
