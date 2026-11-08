"use node";

import type { ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getStringProperty, isRecord } from "./typeGuards";
import {
  resolveLinkedInProspectProfileIdentifiers,
  normalizeLinkedInProfileQueryUrn,
} from "../integrations/linkedin/profileIdentity";
import { getLearningTargetingFingerprint } from "./learningTargetingHelpers";
import { isRequiredProblemCriterion } from "./targetingSpecCore";
import { getCurrentUTCTimestamp } from "../../shared/lib/utils/time/timeUtils";
import { readWebPages, searchWeb } from "./researchCore";
import {
  EMPLOYER_EVENT_MAX_AGE_MS,
  MAX_EMPLOYER_EVENTS,
  sameQualificationWebsiteHost as sameWebsiteHost,
} from "./qualificationEvidenceCore";
import { classifyProviderFailure } from "./providerReliability";

import { isAccountFirstDiscoveryEnabled } from "./accountFirstDiscoveryCore";
import { classifyDeclaredEmployeeRange } from "./employeeRangeCore";
import {
  observeOfficialSiteProblem,
  QualificationSiteProblemRetryableError,
  reviewOfficialSitePages,
} from "./qualificationSiteProblemCore";
import {
  sanitizeLinkedInProfileForWorkflow,
  sanitizeWorkflowString,
  sanitizeWorkflowValue,
} from "./workflowSafeProspect";

export function isRetryableProblemSourceFailure(message: unknown): boolean {
  if (typeof message !== "string" || !message) return false;
  const { reason } = classifyProviderFailure(message);
  return (
    reason === "transient" ||
    reason === "rate_limit" ||
    message.includes("provider circuit is open")
  );
}

function companyId(value: unknown): string | undefined {
  const id =
    typeof value === "number" || typeof value === "string"
      ? String(value).trim()
      : "";
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function getCurrentCompanyId(
  profile: Record<string, unknown>
): string | undefined {
  const current = Array.isArray(profile.currentPositions)
    ? profile.currentPositions.map((position) =>
        isRecord(position) && isRecord(position.company)
          ? companyId(position.company.id)
          : undefined
      )
    : (Array.isArray(profile.position) ? profile.position : [])
        .filter(isRecord)
        .filter((position) => {
          const endYear = isRecord(position.end)
            ? position.end.year
            : undefined;
          return endYear === 0 || (position.isCurrent === true && !endYear);
        })
        .map((position) => companyId(position.companyId));
  // Multiple current employers or an unidentified current employer are ambiguous.
  const ids = new Set(current);
  return ids.size === 1 && !ids.has(undefined) ? [...ids][0] : undefined;
}

/** Bounded person/employer evidence acquisition before any LinkedIn fit verdict. */
export async function collectQualificationDiscoveryEvidence(
  ctx: ActionCtx,
  prospect: Doc<"prospects">
): Promise<{
  profileData: Record<string, unknown>;
  evidencePosts: Record<string, unknown>[];
  employerEvidence?: Record<string, unknown>;
} | null> {
  if (
    prospect.platform !== "linkedin" ||
    !["search_people", "search_post"].includes(
      prospect.discoverySource ?? ""
    ) ||
    prospect.prospectType === "organization"
  )
    return null;
  const linkedIn = isRecord(prospect.socialProfiles?.linkedin)
    ? prospect.socialProfiles.linkedin
    : undefined;
  const data = isRecord(prospect.data) ? prospect.data : {};
  const author = isRecord(data.author) ? data.author : {};
  if (
    [
      linkedIn?.url,
      data.url,
      data.linkedinUrl,
      author.url,
      author.profileUrl,
    ].some(
      (url) =>
        typeof url === "string" &&
        /^https?:\/\/(?:www\.)?linkedin\.com\/company\//i.test(url)
    )
  )
    return null;
  const workspace = await ctx.runQuery(internal.workspaces.getById, {
    workspaceId: prospect.workspaceId,
  });
  if (!workspace)
    throw new Error("[QualificationEvidence] Workspace no longer exists");
  const targetingFingerprint = getLearningTargetingFingerprint(workspace);
  const eventCriteria =
    workspace.targetingSpec?.criteria.filter(
      (criterion) =>
        isRequiredProblemCriterion(criterion) ||
        (criterion.kind === "preferred" &&
          criterion.evidence !== "profile" &&
          criterion.category !== "profile_fit")
    ) ?? [];
  const employerEventsEnabled =
    isAccountFirstDiscoveryEnabled(prospect.workspaceId) &&
    eventCriteria.length > 0;
  const directSiteAuditEnabled =
    isAccountFirstDiscoveryEnabled(prospect.workspaceId) &&
    workspace.targetingSpec?.discoveryMode === "peer_or_site_audit";
  const employeeRange = workspace.targetingSpec?.criteria.find(
    (criterion) => criterion.employeeRange
  )?.employeeRange;
  const employerEvidenceEnabled =
    employerEventsEnabled || directSiteAuditEnabled || Boolean(employeeRange);
  const observeSiteProblems =
    directSiteAuditEnabled ||
    (employerEventsEnabled && eventCriteria.some(isRequiredProblemCriterion));
  const contextVersion = employeeRange
    ? 6
    : directSiteAuditEnabled
      ? 5
      : observeSiteProblems
        ? 4
        : employerEventsEnabled
          ? 3
          : 2;
  const cachedData = prospect.qualificationProfileData;
  const cachedEmployer =
    isRecord(cachedData) && isRecord(cachedData.employerEvidence)
      ? cachedData.employerEvidence
      : undefined;
  const identifiers = resolveLinkedInProspectProfileIdentifiers(prospect);
  const cacheIdentityMatches =
    !employerEvidenceEnabled ||
    (isRecord(cachedData) &&
      (identifiers.profileUrn
        ? normalizeLinkedInProfileQueryUrn(String(cachedData.urn)) ===
          identifiers.profileUrn
        : typeof cachedData.username === "string" &&
          cachedData.username.toLowerCase() ===
            identifiers.username?.toLowerCase()));
  const cacheAgeValid =
    !employerEvidenceEnabled ||
    (typeof prospect.qualificationEvidenceFetchedAt === "number" &&
      prospect.qualificationEvidenceFetchedAt <= getCurrentUTCTimestamp() &&
      getCurrentUTCTimestamp() - prospect.qualificationEvidenceFetchedAt <
        24 * 60 * 60 * 1000);
  const eventRetryDue =
    employerEventsEnabled &&
    typeof cachedEmployer?.eventRetryAfter === "number" &&
    cachedEmployer.eventRetryAfter <= getCurrentUTCTimestamp();
  const siteProblemRetryDue =
    observeSiteProblems &&
    typeof cachedEmployer?.siteProblemRetryAfter === "number" &&
    cachedEmployer.siteProblemRetryAfter <= getCurrentUTCTimestamp();
  if (
    isRecord(prospect.qualificationProfileData) &&
    prospect.qualificationEvidenceFetchedAt &&
    prospect.qualificationProfileData.qualificationContextVersion ===
      contextVersion &&
    (!employerEvidenceEnabled ||
      prospect.qualificationProfileData.qualificationTargetingFingerprint ===
        targetingFingerprint) &&
    !eventRetryDue &&
    !siteProblemRetryDue &&
    cacheIdentityMatches &&
    cacheAgeValid
  ) {
    return {
      profileData: prospect.qualificationProfileData,
      evidencePosts: (prospect.evidencePosts ?? []).filter(isRecord),
      ...(employerEvidenceEnabled && cachedEmployer
        ? { employerEvidence: cachedEmployer }
        : {}),
    };
  }
  if (!identifiers.username && !identifiers.profileUrn)
    throw new Error(
      "[QualificationEvidence] LinkedIn profile identity unavailable"
    );
  const result = await ctx.runAction(
    internal.integrations.linkedin.getProfile.getProfile,
    {
      username: identifiers.username,
      urn: identifiers.profileUrn,
      includeContactInfo: false,
    }
  );
  if (!result.success || !isRecord(result.profile))
    throw new Error(
      `[QualificationEvidence] ${result.error ?? "Profile fetch failed"}`
    );
  const profile = result.profile;
  const sameUsername =
    identifiers.username &&
    profile.username?.toLowerCase() === identifiers.username.toLowerCase();
  const sameUrn =
    identifiers.profileUrn &&
    [profile.urn, String(profile.id)].some(
      (id) => normalizeLinkedInProfileQueryUrn(id) === identifiers.profileUrn
    );
  // A stable known identity takes precedence over a mutable/reused username.
  if (identifiers.profileUrn ? !sameUrn : !sameUsername)
    throw new Error(
      "[QualificationEvidence] Provider returned a different profile"
    );
  const username =
    getStringProperty(profile, "username")?.trim() || identifiers.username;
  const urn = getStringProperty(profile, "urn")?.trim();
  if (!username || !/^[\p{L}\p{N}_-]+$/u.test(username) || !urn) {
    throw new Error(
      "[QualificationEvidence] Provider profile is missing a valid public username or URN"
    );
  }
  const profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(username)}`;
  const profileData: Record<string, unknown> = sanitizeWorkflowValue({
    ...sanitizeLinkedInProfileForWorkflow(profile),
    // Older caches have no separately attributed employer event sources.
    qualificationContextVersion: contextVersion,
    ...(employerEvidenceEnabled
      ? { qualificationTargetingFingerprint: targetingFingerprint }
      : {}),
    // Retain actual responsibilities; the generic workflow sanitizer keeps only company names.
    position: (profile.position ?? []).slice(0, 5).map((position) => ({
      title: position.title ?? "",
      companyName: position.companyName ?? "",
      companyId: companyId(position.companyId),
      companyURL: position.companyURL,
      companyIndustry: position.companyIndustry,
      location: position.location,
      start: position.start,
      end: position.end,
      description: sanitizeWorkflowString(position.description ?? "").slice(
        0,
        4000
      ),
    })),
    url: profileUrl,
  });
  const employerId = getCurrentCompanyId(profile);
  if (employerId) {
    const employer = await ctx.runAction(
      internal.integrations.linkedin.getCompany.getCompany,
      { id: employerId }
    );
    if (!employer.success || !isRecord(employer.company))
      throw new Error(
        `[QualificationEvidence] ${employer.error ?? "Company fetch failed"}`
      );
    const company = employer.company;
    const sourceUrl = getStringProperty(company, "linkedinUrl")?.trim();
    if (
      companyId(company.id) !== employerId ||
      !sourceUrl ||
      !/^https:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+\/?(?:[?#].*)?$/i.test(
        sourceUrl
      )
    )
      throw new Error(
        "[QualificationEvidence] Provider returned a different or unverifiable company"
      );
    const headquarters: Record<string, unknown> = isRecord(company.headquarter)
      ? company.headquarter
      : {};
    const cachedEmployer =
      isRecord(prospect.qualificationProfileData) &&
      isRecord(prospect.qualificationProfileData.employerEvidence)
        ? prospect.qualificationProfileData.employerEvidence
        : undefined;
    const cachedWebsite = cachedEmployer?.officialWebsiteEvidence;
    let officialWebsiteEvidence =
      !directSiteAuditEnabled &&
      companyId(cachedEmployer?.companyId) === employerId &&
      isRecord(cachedWebsite) &&
      typeof cachedWebsite.text === "string" &&
      cachedWebsite.text.trim() &&
      sameWebsiteHost(cachedWebsite.url, company.website) &&
      sameWebsiteHost(cachedWebsite.finalUrl, company.website)
        ? cachedWebsite
        : undefined;
    let websiteReadError: string | undefined;
    if (
      !directSiteAuditEnabled &&
      !officialWebsiteEvidence &&
      company.website?.trim()
    ) {
      const [page] = await readWebPages([company.website], {
        ctx,
        consumer: "qualification.employer_website",
        workspaceId: prospect.workspaceId,
        prospectId: prospect._id,
      });
      if (page?.error) {
        const { reason } = classifyProviderFailure(page.error);
        if (
          reason === "transient" ||
          reason === "rate_limit" ||
          page.error.includes("provider circuit is open")
        )
          throw new Error(
            `[QualificationEvidence] Official company website: ${page.error}`
          );
        websiteReadError = page.error.slice(0, 600);
      } else if (!page?.snippet.trim()) {
        websiteReadError = "No readable company website content was available.";
      }
      if (page?.snippet.trim()) {
        if (
          !sameWebsiteHost(page.url, company.website) ||
          !sameWebsiteHost(page.finalUrl, company.website)
        )
          throw new Error(
            "[QualificationEvidence] Provider returned a different company website"
          );
        officialWebsiteEvidence = {
          url: page.url,
          finalUrl: page.finalUrl,
          retrievedAt: new Date(getCurrentUTCTimestamp()).toISOString(),
          text: page.snippet,
        };
      }
    }
    // Native audit is independent of optional Exa/news availability and runs before those calls.
    let siteReview:
      | Awaited<ReturnType<typeof reviewOfficialSitePages>>
      | undefined;
    const needsSizeStatement =
      employeeRange &&
      classifyDeclaredEmployeeRange(company.staffCountRange, employeeRange) ===
        "unknown";
    if (
      (directSiteAuditEnabled || needsSizeStatement) &&
      typeof company.website === "string"
    ) {
      try {
        siteReview = await reviewOfficialSitePages({
          companyId: employerId,
          officialWebsite: company.website,
        });
      } catch {
        // This optional observation must never erase the independently verified employer.
        siteReview = { reviewedPages: [], siteProblems: [], retryable: true };
      }
    }
    if (siteReview?.reviewedPages[0]) {
      const page = siteReview.reviewedPages[0];
      officialWebsiteEvidence = { ...page, retrievedAt: page.observedAt };
    }
    const events: Record<string, unknown>[] = [];
    let eventSearchError: string | undefined;
    if (
      !directSiteAuditEnabled &&
      employerEventsEnabled &&
      eventCriteria.length &&
      sameWebsiteHost(company.website, company.website)
    ) {
      const now = getCurrentUTCTimestamp();
      const host = new URL(company.website!).hostname;
      const query = `${company.name} ${workspace.targetingSpec?.summary.slice(0, 300)} ${eventCriteria
        .map((criterion) =>
          [criterion.description, ...criterion.terms].join(" ")
        )
        .join(" ")
        .slice(0, 700)}`;
      const providerContext = {
        ctx,
        consumer: "qualification.employer_events",
        workspaceId: prospect.workspaceId,
        prospectId: prospect._id,
      };
      try {
        const findings = await searchWeb(query, providerContext, {
          maxResults: MAX_EMPLOYER_EVENTS,
          includeDomains: [host],
          startPublishedDate: new Date(
            now - EMPLOYER_EVENT_MAX_AGE_MS
          ).toISOString(),
        });
        const urls = findings
          .filter((finding) => {
            const publishedAt = Date.parse(finding.publishedDate ?? "");
            return (
              sameWebsiteHost(finding.url, company.website) &&
              Number.isFinite(publishedAt) &&
              publishedAt <= now &&
              now - publishedAt <= EMPLOYER_EVENT_MAX_AGE_MS
            );
          })
          .map((finding) => finding.url)
          .slice(0, MAX_EMPLOYER_EVENTS);
        const pages = urls.length
          ? await readWebPages(urls, providerContext, {
              requirePublisherMetadata: true,
            })
          : [];
        for (const page of pages) {
          if (isRetryableProblemSourceFailure(page.error))
            eventSearchError = page.error?.slice(0, 600);
          const publishedAt = Date.parse(page.publishedDate ?? "");
          if (
            page.error ||
            !page.snippet.trim() ||
            !urls.includes(page.url) ||
            !sameWebsiteHost(page.url, company.website) ||
            !sameWebsiteHost(page.finalUrl, company.website) ||
            !Number.isFinite(publishedAt) ||
            publishedAt > now ||
            now - publishedAt > EMPLOYER_EVENT_MAX_AGE_MS
          )
            continue;
          events.push({
            evidenceKind: "employer_event",
            companyId: employerId,
            url: page.url,
            finalUrl: page.finalUrl,
            title: page.title,
            publishedAt: page.publishedDate,
            retrievedAt: new Date(now).toISOString(),
            text: page.snippet,
          });
        }
      } catch (error) {
        eventSearchError = String(error).slice(0, 600);
      }
    }
    let observation;
    let siteProblemFetchRetryable = siteReview?.retryable ?? false;
    if (
      !directSiteAuditEnabled &&
      observeSiteProblems &&
      typeof company.website === "string"
    ) {
      try {
        observation = await observeOfficialSiteProblem({
          companyId: employerId,
          officialWebsite: company.website,
          sourceUrl:
            getStringProperty(events[0] ?? {}, "finalUrl") ??
            getStringProperty(officialWebsiteEvidence ?? {}, "finalUrl") ??
            company.website,
        });
      } catch (error) {
        siteProblemFetchRetryable =
          error instanceof QualificationSiteProblemRetryableError;
      }
    }
    // Company context and observations are never added to prospect-authored social posts.
    profileData.employerEvidence = sanitizeWorkflowValue({
      companyId: employerId,
      personUrn: urn,
      sourceUrl,
      fetchedAt: new Date(getCurrentUTCTimestamp()).toISOString(),
      relationshipSourceUrl: profileUrl,
      officialWebsiteEvidence,
      ...(siteReview
        ? {
            reviewedPages: siteReview.reviewedPages,
            reviewedPage:
              siteReview.reviewedPages[1] ?? siteReview.reviewedPages[0],
          }
        : {}),
      websiteReadError,
      events,
      ...(observeSiteProblems
        ? {
            siteProblems:
              siteReview?.siteProblems ?? (observation ? [observation] : []),
            ...(siteProblemFetchRetryable
              ? {
                  siteProblemFetchRetryable: true,
                  siteProblemRetryAfter:
                    getCurrentUTCTimestamp() + 30 * 60 * 1000,
                }
              : {}),
          }
        : {}),
      eventSearchError,
      ...(eventSearchError
        ? { eventRetryAfter: getCurrentUTCTimestamp() + 30 * 60 * 1000 }
        : {}),
      company: {
        name: company.name,
        description: sanitizeWorkflowString(company.description ?? "").slice(
          0,
          8000
        ),
        website: company.website,
        staffCountRange: company.staffCountRange,
        linkedInAssociatedProfiles: company.staffCount,
        headquarter: {
          city: headquarters.city,
          country: headquarters.country,
          countryCode: headquarters.countryCode,
        },
        industries: company.industriesV2,
      },
    });
  }
  const activity =
    prospect.discoverySource === "search_people"
      ? await ctx.runAction(
          internal.integrations.linkedin.getProfilePosts
            .getProfilePostsInternal,
          {
            urn,
            maxPosts: 10,
          }
        )
      : { posts: [] };
  // Empty/private activity is a successful bounded lookup; network failures throw and retry.
  const evidencePosts = [
    ...(prospect.evidencePosts ?? []).filter(isRecord),
    ...activity.posts.map((post) => ({
      ...post,
      id: post.urn,
      url: post.url ?? `https://www.linkedin.com/feed/update/${post.urn}`,
    })),
  ];
  if (prospect.qualificationStatus === "pending")
    await ctx.runMutation(
      internal.prospects.saveQualificationDiscoveryEvidenceInternal,
      {
        prospectId: prospect._id,
        workspaceId: prospect.workspaceId,
        expectedTargetingFingerprint:
          getLearningTargetingFingerprint(workspace),
        profileData,
        evidencePosts,
      }
    );
  return {
    profileData,
    evidencePosts,
    ...(employerEvidenceEnabled && isRecord(profileData.employerEvidence)
      ? { employerEvidence: profileData.employerEvidence }
      : {}),
  };
}

/** Real provider profile text, not search snippets or synthetic persona data. */
export function getQualificationProfileText(
  profile: Record<string, unknown>
): string {
  const positions = Array.isArray(profile.position)
    ? profile.position.filter(isRecord).slice(0, 5)
    : [];
  return [
    getStringProperty(profile, "headline"),
    getStringProperty(profile, "summary"),
    ...positions.flatMap((position) => [
      getStringProperty(position, "title"),
      getStringProperty(position, "companyName"),
      getStringProperty(position, "description"),
    ]),
  ]
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n");
}
