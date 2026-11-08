"use node";

// convex/integrations/linkedin/getCompany.ts
// Fetch LinkedIn company details via LinkdAPI

import { internalAction } from "../../lib/functionBuilders";
import { v } from "convex/values";
import { logger } from "../../../shared/lib/logger";
import { requestLinkdApiData } from "./linkdapiClient";
import {
  isVerifiedAccountCompany,
  matchesAccountCompanyName,
} from "../../lib/accountFirstDiscoveryCore";
import { isRecord } from "../../lib/typeGuards";
const linkedInCompanyLogger = logger.withScope("LinkedInGetCompany");

// ============================================================================
// Types
// ============================================================================

/** LinkedIn company headquarters */
export interface LinkedInHeadquarter {
  countryCode: string;
  geographicArea: string;
  country: string;
  city: string;
  postalCode?: string;
  headquarter: boolean;
  line1?: string;
}

/** LinkedIn funding round */
export interface LinkedInFundingRound {
  fundingType: string;
  moneyRaised: {
    amount: string;
    currencyCode: string;
  };
  announcedOn: {
    year: number;
    month: number;
    day: number;
  };
  fundingRoundCrunchbaseUrl: string;
}

/** LinkedIn funding data */
export interface LinkedInFundingData {
  updatedAt: string;
  numFundingRounds: number;
  lastFundingRound: LinkedInFundingRound | null;
  crunchbaseUrl: string;
}

/** LinkedIn company images */
export interface LinkedInCompanyImages {
  logo: string;
  cover: string;
}

/** LinkedIn company from LinkdAPI */
export interface LinkedInCompany {
  id: string;
  name: string;
  universalName: string;
  linkedinUrl: string;
  description: string;
  type: string;
  images: LinkedInCompanyImages;
  staffCount: number;
  headquarter: LinkedInHeadquarter;
  locations: LinkedInHeadquarter[];
  industriesV2: string[];
  specialities: string[];
  website: string;
  founded: { year: number; month: number; day: number };
  followerCount: number;
  staffCountRange: string;
  crunchbaseUrl?: string;
  fundingData?: LinkedInFundingData;
}

/** Company result */
export interface CompanyResult {
  success: boolean;
  company?: LinkedInCompany;
  error?: string;
  retryable?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Internal Actions
// ============================================================================

/**
 * Fetch LinkedIn company details by ID or name.
 */
export const getCompany = internalAction({
  args: {
    id: v.optional(v.string()),
    name: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CompanyResult> => {
    if (!args.id && !args.name) {
      return {
        success: false,
        error: "Either id or name must be provided",
      };
    }

    try {
      let companyId = args.id;
      if (args.sourceUrl) {
        if (!args.name?.trim())
          return {
            success: false,
            error: "Company name is required to verify the official source",
          };
        // Human names are autocomplete queries, never guessed LinkedIn slugs.
        const lookup = await requestLinkdApiData<unknown>(ctx, {
          path: "/api/v1/companies/name-lookup",
          query: { query: args.name },
          consumer: `linkedin.resolveCompany:${args.name}`,
        });
        const candidates =
          isRecord(lookup) && Array.isArray(lookup.companies)
            ? lookup.companies.flatMap((item) => {
                if (
                  !isRecord(item) ||
                  typeof item.displayName !== "string" ||
                  (typeof item.id !== "string" && typeof item.id !== "number")
                )
                  return [];
                const id = String(item.id);
                return /^\d+$/.test(id) &&
                  matchesAccountCompanyName(
                    args.name!,
                    item.displayName,
                    args.sourceUrl!
                  )
                  ? [{ id }]
                  : [];
              })
            : [];
        if (candidates.length !== 1)
          return {
            success: false,
            error: "Company identity is missing or ambiguous",
          };
        companyId = candidates[0].id;
      }
      const company = await requestLinkdApiData<LinkedInCompany>(ctx, {
        path: "/api/v1/companies/company/info",
        query: {
          id: companyId,
          name: args.sourceUrl ? undefined : args.name,
        },
        consumer: `linkedin.getCompany:${args.id ?? args.name ?? "unknown"}`,
      });

      if (args.sourceUrl) company.id = String(company.id);
      if (
        args.sourceUrl &&
        (company.id !== companyId ||
          !isVerifiedAccountCompany(
            { name: args.name!, sourceUrl: args.sourceUrl },
            company
          ))
      )
        return {
          success: false,
          error: "Company identity does not match the official source",
        };

      return {
        success: true,
        company,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      linkedInCompanyLogger.error(
        "Company fetch failed",
        { companyId: args.id, companyName: args.name },
        error instanceof Error ? error : new Error(String(errorMessage))
      );
      return {
        success: false,
        error: errorMessage,
        ...(args.sourceUrl ? { retryable: true } : {}),
      };
    }
  },
});
