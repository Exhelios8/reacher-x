import { z } from "zod";
import type {
  QualificationSource,
  QualificationVerification,
} from "./qualificationEvidenceCore";
import { sameQualificationWebsiteHost } from "./qualificationEvidenceCore";
import {
  isExcludedCompanyDomain,
  type WorkspaceTargetingSpec,
} from "./targetingSpecCore";
import { isRecord } from "./typeGuards";
import { isPublicHttpUrl } from "../../shared/lib/utils/url/urlSafety";
import type { QualificationCriterionResult } from "./qualificationScoringCore";

export const peerRouteSchema = z.object({
  route: z.enum([
    "peer",
    "observed_problem",
    "testable_opportunity",
    "exploration",
    "none",
  ]),
  sourceUrl: z.string().trim().max(2048),
  sourceQuote: z.string().trim().max(1000),
  rationale: z.string().trim().max(600),
  offerOrRemedy: z.string().trim().max(500),
});
export type PeerRouteProposal = z.infer<typeof peerRouteSchema>;
type Route = NonNullable<QualificationVerification["routeAssessment"]>;

export function noPeerRoute(rationale: string): Route {
  return { route: "none", needStatus: "unknown", rationale };
}

/** Route evidence comes from the verified current employer context, never the raw import or search hint. */
export function verifyPeerRoute(args: {
  proposal?: PeerRouteProposal;
  spec: WorkspaceTargetingSpec;
  profile: Record<string, unknown>;
  employer?: Record<string, unknown>;
  sources: QualificationSource[];
  criteria: QualificationCriterionResult[];
  now: number;
}): Route {
  const { proposal, employer, profile, sources } = args;
  const absent = noPeerRoute(
    "The available evidence does not establish a comparable offer or a specific site opportunity."
  );
  if (
    !employer ||
    !isRecord(employer.company) ||
    typeof employer.companyId !== "string" ||
    !/^[1-9]\d*$/.test(employer.companyId) ||
    typeof profile.urn !== "string" ||
    !profile.urn ||
    employer.personUrn !== profile.urn ||
    typeof profile.url !== "string" ||
    !/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/?$/.test(profile.url) ||
    employer.relationshipSourceUrl !== profile.url ||
    typeof employer.company.website !== "string" ||
    !isPublicHttpUrl(employer.company.website) ||
    !sources.some(
      (s) =>
        s.evidenceKind === "profile" &&
        s.authorId === profile.urn &&
        s.sourceUrl === profile.url &&
        args.criteria.some(
          (c) =>
            c.criterionId === "role" &&
            c.verdict === "matched" &&
            c.sourceIds.includes(s.sourceId)
        )
    )
  ) {
    return {
      ...noPeerRoute(
        "Research only: current contact and employer website have not been independently verified."
      ),
      needsContactVerification: true,
    };
  }
  if (
    isExcludedCompanyDomain(
      employer.company.website,
      args.spec.searchHints.excludedCompanyDomains
    )
  )
    return noPeerRoute(
      "The verified employer domain is a reference or excluded account."
    );
  if (
    !proposal ||
    proposal.route === "none" ||
    !proposal.rationale ||
    !proposal.offerOrRemedy ||
    !proposal.sourceUrl ||
    !proposal.sourceQuote ||
    !isPublicHttpUrl(proposal.sourceUrl)
  )
    return absent;
  if (
    proposal.route === "peer" &&
    !args.criteria.some(
      (c) => c.criterionId === "peer_fit" && c.verdict === "matched"
    )
  )
    return absent;

  const officialHost = sameQualificationWebsiteHost(
    proposal.sourceUrl,
    employer.company.website
  );
  const reviews = Array.isArray(employer.reviewedPages)
    ? employer.reviewedPages
    : [employer.reviewedPage];
  const reviewedPage = reviews.filter(isRecord).find((page) => {
    const checked = Date.parse(
      typeof page.observedAt === "string" ? page.observedAt : ""
    );
    return (
      officialHost &&
      page.url === proposal.sourceUrl &&
      page.finalUrl === proposal.sourceUrl &&
      page.httpStatus === 200 &&
      page.provenance === "native_http" &&
      checked <= args.now &&
      args.now - checked <= 24 * 60 * 60 * 1000 &&
      typeof page.text === "string" &&
      page.text.includes(proposal.sourceQuote)
    );
  });
  const firstParty =
    officialHost &&
    sources.find(
      (s) =>
        s.evidenceKind === "employer_event" &&
        s.authorId === `company:${employer.companyId}` &&
        (s.evidenceUrl ?? s.sourceUrl) === proposal.sourceUrl &&
        s.text.includes(proposal.sourceQuote)
    );
  // The verified company profile can identify an offer; a site hypothesis must cite an actual site.
  const checkedEmployerAt =
    typeof employer.fetchedAt === "string"
      ? Date.parse(employer.fetchedAt)
      : NaN;
  const companyProfile =
    proposal.route === "peer" &&
    employer.sourceUrl === proposal.sourceUrl &&
    /^https:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+\/?$/.test(
      proposal.sourceUrl
    ) &&
    checkedEmployerAt <= args.now &&
    args.now - checkedEmployerAt <= 24 * 60 * 60 * 1000 &&
    typeof employer.company.description === "string" &&
    employer.company.description.includes(proposal.sourceQuote);
  const measured = sources.find(
    (s) =>
      s.evidenceKind === "observed_site_problem" &&
      s.companyId === employer.companyId &&
      s.authorId === "observer:reacherx" &&
      s.sourceUrl === proposal.sourceUrl &&
      officialHost &&
      s.text.includes(proposal.sourceQuote) &&
      proposal.sourceQuote.includes(`HTTP ${s.httpStatus}`)
  );
  if (
    proposal.route === "observed_problem"
      ? !measured
      : !reviewedPage && !firstParty && !companyProfile
  )
    return absent;
  return {
    ...proposal,
    needStatus:
      proposal.route === "observed_problem"
        ? "confirmed"
        : proposal.route === "testable_opportunity"
          ? "hypothesis"
          : "unknown",
    ...(measured?.observedAt || reviewedPage?.observedAt || companyProfile
      ? {
          observedAt: String(
            measured?.observedAt ||
              reviewedPage?.observedAt ||
              employer.fetchedAt
          ),
        }
      : {}),
  };
}
