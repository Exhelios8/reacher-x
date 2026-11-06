import {
  isExcludedCompanyDomain,
  type WorkspaceTargetingSpec,
} from "./targetingSpecCore";
import type { ResearchFinding } from "./researchCore";
import { createStableHash } from "./memoryHelpers";

export const ACCOUNT_RESEARCH_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const ACCOUNT_HINT_PREFIX = "account_research_hint:";
const ACCOUNT_RETRIEVAL_HINT_PREFIX = "account_retrieval_hint:";
const ACCOUNT_RETRIEVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type AccountResearchFinding = ResearchFinding & {
  retrievedAt?: string;
  researchRoute?: "peer_offer" | "site_audit";
};
const EXCLUDED_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "crunchbase.com",
  "pappers.fr",
  "societe.com",
  "wikipedia.org",
];

export function isAccountFirstDiscoveryEnabled(workspaceId?: string): boolean {
  return Boolean(
    workspaceId &&
    process.env.ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS?.split(",")
      .map((id) => id.trim())
      .includes(workspaceId)
  );
}

export function buildAccountResearchQueries(args: {
  targetingSpec?: WorkspaceTargetingSpec;
  keywords: string[];
  now: number;
}): string[] {
  const spec = args.targetingSpec;
  const evergreen = spec?.discoveryMode === "peer_or_site_audit";
  const suppliedActivities = spec?.searchHints.activityPhrases ?? [];
  const intentTerms =
    spec?.criteria
      .filter(
        (criterion) =>
          criterion.category === "intent" && criterion.kind !== "exclusion"
      )
      .flatMap((criterion) => criterion.terms) ?? [];
  const phrases = [
    ...new Set(
      (evergreen
        ? suppliedActivities
        : suppliedActivities.length
          ? suppliedActivities
          : intentTerms.length
            ? intentTerms
            : args.keywords
      )
        .map((phrase) => phrase.replace(/\s+/g, " ").trim().slice(0, 160))
        .filter(Boolean)
    ),
  ];
  const offers = evergreen
    ? (spec.searchHints.peerOfferPhrases ?? [])
        .map((phrase) => phrase.replace(/\s+/g, " ").trim().slice(0, 160))
        .filter(Boolean)
    : [];
  if (!phrases.length && !offers.length) return [];
  const location =
    spec?.searchHints.locations[0] ??
    spec?.searchFilters?.linkedinPeople.location ??
    "";
  const sourceTerms =
    spec?.searchHints.languageCodes?.[0] === "fr"
      ? "actualités entreprise site officiel"
      : "company official news";
  const rotation =
    parseInt(createStableHash(args.keywords.join("\n")), 16) +
    Math.floor(args.now / (5 * 60 * 1000));
  if (evergreen) {
    const officialSite =
      spec.searchHints.languageCodes?.[0] === "fr"
        ? "site officiel"
        : "official website";
    return [
      offers[rotation % offers.length],
      phrases[rotation % phrases.length],
    ]
      .filter((phrase): phrase is string => Boolean(phrase))
      .map((phrase) =>
        [phrase, location, officialSite].filter(Boolean).join(" ")
      )
      .filter((query, index, queries) => queries.indexOf(query) === index);
  }
  // Rotate supplied work/page topics across cycles without adding a model call or durable state.
  const offset = rotation % phrases.length;
  return Array.from({ length: Math.min(2, phrases.length) }, (_, index) =>
    [
      phrases[
        (offset + index * Math.ceil(phrases.length / 2)) % phrases.length
      ],
      location,
      sourceTerms,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function selectRecentAccountFindings(
  findings: AccountResearchFinding[],
  now: number,
  targetingSpec?: WorkspaceTargetingSpec
): AccountResearchFinding[] {
  const evergreen = targetingSpec?.discoveryMode === "peer_or_site_audit";
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      try {
        const url = new URL(finding.url);
        const date = Date.parse(finding.publishedDate ?? "");
        if (
          !/^https?:$/.test(url.protocol) ||
          !finding.title.trim() ||
          !finding.snippet.trim() ||
          (!evergreen &&
            (!Number.isFinite(date) ||
              date < now - ACCOUNT_RESEARCH_LOOKBACK_MS ||
              date > now)) ||
          (evergreen &&
            isExcludedCompanyDomain(
              finding.url,
              targetingSpec.searchHints.excludedCompanyDomains
            )) ||
          EXCLUDED_DOMAINS.some(
            (domain) =>
              url.hostname === domain || url.hostname.endsWith(`.${domain}`)
          ) ||
          /case[-_ ]?stud|cas[-_ ]client|temoignage|testimonial|portfolio/i.test(
            url.pathname
          ) ||
          seen.has(url.href)
        )
          return false;
        seen.add(url.href);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((finding) => ({
      ...finding,
      ...(evergreen ? { retrievedAt: new Date(now).toISOString() } : {}),
      snippet: finding.snippet.slice(0, 1_200),
    }));
}

function accountResearchHint(
  finding: AccountResearchFinding
): string | undefined {
  const date = Date.parse(finding.retrievedAt ?? finding.publishedDate ?? "");
  return Number.isFinite(date)
    ? `${finding.retrievedAt ? ACCOUNT_RETRIEVAL_HINT_PREFIX : ACCOUNT_HINT_PREFIX}${date}|${finding.url}`
    : undefined;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Research provenance only: the qualifier still verifies employer, geography and event. */
export function groundAccountQuery<
  T extends { query: string; accountName?: string; accountSourceUrl?: string },
>(
  item: T,
  findings: AccountResearchFinding[],
  targetingSpec?: WorkspaceTargetingSpec
): (T & { sourceKeyword: string }) | null {
  const finding = findings.find(
    (finding) => finding.url === item.accountSourceUrl
  );
  const name = item.accountName?.trim();
  const sourceKeyword = finding ? accountResearchHint(finding) : undefined;
  const allowedRoles =
    targetingSpec?.discoveryMode === "peer_or_site_audit"
      ? targetingSpec.searchHints.roleTitles.map(normalizeName).filter(Boolean)
      : [];
  if (
    !finding ||
    (finding.retrievedAt &&
      targetingSpec?.discoveryMode !== "peer_or_site_audit") ||
    (targetingSpec?.discoveryMode === "peer_or_site_audit" &&
      isExcludedCompanyDomain(
        finding.url,
        targetingSpec.searchHints.excludedCompanyDomains
      )) ||
    !sourceKeyword ||
    (allowedRoles.length > 0 &&
      !allowedRoles.some((role) => normalizeName(item.query).includes(role))) ||
    !name ||
    normalizeName(item.query) === normalizeName(name) ||
    !normalizeName(item.query).includes(normalizeName(name)) ||
    !normalizeName(`${finding.title} ${finding.snippet}`).includes(
      normalizeName(name)
    )
  )
    return null;
  const host = normalizeName(
    new URL(finding.url).hostname
      .replace(/^www\./, "")
      .split(".")
      .slice(0, -1)
      .join(" ")
  );
  const nameTokens = name
    .split(/\s+/)
    .map(normalizeName)
    .filter(
      (token) =>
        token.length >= 3 &&
        !["groupe", "group", "company", "france", "sas", "sarl"].includes(token)
    );
  if (!nameTokens.some((token) => host.includes(token))) return null;
  return {
    ...item,
    sourceKeyword,
  };
}

export function isFreshAccountResearchHint(
  source: string | undefined,
  now: number,
  excludedCompanyDomains?: readonly string[]
): boolean {
  const prefix = source?.startsWith(ACCOUNT_RETRIEVAL_HINT_PREFIX)
    ? ACCOUNT_RETRIEVAL_HINT_PREFIX
    : ACCOUNT_HINT_PREFIX;
  if (!source?.startsWith(prefix)) return false;
  const [date, url] = source.slice(prefix.length).split("|");
  const timestamp = Number(date);
  const maxAge =
    prefix === ACCOUNT_RETRIEVAL_HINT_PREFIX
      ? ACCOUNT_RETRIEVAL_MAX_AGE_MS
      : ACCOUNT_RESEARCH_LOOKBACK_MS;
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now - maxAge &&
    timestamp <= now &&
    Boolean(url && /^https?:\/\//.test(url)) &&
    !isExcludedCompanyDomain(url ?? "", excludedCompanyDomains)
  );
}

export function isAccountResearchHintFromFindings(
  source: string | undefined,
  findings: AccountResearchFinding[],
  now: number
): boolean {
  return (
    isFreshAccountResearchHint(source, now) &&
    findings.some((finding) => source === accountResearchHint(finding))
  );
}
