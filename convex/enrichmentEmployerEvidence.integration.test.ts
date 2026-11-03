/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

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
vi.mock("./lib/retrierWorkflow", () => ({
  awaitRetriedActionResult: vi.fn(async () => ({
    returnValue: { success: true, posts: [], matchedKeywords: [] },
  })),
}));
import "./workflows/enrichment";

const enrichmentHandler = capture.handler!;
const modules = import.meta.glob("./**/*.ts");

test.each([
  "matching",
  "wrong person",
  "changed employer",
  "ambiguous employer",
  "wrong relationship",
  "unknown employer",
  "company account",
] as const)(
  "normal enrichment hands off only matching verified employer evidence: %s",
  async (scenario) => {
    const t = convexTest(schema, modules);
    const employerEvidence = {
      companyId: "42",
      sourceUrl: "https://www.linkedin.com/company/current-employer/",
      fetchedAt: "2026-11-03T10:00:00.000Z",
      relationshipSourceUrl:
        scenario === "wrong relationship"
          ? "https://www.linkedin.com/in/someone-else"
          : "https://www.linkedin.com/in/current-person",
      company: {
        name: "Current employer",
        website: "https://employer.example",
        headquarter: { city: "Paris", country: "France" },
      },
      officialWebsiteEvidence: {
        url: "https://employer.example/mentions-legales",
        retrievedAt: "2026-11-03T10:01:00.000Z",
        text: "Official company facts, not a personal quotation.",
      },
    };
    const originalPost = {
      id: "original-request",
      urn: "urn:li:activity:123",
      text: "Looking for help with search visibility.",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
      author: {
        urn: "urn:li:fsd_profile:person-1",
        url: "https://www.linkedin.com/in/current-person",
      },
    };
    const { prospectId, workspace } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        workosUserId: "employer-handoff-user",
        email: "handoff@example.com",
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        userId,
        name: "Employer handoff",
        description: "Workflow regression",
        isDefault: true,
        updatedAt: 1,
      });
      const prospectId = await ctx.db.insert("prospects", {
        userId,
        workspaceId,
        platform: "linkedin",
        origin: "workspace_discovery",
        externalId: "employer-handoff",
        discoverySource: "search_post",
        status: "new",
        qualificationStatus: "qualified",
        qualificationScore: 70,
        enrichmentStatus: "pending",
        data: { author: originalPost.author },
        evidencePosts: [originalPost],
        qualificationProfileData: {
          urn: "urn:li:fsd_profile:person-1",
          username: "current-person",
          employerEvidence,
          unusedRawPayload: { shouldNotEnterWorkflow: true },
        },
        updatedAt: 1,
      });
      return { prospectId, workspace: (await ctx.db.get(workspaceId))! };
    });
    const providerProfile = {
      urn:
        scenario === "wrong person"
          ? "urn:li:fsd_profile:someone-else"
          : "urn:li:fsd_profile:person-1",
      username: "current-person",
      linkedinUrl:
        scenario === "company account"
          ? "https://www.linkedin.com/company/current-employer/"
          : "https://www.linkedin.com/in/current-person",
      firstName: "Current",
      lastName: "Person",
      currentPositions:
        scenario === "unknown employer"
          ? []
          : scenario === "ambiguous employer"
            ? [{ company: { id: 42 } }, { company: { id: 99 } }]
            : [{ company: { id: scenario === "changed employer" ? 99 : 42 } }],
      // Historical roles must not supersede the explicit current employer.
      position: [{ companyId: 99, companyName: "Former", end: { year: 2025 } }],
    };
    const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
    const step = {
      workflowId: "employer-handoff-workflow",
      runQuery: vi.fn(async (ref: FunctionReference<"query">) => {
        if (
          getFunctionName(ref) === "prospects:getProspectWorkflowDataInternal"
        ) {
          const projected = await t.query(
            internal.prospects.getProspectWorkflowDataInternal,
            { prospectId }
          );
          expect(projected?.qualificationProfileData).not.toHaveProperty(
            "unusedRawPayload"
          );
          return projected;
        }
        if (getFunctionName(ref) === "workspaces:getById") return workspace;
        throw new Error(`Unexpected query: ${getFunctionName(ref)}`);
      }),
      runMutation: vi.fn(async () => ({ success: true, skipped: false })),
      runAction: vi.fn(
        async (
          ref: FunctionReference<"action">,
          args: Record<string, unknown>
        ) => {
          const name = getFunctionName(ref);
          actions.push({ name, args });
          if (name === "integrations/linkedin/getProfile:getProfile")
            return { success: true, profile: providerProfile };
          if (
            name ===
            "integrations/linkedin/getProfilePosts:getProfilePostsInternal"
          )
            return { posts: [], nextCursor: null };
          if (name === "integrations/linkedin/getCompany:getCompany")
            return { success: false };
          if (name === "workflows/enrichment:runLinkedInEnrichmentCore")
            return {
              prospectType: "individual",
              painPoints: [],
              pipelineStage: "new",
              enrichedAt: 1,
              enrichmentStatus: "enriched",
            };
          return null;
        }
      ),
    };
    expect(
      await enrichmentHandler(step, { prospectId, workspaceId: workspace._id })
    ).toEqual({ success: true, enrichmentStatus: "enriched" });
    const coreArgs = actions.find(
      (action) =>
        action.name === "workflows/enrichment:runLinkedInEnrichmentCore"
    )?.args;
    expect(coreArgs).toBeDefined();
    expect(coreArgs?.profile).toMatchObject({ firstName: "Current" });
    if (scenario === "matching") {
      expect(coreArgs?.profile).toHaveProperty(
        "employerEvidence",
        employerEvidence
      );
      expect(coreArgs?.profile).not.toHaveProperty("currentPositions");
      expect(coreArgs?.profile).not.toHaveProperty("summary");
    } else {
      expect(coreArgs?.profile).not.toHaveProperty("employerEvidence");
    }
    expect(coreArgs?.evidencePosts).toEqual([
      expect.objectContaining({
        text: originalPost.text,
        url: originalPost.url,
      }),
    ]);
  },
  15_000
);
