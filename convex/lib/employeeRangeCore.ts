import { escapeRegExp } from "../../shared/lib/utils/text/tweetText";
import { sameQualificationWebsiteHost } from "./qualificationEvidenceCore";
import type { QualificationCriterionResult } from "./qualificationScoringCore";
import { isRecord } from "./typeGuards";

type Range = { min: number; max: number };
type Citation = { sourceUrl: string; quote: string };

function declaredRange(value: unknown): Range | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "");
  const match =
    /^(\d+)(?:\s*[-–—]\s*(\d+)|(\+))?(?:\s+(?:employees?|salariés?))?$/iu.exec(
      normalized
    );
  if (!match) return;
  const min = Number(match[1]);
  const max = match[3] ? Infinity : Number(match[2] ?? min);
  if (
    Number.isSafeInteger(min) &&
    (Number.isSafeInteger(max) || max === Infinity) &&
    min <= max
  )
    return { min, max };
}

function compareRange(observed: Range | undefined, target: Range) {
  if (!observed) return "unknown";
  if (observed.min > target.max || observed.max < target.min)
    return "not_matched";
  if (observed.min >= target.min && observed.max <= target.max)
    return "matched";
  return "unknown";
}

export function classifyDeclaredEmployeeRange(value: unknown, target: Range) {
  return compareRange(declaredRange(value), target);
}

function fresh(value: unknown, now: number) {
  const age = now - Date.parse(typeof value === "string" ? value : "");
  return age >= 0 && age <= 24 * 60 * 60 * 1000;
}

function containsPayrollSentence(text: string, quote: string) {
  // A substring can omit a historical date or a department/site qualifier.
  const sentence = quote.replace(/[.!]$/, "");
  return (
    new RegExp(
      "(?:^|[.!?]\\s+)" + escapeRegExp(sentence) + "(?:[.!](?=\\s|$)|$)",
      "u"
    ).test(text) &&
    !/(?:testimonial|témoignage|case study|customer stor(?:y|ies)|cas client|parole de client)/iu.test(
      text
    )
  );
}

/** Accept explicit present-tense payroll statements. Other wording stays unverified. */
function officialStatementRange(
  quote: string,
  company: string
): Range | undefined {
  const name = escapeRegExp(company);
  const subject =
    "(?:nous (?:employons|comptons)|we (?:currently )?(?:employ|have)|(?:" +
    name +
    "|notre entreprise) (?:emploie|compte)|(?:" +
    name +
    "|our company) (?:employs|has))";
  const match = new RegExp(
    "^" +
      subject +
      "\\s+(?:(?:actuellement|currently)\\s+)?(?:(?:entre|between)\\s+)?(\\d+)(?:\\s*(?:[-–—]|à|et|and|to)\\s*(\\d+))?\\s+(?:salarié(?:e?s?)|employees?)(?:\\s+(?:au total|in total))?[.!]?$",
    "iu"
  ).exec(quote);
  if (!match) return;
  return declaredRange(match[2] ? match[1] + "-" + match[2] : match[1]);
}

export function verifyEmployeeRange(args: {
  criterionId: string;
  target: Range;
  profile: Record<string, unknown>;
  employer?: Record<string, unknown>;
  statement?: Citation;
  now: number;
}): QualificationCriterionResult {
  const { employer, profile, target, statement, now } = args;
  const base = { criterionId: args.criterionId, sourceIds: [] };
  const unknown = {
    ...base,
    verdict: "unknown" as const,
    confidence: 0,
    rationale:
      "An employer-declared range or current payroll statement is needed. Associated LinkedIn profiles do not establish headcount.",
  };
  if (
    !employer ||
    !isRecord(employer.company) ||
    !fresh(employer.fetchedAt, now) ||
    typeof profile.urn !== "string" ||
    !profile.urn ||
    employer.personUrn !== profile.urn ||
    typeof profile.url !== "string" ||
    !/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/?$/.test(profile.url) ||
    employer.relationshipSourceUrl !== profile.url ||
    typeof employer.companyId !== "string" ||
    !/^[1-9]\d*$/.test(employer.companyId) ||
    typeof employer.sourceUrl !== "string" ||
    !/^https:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+\/?$/i.test(
      employer.sourceUrl
    )
  )
    return unknown;
  const company = employer.company;
  const declared = declaredRange(company.staffCountRange);
  const verdict = compareRange(declared, target);
  const declaration =
    declared && typeof company.staffCountRange === "string"
      ? { sourceUrl: employer.sourceUrl, quote: company.staffCountRange }
      : undefined;
  if (declaration && verdict !== "unknown")
    return {
      ...base,
      verdict,
      confidence: 1,
      rationale: `The employer declares "${declaration.quote}" on its LinkedIn company profile. Target: ${target.min}–${target.max} employees.`,
      employeeEvidence: declaration,
    };
  const unresolved = declaration
    ? {
        ...unknown,
        rationale: `The declared range "${declaration.quote}" overlaps the target of ${target.min}–${target.max} employees. A current, corroborating employer statement is needed.`,
        employeeEvidence: declaration,
      }
    : unknown;
  if (
    !statement?.quote ||
    !statement.sourceUrl ||
    typeof company.name !== "string" ||
    !sameQualificationWebsiteHost(statement.sourceUrl, company.website)
  )
    return unresolved;
  const pages = Array.isArray(employer.reviewedPages)
    ? employer.reviewedPages
    : [employer.reviewedPage];
  const page = pages
    .filter(isRecord)
    .find(
      (item) =>
        item.url === statement.sourceUrl &&
        item.finalUrl === statement.sourceUrl &&
        item.provenance === "native_http" &&
        item.httpStatus === 200 &&
        fresh(item.observedAt, now) &&
        typeof item.text === "string" &&
        item.text.includes(statement.quote) &&
        containsPayrollSentence(item.text, statement.quote)
    );
  const claim = page && officialStatementRange(statement.quote, company.name);
  if (
    !claim ||
    (declared && (claim.max < declared.min || claim.min > declared.max))
  )
    return unresolved;
  const websiteVerdict = compareRange(claim, target);
  if (websiteVerdict === "unknown") return unresolved;
  return {
    ...base,
    verdict: websiteVerdict,
    confidence: 1,
    rationale:
      "The employer states its headcount on its official website: " +
      statement.quote,
    employeeEvidence: statement,
  };
}
