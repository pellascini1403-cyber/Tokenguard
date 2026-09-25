import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { unauthorizedError } from "../../lib/errors.js";
import { getBudgetPeriodStart } from "../../modules/budget/budget-period.js";
import {
  createAnthropicStreamUsageAccumulator,
  parseAnthropicResponse,
} from "../../modules/providers/anthropic-usage.js";
import { inspectProxyRequestBody } from "../../modules/providers/request-body.js";
import { runProviderRequest } from "../../modules/providers/provider-request-runner.js";
import { enforceBudgetAdmission } from "../../modules/proxy/budget-guard.js";
import { enforceLoopDetection } from "../../modules/proxy/loop-guard.js";
import { handleStreamingProxyRequest } from "../../modules/proxy/streaming-proxy.js";
import { recordProxyUsageSafely } from "../../modules/proxy/usage-recorder.js";
import type { ProxyRequestContext } from "../../modules/proxy/types.js";
import type { V1RouteDependencies } from "./dependencies.js";

const ENDPOINT = "/v1/messages";

/**
 * Anthropic-compatible Messages proxy. Non-streaming requests are
 * transparent and buffered (Step 4/5, unchanged); `stream: true` requests
 * (Step 6) are relayed live via the shared streaming orchestration —
 * this route only supplies what's Anthropic-specific: the adapter and
 * the usage parser/accumulator.
 */
export function registerMessagesRoute(app: FastifyInstance, deps: V1RouteDependencies): void {
  app.post(
    ENDPOINT,
    {
      bodyLimit: deps.proxy.maxBodyBytes,
      preHandler: deps.proxy.requireTokenGuardKey,
    },
    async (request, reply) => {
      const startedAt = performance.now();
      const rawBody = request.body as Buffer;
      const { requestedModel, isStreaming, parsedBody } = inspectProxyRequestBody(rawBody);

      const tokenGuardContext = request.tokenGuardContext;
      if (!tokenGuardContext) {
        // Unreachable in practice: the preHandler above always sets this
        // before the handler runs. Defensive only, mirrors me.route.ts.
        throw unauthorizedError();
      }

      const context: ProxyRequestContext = {
        requestId: request.id,
        organizationId: tokenGuardContext.organizationId,
        tokenGuardKeyId: tokenGuardContext.keyId,
        provider: "anthropic",
        requestedModel,
        startedAt,
        budgetPeriodStart: getBudgetPeriodStart(),
      };

      // Loop detection runs before any upstream contact — a blocked
      // signature never reaches the provider and never produces a usage
      // log (see modules/proxy/loop-guard.ts).
      const loopDecision = enforceLoopDetection(
        {
          detector: deps.proxy.loopDetector,
          organizationId: context.organizationId,
          tokenGuardKeyId: context.tokenGuardKeyId,
          provider: context.provider,
          endpoint: ENDPOINT,
          requestedModel,
          parsedBody,
          requestId: context.requestId,
        },
        reply,
        request.log,
      );
      if (loopDecision.blocked) {
        return;
      }

      // Budget admission (Phase A, Step 8) also runs before any upstream
      // contact — a blocked organization never reaches the provider and
      // never produces a usage log. See modules/proxy/budget-guard.ts.
      const budgetDecision = await enforceBudgetAdmission(
        {
          budgetService: deps.proxy.budgetService,
          organizationId: context.organizationId,
          tokenGuardKeyId: context.tokenGuardKeyId,
          provider: context.provider,
          endpoint: ENDPOINT,
          requestedModel,
          periodStart: context.budgetPeriodStart,
          requestId: context.requestId,
        },
        reply,
        request.log,
      );
      if (budgetDecision.blocked) {
        return;
      }

      if (isStreaming) {
        return handleStreamingProxyRequest({
          request,
          reply,
          adapter: deps.proxy.anthropicAdapter,
          rawBody,
          requestedModel,
          connectTimeoutMs: deps.proxy.requestTimeoutMs,
          streamMaxDurationMs: deps.proxy.streamMaxDurationMs,
          usageRecorder: deps.proxy.usageRecorder,
          context,
          parseBufferedResponse: parseAnthropicResponse,
          createStreamAccumulator: createAnthropicStreamUsageAccumulator,
        });
      }

      const result = await runProviderRequest(
        deps.proxy.anthropicAdapter,
        { body: rawBody, clientHeaders: request.headers },
        deps.proxy.requestTimeoutMs,
      );
      const durationMs = Math.round(performance.now() - startedAt);

      await recordProxyUsageSafely(
        deps.proxy.usageRecorder,
        {
          context,
          statusCode: result.status,
          durationMs,
          parsedResponse: parseAnthropicResponse(result.body, requestedModel),
        },
        request.log,
      );

      reply.status(result.status);
      if (result.contentType) {
        reply.header("content-type", result.contentType);
      }
      return reply.send(result.body);
    },
  );
}
