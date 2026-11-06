import { expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import {
  isProspectActionableReady,
  buildProspectAnalyticsTransitionPatch,
} from "./prospectAnalyticsCore";

const base = {
  platform: "linkedin",
  qualificationStatus: "qualified",
  enrichmentStatus: "partial",
} as Doc<"prospects">;
const assessment = {
  route: "peer",
  sourceUrl: "https://example.com/offer",
  sourceQuote: "B2B offer",
  rationale: "Verified offer",
  needStatus: "unknown",
} as const;
const withRoute = (route: Record<string, unknown>) =>
  ({
    ...base,
    qualificationVerification: { routeAssessment: { ...assessment, ...route } },
  }) as Doc<"prospects">;

it.each(["peer", "observed_problem", "testable_opportunity"])(
  "accepts documented V3 %s without posts",
  (route) => {
    expect(isProspectActionableReady(withRoute({ route }))).toBe(true);
  }
);
it("accepts documented manual exploration with a concrete test", () => {
  expect(
    isProspectActionableReady(
      withRoute({
        route: "exploration",
        offerOrRemedy: "Test the choice guide",
      })
    )
  ).toBe(true);
  expect(isProspectActionableReady(withRoute({ route: "exploration" }))).toBe(
    false
  );
});
it.each([{ route: "none" }, { sourceUrl: "" }, { sourceQuote: " " }])(
  "fails closed for unsupported V3 route %j even with posts",
  (route) => {
    expect(
      isProspectActionableReady({
        ...withRoute(route),
        evidencePosts: [{}],
      } as Doc<"prospects">)
    ).toBe(false);
  }
);
it("keeps qualification, enrichment and legacy gates", () => {
  expect(
    isProspectActionableReady({
      ...withRoute({}),
      qualificationStatus: "pending",
    })
  ).toBe(false);
  expect(
    isProspectActionableReady({ ...withRoute({}), enrichmentStatus: "pending" })
  ).toBe(false);
  expect(isProspectActionableReady(base)).toBe(false);
  expect(
    isProspectActionableReady({
      ...base,
      evidencePosts: [{}],
    } as Doc<"prospects">)
  ).toBe(true);
});
it("updates readiness when route proof changes", () => {
  expect(
    buildProspectAnalyticsTransitionPatch({
      prospect: base,
      patch: {
        qualificationVerification: withRoute({}).qualificationVerification,
      },
      now: 123,
    }).readyAt
  ).toBe(123);
  expect(
    buildProspectAnalyticsTransitionPatch({
      prospect: { ...withRoute({}), readyAt: 123 },
      patch: {
        qualificationVerification: withRoute({ route: "none" })
          .qualificationVerification,
      },
      now: 456,
    })
  ).toEqual({ readyAt: undefined });
});

it("keeps X-only V3 and unverified contacts out of ready", () => {
  expect(
    isProspectActionableReady({ ...withRoute({}), platform: "twitter" })
  ).toBe(false);
  expect(
    isProspectActionableReady(withRoute({ needsContactVerification: true }))
  ).toBe(false);
  expect(isProspectActionableReady({ ...base, platform: "twitter" })).toBe(
    true
  );
});
