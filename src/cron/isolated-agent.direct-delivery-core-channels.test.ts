import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type {
  ChannelId,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

async function runExplicitAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  channel: ChannelId;
  to: string;
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: {
        mode: "announce",
        channel: params.channel,
        to: params.to,
      },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
}

type CoreChannel = "slack";
type TestSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId?: string } & Record<string, unknown>>;

function withRequiredMessageId(channel: CoreChannel, result: Awaited<ReturnType<TestSendFn>>) {
  return {
    channel,
    ...result,
    messageId:
      typeof result.messageId === "string" && result.messageId.trim()
        ? result.messageId
        : `${channel}-test-message`,
  };
}

function resolveCoreChannelSender(
  channel: CoreChannel,
  deps: ChannelOutboundContext["deps"],
): TestSendFn {
  const sender = resolveOutboundSendDep<TestSendFn>(deps, channel);
  if (!sender) {
    throw new Error(`missing ${channel} sender`);
  }
  return sender;
}

function createCliDelegatingOutbound(params: {
  channel: CoreChannel;
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  resolveTarget?: ChannelOutboundAdapter["resolveTarget"];
}): ChannelOutboundAdapter {
  return {
    deliveryMode: params.deliveryMode ?? "direct",
    ...(params.resolveTarget ? { resolveTarget: params.resolveTarget } : {}),
    sendText: async ({ cfg, to, text, accountId, deps }) =>
      withRequiredMessageId(
        params.channel,
        await resolveCoreChannelSender(params.channel, deps)(to, text, {
          cfg,
          accountId: accountId ?? undefined,
        }),
      ),
  };
}

const emptyRegistry = createTestRegistry([]);

describe("runCronIsolatedAgentTurn core-channel direct delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
    setActivePluginRegistry(emptyRegistry);
  });

  it("routes a representative direct core-channel delivery through CLI send deps", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "slack",
            plugin: createOutboundTestPlugin({
              id: "slack",
              outbound: createCliDelegatingOutbound({ channel: "slack" }),
            }),
            source: "test",
          },
        ]),
      );

      const res = await runExplicitAnnounceTurn({
        home,
        storePath,
        deps,
        channel: "slack",
        to: "channel:C12345",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageSlack).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSlack).toHaveBeenCalledWith(
        "channel:C12345",
        "hello from cron",
        expect.any(Object),
      );
    });
  });

  it("routes gateway resolveTarget delivery through the outbound adapter", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      const sendText = vi.fn(async ({ to, text }: { to: string; text: string }) => ({
        channel: "demo-gateway" as const,
        messageId: "demo-gateway-message",
        conversationId: to,
        meta: { echoedText: text },
      }));
      mockAgentPayloads([{ text: "hello from cron" }]);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "demo-gateway",
            plugin: createOutboundTestPlugin({
              id: "demo-gateway",
              outbound: {
                deliveryMode: "gateway",
                resolveTarget: ({ to }) => {
                  const normalized = String(to ?? "")
                    .trim()
                    .replace(/^user:/i, "");
                  return normalized
                    ? { ok: true as const, to: normalized }
                    : { ok: false as const, error: new Error("target is required") };
                },
                sendText,
              },
            }),
            source: "test",
          },
        ]),
      );

      const res = await runExplicitAnnounceTurn({
        home,
        storePath,
        deps,
        channel: "demo-gateway",
        to: "user:target-123",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "target-123",
          text: "hello from cron",
        }),
      );
    });
  });
});
