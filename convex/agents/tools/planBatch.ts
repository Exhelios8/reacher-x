"use node";

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  createPlanBatchProgressArtifact,
  createPlanPreviewArtifact,
  type AgentArtifactEnvelope,
} from "../../../shared/lib/json-render/agentArtifacts";
import {
  getDefaultPlanBatchInstruction,
  getLatestPlanBatchUserPrompt,
} from "../../lib/planBatchCore";
import {
  createDeferredAgentExecution,
  type DeferredAgentExecution,
} from "../../lib/deferredAgentTurn";
import { getUserSafeErrorMessage } from "../../lib/errorHelpers";
import { getPlanBatchStartedMessage } from "../../../shared/lib/outreach/planBatchCopy";
import {
  getToolPromptMessageId,
  resolveWorkspaceMemoryContext,
  type ToolContext,
} from "./workspaceMemoryHelpers";

interface WorkspacePlanOverviewItem {
  planId: Id<"outreachPlans">;
  prospectId: Id<"prospects">;
  prospectName: string;
  prospectPlatform: string;
  prospectStatus: string;
  planStatus: string;
  version: number;
  rationale: string;
  taskCount: number;
  completedTasks: number;
  updatedAt: number;
}

async function resolveWorkspaceIdForUser(
  ctx: ToolContext,
  moduleName: string
): Promise<Id<"workspaces"> | null> {
  const memoryContext = await resolveWorkspaceMemoryContext(
    ctx,
    moduleName,
    null
  );
  return memoryContext.workspaceId
    ? (memoryContext.workspaceId as Id<"workspaces">)
    : null;
}

export const listProspectPlans = createTool({
  description:
    "List active outreach plans across the current workspace with prospect names, statuses, and progress. Use this for a concise portfolio overview. Do not call it before starting a plan batch unless the user also asked to inspect existing plans.",
  inputSchema: z.object({}),
  execute: async (
    ctx
  ): Promise<{
    success: boolean;
    plans: Array<{
      prospectName: string;
      platform: string;
      planStatus: string;
      version: number;
      progress: string;
      rationale: string;
    }>;
    error?: string;
  }> => {
    try {
      const workspaceId = await resolveWorkspaceIdForUser(
        ctx,
        "listProspectPlans"
      );
      if (!workspaceId) {
        return {
          success: false,
          plans: [],
          error: "Could not resolve the current workspace.",
        };
      }

      const plans: WorkspacePlanOverviewItem[] = await ctx.runQuery(
        internal.outreach.listWorkspacePlansInternal,
        { workspaceId }
      );
      return {
        success: true,
        plans: plans.map((plan) => ({
          prospectName: plan.prospectName,
          platform: plan.prospectPlatform,
          planStatus: plan.planStatus,
          version: plan.version,
          progress: `${plan.completedTasks}/${plan.taskCount} tasks done`,
          rationale: plan.rationale,
        })),
      };
    } catch (error) {
      return {
        success: false,
        plans: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

// Plain unions emit anyOf, supported by native OpenAI; literal tags still validate each branch.
const scopeSchema = z.union([
  z.object({ kind: z.literal("tagged") }),
  z.object({
    kind: z.literal("plan_group"),
    reference: z
      .string()
      .regex(/^plans_[a-f0-9]{16}$/)
      .describe(
        "An exact application-owned plan-group reference supplied in the current conversation context. Never invent one."
      ),
  }),
  z.object({
    kind: z.literal("named"),
    prospects: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        "Exact visible prospect names or handles stated by the user. Do not use partial names."
      ),
  }),
  z.object({ kind: z.literal("all") }),
  z.object({
    kind: z.literal("fit_score"),
    min: z.number().min(0).max(100),
    max: z.number().min(0).max(100),
  }),
]);

const managePlanBatchInputSchema = z.union([
  z.object({
    action: z.literal("start"),
    operation: z.enum(["create", "update", "create_or_update"]),
    scope: scopeSchema,
    instruction: z
      .string()
      .min(1)
      .nullish()
      .describe(
        "Optional user-provided constraint common to every target. Omit this when the user delegates strategy or simply asks to create/update plans; the backend supplies a research-grounded default. Never include prospect names or another prospect's specific instruction here."
      ),
    perProspectInstructions: z
      .array(
        z.object({
          prospectName: z
            .string()
            .describe(
              "The exact visible name or handle of an explicitly tagged prospect."
            ),
          instruction: z.string().min(1),
        })
      )
      .max(50)
      .nullish()
      .describe(
        "Optional isolated instructions for individual prospects when scope is tagged or named. Each entry must contain details for only that named prospect and must never include IDs. For a referenced plan group, use one shared instruction instead."
      ),
  }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("show_results"),
    limit: z.number().int().min(1).max(10).optional(),
    reference: z
      .string()
      .regex(/^plans_[a-f0-9]{16}$/)
      .optional(),
  }),
]);

type ManagePlanBatchResult = {
  success: boolean;
  message: string;
  runId?: string;
  artifact?: AgentArtifactEnvelope;
  artifacts?: AgentArtifactEnvelope[];
  execution?: DeferredAgentExecution;
  error?: string;
};

export const managePlanBatch = createTool({
  description:
    "Start, confirm, stop, or show results for outreach plans. Use operation=create when the user says create, operation=update when the user says update, and create_or_update only when the user clearly asks for both. Use scope=tagged for current UI tags, plan_group for an exact safe reference supplied in this thread, and named for exact prospect names or handles stated by the user. Never invent references. All prospects and filtered groups require confirmation before work begins. Omit optional fields when they do not apply, but null is accepted safely. Prospect IDs and attachment URLs are resolved server-side and must never be invented or passed by the model.",
  inputSchema: managePlanBatchInputSchema,
  strict: true,
  execute: async (ctx, args, options): Promise<ManagePlanBatchResult> => {
    try {
      const workspaceId = await resolveWorkspaceIdForUser(
        ctx,
        "managePlanBatch"
      );
      const userId = ctx.userId as Id<"users"> | undefined;
      const sourceThreadId = ctx.threadId;
      const responsePromptMessageId = getToolPromptMessageId(ctx);
      const sourcePrompt = getLatestPlanBatchUserPrompt(options.messages);
      if (!workspaceId || !userId || !sourceThreadId) {
        return {
          success: false,
          message: "Could not resolve this workspace agent conversation.",
          error: "Missing workspace, user, or thread context",
        };
      }

      if (args.action === "confirm") {
        const runId = await ctx.runMutation(
          internal.planBatches.confirmLatestPlanBatchInternal,
          {
            workspaceId,
            userId,
            sourceThreadId,
            responsePromptMessageId,
          }
        );
        if (!runId) {
          return {
            success: false,
            message: "There are no outreach plans waiting for confirmation.",
            error: "No outreach plans are waiting for confirmation",
          };
        }
        return {
          success: true,
          runId,
          message: "Started working on the outreach plans.",
          artifact: createPlanBatchProgressArtifact({ runId }),
          execution: responsePromptMessageId
            ? createDeferredAgentExecution(String(runId))
            : undefined,
        };
      }

      if (args.action === "cancel") {
        const runId = await ctx.runMutation(
          internal.planBatches.cancelLatestPlanBatchInternal,
          {
            workspaceId,
            userId,
            sourceThreadId,
            responsePromptMessageId,
          }
        );
        if (!runId) {
          return {
            success: false,
            message: "No outreach plans are being prepared right now.",
            error: "No outreach plans are active",
          };
        }
        return {
          success: true,
          runId,
          message:
            "Stopped. Finished plans are saved. The rest will not continue.",
          artifact: createPlanBatchProgressArtifact({ runId }),
          execution: responsePromptMessageId
            ? createDeferredAgentExecution(String(runId))
            : undefined,
        };
      }

      if (args.action === "show_results") {
        const run = args.reference
          ? ((await ctx.runQuery(
              internal.planBatches.getPlanBatchRunByReferenceInternal,
              {
                workspaceId,
                userId,
                sourceThreadId,
                reference: args.reference,
              }
            )) as Doc<"planBatchRuns"> | null)
          : ((await ctx.runQuery(
              internal.planBatches.getLatestPlanBatchRunInternal,
              { workspaceId, userId, sourceThreadId }
            )) as Doc<"planBatchRuns"> | null);
        if (!run) {
          return {
            success: false,
            message: "There are no recent outreach plans to show.",
            error: "No recent outreach plans found",
          };
        }
        const items = (await ctx.runQuery(
          internal.planBatches.listPlanBatchSucceededItemsInternal,
          {
            runId: run._id,
            limit: args.limit ?? 5,
          }
        )) as Doc<"planBatchItems">[];
        const planData = await Promise.all(
          items.flatMap((item) =>
            item.planId
              ? [
                  ctx.runQuery(internal.outreach.getPlanInternal, {
                    planId: item.planId,
                  }),
                ]
              : []
          )
        );
        const artifacts = planData
          .flatMap((data) =>
            data
              ? [
                  createPlanPreviewArtifact({
                    planId: data.plan._id,
                    prospectId: data.plan.prospectId,
                    status: data.plan.status,
                    rationale: data.plan.strategy.rationale,
                    tasks: data.tasks.map((task) => ({
                      _id: task._id,
                      order: task.order,
                      type: task.type,
                      description: task.description,
                      status: task.status,
                      content: task.content,
                      targetTweetId: task.targetTweetId,
                    })),
                  }),
                ]
              : []
          )
          .filter(
            (artifact): artifact is AgentArtifactEnvelope =>
              artifact !== undefined
          );
        return {
          success: true,
          runId: run._id,
          message:
            artifacts.length > 0
              ? `Showing ${artifacts.length} plan${artifacts.length === 1 ? "" : "s"}.`
              : "There are no completed plans to show yet.",
          artifacts,
        };
      }

      const paidEligibility = await ctx.runQuery(
        internal.plans.getPaidFeatureEligibilityByUserId,
        { userId }
      );
      if (!paidEligibility.allowed) {
        return {
          success: false,
          message:
            paidEligibility.reason ??
            "Upgrade your plan to create or update outreach plans.",
          error: "Plan required",
        };
      }

      const sourceMessageId = responsePromptMessageId;
      const operation = args.operation;
      const defersAgentResponse =
        Boolean(responsePromptMessageId) &&
        ["tagged", "plan_group", "named"].includes(args.scope.kind);
      const namedTargets =
        args.scope.kind === "named"
          ? await ctx.runQuery(
              internal.planBatches.resolveNamedPlanBatchTargetsInternal,
              {
                workspaceId,
                userId,
                prospectNames: args.scope.prospects,
              }
            )
          : [];
      const run = await ctx.runMutation(
        internal.planBatches.createPlanBatchRunInternal,
        {
          workspaceId,
          userId,
          sourceThreadId,
          sourceMessageId,
          sourcePrompt,
          responsePromptMessageId: defersAgentResponse
            ? responsePromptMessageId
            : undefined,
          operation,
          scopeKind: args.scope.kind,
          sourcePlanBatchReference:
            args.scope.kind === "plan_group" ? args.scope.reference : undefined,
          namedTargets,
          instruction:
            args.instruction?.trim() ||
            getDefaultPlanBatchInstruction(operation),
          fitScoreMin:
            args.scope.kind === "fit_score" ? args.scope.min : undefined,
          fitScoreMax:
            args.scope.kind === "fit_score" ? args.scope.max : undefined,
          perProspectInstructions: args.perProspectInstructions ?? [],
        }
      );

      return {
        success: true,
        runId: run.runId,
        message: ["tagged", "plan_group", "named"].includes(args.scope.kind)
          ? getPlanBatchStartedMessage(operation)
          : "I am checking which prospects can be included. I will show you how many are ready before anything starts.",
        artifact: createPlanBatchProgressArtifact({ runId: run.runId }),
        execution: defersAgentResponse
          ? createDeferredAgentExecution(String(run.runId))
          : undefined,
      };
    } catch (error) {
      const message = getUserSafeErrorMessage(
        error,
        "Could not start the outreach plans"
      );
      return {
        success: false,
        message,
        error: message,
      };
    }
  },
});
