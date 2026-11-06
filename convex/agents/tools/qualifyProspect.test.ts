// @vitest-environment node
import { asSchema } from "ai";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ToolCtx } from "@convex-dev/agent";
import { afterEach, expect, test, vi } from "vitest";
import { qualifyProspect } from "./qualifyProspect";
import {
  qualifyProspectCore,
  type QualificationResult,
} from "../../lib/qualificationCore";
import { evaluateQualificationWithExternalArticles } from "../../lib/qualificationEvaluationCore";
import { buildLegacyWorkspaceTargetingSpec } from "../../lib/targetingSpecCore";

vi.mock("../../lib/qualificationCore", () => ({
  qualifyProspectCore: vi.fn(),
  MAX_KEYWORDS_TO_SEARCH: 10,
  MAX_EVIDENCE_POSTS: 20,
}));
vi.mock("../../lib/qualificationEvaluationCore", () => ({
  evaluateQualificationWithExternalArticles: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(
  scenario:
    | "valid"
    | "missing identity"
    | "unsupported source"
    | "organization"
    | "opt-out"
    | "legacy"
    | "wrong owner"
    | "wrong workspace" = "valid"
) {
  const targetingSpec = buildLegacyWorkspaceTargetingSpec({
    description: "Relevant French businesses",
    profiles: [],
  });
  if (scenario !== "legacy") targetingSpec.discoveryMode = "peer_or_site_audit";
  const workspace = {
    _id: "workspace",
    userId: "owner",
    description: targetingSpec.summary,
    targetingSpec,
    icps:
      scenario === "legacy" ? [{ qualificationKeywords: ["catalogue"] }] : [],
  };
  const prospect = {
    _id: "prospect",
    userId: scenario === "wrong owner" ? "someone-else" : "owner",
    workspaceId:
      scenario === "wrong workspace" ? "another-workspace" : "workspace",
    platform: "linkedin",
    discoverySource:
      scenario === "unsupported source" ? "manual" : "search_people",
    prospectType: scenario === "organization" ? "organization" : "person",
    data: {},
    ...(scenario === "missing identity"
      ? {}
      : {
          linkedinUserUrn: "ACo123",
          socialProfiles: {
            linkedin: {
              urn: "ACo123",
              username: "operator",
              url: "https://www.linkedin.com/in/operator",
            },
          },
        }),
    qualificationStatus: "qualified",
    qualificationScore: 85,
    evidencePosts: [],
  };
  const runQuery = vi.fn(async (reference: FunctionReference<"query">) =>
    getFunctionName(reference).startsWith("prospects:") ? prospect : workspace
  );
  const runAction = vi.fn(async (reference: FunctionReference<"action">) =>
    getFunctionName(reference).startsWith("memory:")
      ? {}
      : { success: true, posts: [], matchedKeywords: [] }
  );
  const runMutation = vi.fn(
    async (
      _reference: FunctionReference<"mutation">,
      _args: Record<string, unknown>
    ) => ({ success: true, skipped: false })
  );
  const ctx = {
    userId: "owner",
    runQuery,
    runAction,
    runMutation,
  } as unknown as ToolCtx;
  vi.stubEnv(
    "ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS",
    scenario === "opt-out" ? "" : "workspace"
  );
  const result = {
    qualified: true,
    score: 60,
    status: "qualified",
    evidenceCount: 1,
    matchedKeywords: [],
    scoreBreakdown: {
      profileFit: 30,
      signalQuality: 30,
      intentStrength: 0,
      recency: 0,
      total: 60,
    },
    criterionResults: [],
    qualificationSources: [
      {
        verificationVersion: 1,
        evidenceKind: "profile",
        platform: "linkedin",
        contentType: "profile",
        sourceId: "profile:ACo123",
        sourceUrl: "https://www.linkedin.com/in/operator",
        authorId: "ACo123",
        text: "Directeur marketing chez Acme.",
        supportingQuote: "Directeur marketing chez Acme.",
        discoveryQueries: [],
        verifiedAt: Date.now(),
        sourcePost: { urn: "ACo123" },
      },
    ],
    qualificationVerification: {
      version: 1,
      status: "validated",
      candidateSourceCount: 1,
      supportedSourceCount: 1,
      discoveryQueries: [],
      validatedAt: Date.now(),
      routeAssessment: {
        route: "peer",
        needStatus: "unknown",
        rationale: "A verified relevant employer.",
        sourceUrl: "https://acme.fr/offre",
        sourceQuote: "Acme fournit un logiciel de gestion documentaire.",
        offerOrRemedy: "Examiner les pages produit et la documentation.",
      },
    },
    authenticity: { isLikelyBot: false, flags: [] },
    reasoning: "Relevant employer and role; need unknown.",
  } as QualificationResult;
  vi.mocked(evaluateQualificationWithExternalArticles).mockResolvedValue(
    result
  );
  vi.mocked(qualifyProspectCore).mockResolvedValue(result);
  const validated = await asSchema(qualifyProspect.inputSchema).validate?.({
    prospectId: "prospect",
    workspaceId: "workspace",
  });
  if (!validated?.success) throw new Error("Invalid test input");
  const tool = { ...qualifyProspect, ctx };
  const execute = () =>
    tool.execute!(validated.value, { toolCallId: "qualify", messages: [] });
  return { execute, runAction, runMutation, prospect, result };
}

test("V3 interactive qualification delegates to verified acquisition without ICP keywords or personal-post search", async () => {
  const { execute, runAction, runMutation } = await fixture();
  expect(await execute()).toMatchObject({
    success: true,
    qualified: true,
    status: "qualified",
    score: 60,
  });
  expect(
    evaluateQualificationWithExternalArticles
  ).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      workspaceId: "workspace",
      prospectId: "prospect",
      evidencePosts: [],
      routing: "onboarding",
    })
  );
  expect(qualifyProspectCore).not.toHaveBeenCalled();
  expect(
    runAction.mock.calls.every(([reference]) =>
      getFunctionName(reference).startsWith("memory:")
    )
  ).toBe(true);
  expect(runMutation).toHaveBeenCalledOnce();
  expect(runMutation.mock.calls[0][1]).not.toHaveProperty("evidencePosts");
});

test.each([
  "missing identity",
  "unsupported source",
  "organization",
  "opt-out",
  "wrong owner",
  "wrong workspace",
] as const)("%s leaves the stored verdict untouched", async (scenario) => {
  const { execute, runAction, runMutation, prospect } = await fixture(scenario);
  expect(await execute()).toMatchObject({ success: false, status: "pending" });
  expect(evaluateQualificationWithExternalArticles).not.toHaveBeenCalled();
  expect(runAction).not.toHaveBeenCalled();
  expect(runMutation).not.toHaveBeenCalled();
  expect(prospect.qualificationStatus).toBe("qualified");
});

test.each(["provider unavailable", "unverified contact"] as const)(
  "V3 %s returns pending without writing a negative decision",
  async (scenario) => {
    const { execute, runMutation, result } = await fixture();
    if (scenario === "provider unavailable")
      vi.mocked(evaluateQualificationWithExternalArticles).mockRejectedValue(
        new Error("[QualificationEvidence] Profile unavailable")
      );
    else
      vi.mocked(evaluateQualificationWithExternalArticles).mockResolvedValue({
        ...result,
        qualified: false,
        status: "disqualified",
        qualificationVerification: {
          ...result.qualificationVerification,
          routeAssessment: {
            route: "none",
            needStatus: "unknown",
            needsContactVerification: true,
            rationale: "Current employer has not been verified.",
          },
        },
      });
    expect(await execute()).toMatchObject({
      success: false,
      status: "pending",
    });
    expect(runMutation).not.toHaveBeenCalled();
  }
);

test("legacy interactive qualification keeps its post-search and core path", async () => {
  const { execute, runAction, runMutation } = await fixture("legacy");
  expect(await execute()).toMatchObject({ success: true, qualified: true });
  expect(evaluateQualificationWithExternalArticles).not.toHaveBeenCalled();
  expect(qualifyProspectCore).toHaveBeenCalledOnce();
  expect(
    runAction.mock.calls.some(([reference]) =>
      getFunctionName(reference).includes("searchUserPosts")
    )
  ).toBe(true);
  expect(runMutation).toHaveBeenCalledOnce();
});
