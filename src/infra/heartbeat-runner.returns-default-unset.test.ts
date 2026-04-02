import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { typedCases } from "../test-utils/typed-cases.js";
import {
  type HeartbeatDeps,
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";
import {
  createWhatsAppResolveTargetForTest,
  telegramMessagingForTest,
} from "./outbound/targets.test-helpers.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

const heartbeatWhatsAppOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  resolveTarget: createWhatsAppResolveTargetForTest(),
  sendText: async ({ to, text, deps, accountId }) => {
    if (!deps?.["whatsapp"]) {
      throw new Error("sendWhatsApp missing");
    }
    const res = await (deps["whatsapp"] as Function)(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
    });
    return { channel: "whatsapp", messageId: res.messageId, toJid: res.toJid };
  },
  sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
    if (!deps?.["whatsapp"]) {
      throw new Error("sendWhatsApp missing");
    }
    const res = await (deps["whatsapp"] as Function)(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      mediaUrl,
    });
    return { channel: "whatsapp", messageId: res.messageId, toJid: res.toJid };
  },
};

describe("resolveHeartbeatIntervalMs", () => {
  it("returns default when unset", () => {
    expect(resolveHeartbeatIntervalMs({})).toBe(30 * 60_000);
  });

  it("returns null when invalid or zero", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "0m" } } },
      }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "oops" } } },
      }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5m" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "2h" } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });

  it("uses explicit heartbeat overrides when provided", () => {
    expect(
      resolveHeartbeatIntervalMs(
        { agents: { defaults: { heartbeat: { every: "30m" } } } },
        undefined,
        { every: "5m" },
      ),
    ).toBe(5 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it.each([
    { name: "default prompt", cfg: {} as OpenClawConfig, expected: HEARTBEAT_PROMPT },
    {
      name: "trimmed override prompt",
      cfg: {
        agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
      } as OpenClawConfig,
      expected: "ping",
    },
  ])("uses $name", ({ cfg, expected }) => {
    expect(resolveHeartbeatPrompt(cfg)).toBe(expected);
  });
});

describe("isHeartbeatEnabledForAgent", () => {
  it("enables only explicit heartbeat agents when configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("falls back to default agent when no explicit heartbeat entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });
});

describe("runHeartbeatOnce", () => {
  let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
  let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    previousRegistry = getActivePluginRegistry();

    const whatsappPlugin = createOutboundTestPlugin({
      id: "whatsapp",
      outbound: heartbeatWhatsAppOutbound,
    });
    whatsappPlugin.config = {
      ...whatsappPlugin.config,
      resolveAllowFrom: ({ cfg }) =>
        cfg.channels?.whatsapp?.allowFrom?.map((entry) => String(entry)) ?? [],
    };

    const telegramPlugin = createOutboundTestPlugin({
      id: "telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async ({ to, text, deps, accountId }) => {
          if (!deps?.["telegram"]) {
            throw new Error("sendTelegram missing");
          }
          const res = await (deps["telegram"] as Function)(to, text, {
            verbose: false,
            accountId: accountId ?? undefined,
          });
          return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
        },
        sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
          if (!deps?.["telegram"]) {
            throw new Error("sendTelegram missing");
          }
          const res = await (deps["telegram"] as Function)(to, text, {
            verbose: false,
            accountId: accountId ?? undefined,
            mediaUrl,
          });
          return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
        },
      },
      messaging: telegramMessagingForTest,
    });
    telegramPlugin.config = {
      ...telegramPlugin.config,
      listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
      resolveAllowFrom: ({ cfg, accountId }) => {
        const channel = cfg.channels?.telegram;
        const normalized = accountId?.trim();
        if (normalized && channel?.accounts?.[normalized]?.allowFrom) {
          return channel.accounts[normalized].allowFrom?.map((entry) => String(entry)) ?? [];
        }
        return channel?.allowFrom?.map((entry) => String(entry)) ?? [];
      },
    };

    testRegistry = createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]);
    setActivePluginRegistry(testRegistry);

    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-suite-"));
  });

  beforeEach(() => {
    resetSystemEventsForTest();
    if (testRegistry) {
      setActivePluginRegistry(testRegistry);
    }
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  const createHeartbeatDeps = (
    sendWhatsApp: (
      to: string,
      text: string,
      opts?: unknown,
    ) => Promise<{ messageId: string; toJid: string }>,
    options?: {
      nowMs?: number;
      getReplyFromConfig?: HeartbeatDeps["getReplyFromConfig"];
    },
  ): HeartbeatDeps => ({
    whatsapp: sendWhatsApp,
    getQueueSize: () => 0,
    nowMs: () => options?.nowMs ?? 0,
    webAuthExists: async () => true,
    hasActiveWebListener: () => true,
    ...(options?.getReplyFromConfig ? { getReplyFromConfig: options.getReplyFromConfig } : null),
  });

  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("skips outside active hours", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          userTimezone: "UTC",
          heartbeat: {
            every: "30m",
            activeHours: { start: "08:00", end: "24:00", timezone: "user" },
          },
        },
      },
    };

    const res = await runHeartbeatOnce({
      cfg,
      deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("quiet-hours");
    }
  });

  it("uses the last non-empty payload for delivery", async () => {
    const tmpDir = await createCaseDir("hb-last-payload");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Let me check..." }, { text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "120363401234567890@g.us",
        "Final alert",
        expect.any(Object),
      );
    } finally {
      replySpy.mockReset();
    }
  });

  it("uses per-agent heartbeat overrides and session keys", async () => {
    const tmpDir = await createCaseDir("hb-agent-overrides");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );
      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });
      await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "120363401234567890@g.us",
        "Final alert",
        expect.any(Object),
      );
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringMatching(/Ops check[\s\S]*Current time: /),
          SessionKey: sessionKey,
          From: "120363401234567890@g.us",
          To: "120363401234567890@g.us",
          OriginatingChannel: "whatsapp",
          OriginatingTo: "120363401234567890@g.us",
          Provider: "heartbeat",
        }),
        expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
        cfg,
      );
    } finally {
      replySpy.mockReset();
    }
  });

  it("reuses non-default agent sessionFile from templated stores", async () => {
    const tmpDir = await createCaseDir("hb-templated-store");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json");
    const replySpy = vi.fn();
    const agentId = "ops";
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: agentId,
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      const storePath = resolveStorePath(storeTemplate, { agentId });
      const sessionsDir = path.dirname(storePath);
      const sessionId = "sid-ops";
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile, "", "utf-8");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            sessionFile,
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });
      const result = await runHeartbeatOnce({
        cfg,
        agentId,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "120363401234567890@g.us",
        "Final alert",
        expect.any(Object),
      );
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: sessionKey,
          From: "120363401234567890@g.us",
          To: "120363401234567890@g.us",
          Provider: "heartbeat",
        }),
        expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
        cfg,
      );
    } finally {
      replySpy.mockReset();
    }
  });

  it.each([
    {
      name: "heartbeat.session",
      caseDir: "hb-explicit-session",
      peerKind: "group" as const,
      peerId: "120363401234567890@g.us",
      message: "Group alert",
      applyOverride: ({ cfg, sessionKey }: { cfg: OpenClawConfig; sessionKey: string }) => {
        if (cfg.agents?.defaults?.heartbeat) {
          cfg.agents.defaults.heartbeat.session = sessionKey;
        }
      },
      runOptions: ({ sessionKey: _sessionKey }: { sessionKey: string }) => ({
        sessionKey: undefined as string | undefined,
      }),
    },
    {
      name: "runHeartbeatOnce sessionKey arg",
      caseDir: "hb-forced-session-override",
      peerKind: "group" as const,
      peerId: "120363401234567891@g.us",
      message: "Forced alert",
      applyOverride: () => {},
      runOptions: ({ sessionKey }: { sessionKey: string }) => ({ sessionKey }),
    },
  ])(
    "resolves configured and forced session key overrides: $name",
    async ({ name, caseDir, peerKind, peerId, message, applyOverride, runOptions }) => {
      const replySpy = vi.fn();
      try {
        const tmpDir = await createCaseDir(caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const mainSessionKey = resolveMainSessionKey(cfg);
        const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
        const overrideSessionKey = buildAgentPeerSessionKey({
          agentId,
          channel: "whatsapp",
          peerKind,
          peerId,
        });
        applyOverride({ cfg, sessionKey: overrideSessionKey });

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [mainSessionKey]: {
              sessionId: "sid-main",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastTo: "120363401234567890@g.us",
            },
            [overrideSessionKey]: {
              sessionId: `sid-${peerKind}`,
              updatedAt: Date.now() + 10_000,
              lastChannel: "whatsapp",
              lastTo: peerId,
            },
          }),
        );

        replySpy.mockClear();
        replySpy.mockResolvedValue([{ text: message }]);
        const sendWhatsApp = vi
          .fn<
            (
              to: string,
              text: string,
              opts?: unknown,
            ) => Promise<{ messageId: string; toJid: string }>
          >()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          ...runOptions({ sessionKey: overrideSessionKey }),
          deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
        });

        expect(sendWhatsApp, name).toHaveBeenCalledTimes(1);
        expect(sendWhatsApp, name).toHaveBeenCalledWith(peerId, message, expect.any(Object));
        expect(replySpy, name).toHaveBeenCalledWith(
          expect.objectContaining({
            SessionKey: overrideSessionKey,
            From: peerId,
            To: peerId,
            Provider: "heartbeat",
          }),
          expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
          cfg,
        );
      } finally {
        replySpy.mockReset();
      }
    },
  );

  it("suppresses duplicate heartbeat payloads within 24h", async () => {
    const tmpDir = await createCaseDir("hb-dup-suppress");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
            lastHeartbeatText: "Final alert",
            lastHeartbeatSentAt: 0,
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, {
          nowMs: 60_000,
          getReplyFromConfig: replySpy,
        }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
    } finally {
      replySpy.mockReset();
    }
  });

  it.each(
    typedCases<{
      name: string;
      caseDir: string;
      replies: Array<{ text: string }>;
      expectedTexts: string[];
    }>([
      {
        name: "reasoning + final payload",
        caseDir: "hb-reasoning",
        replies: [{ text: "Reasoning:\n_Because it helps_" }, { text: "Final alert" }],
        expectedTexts: ["Reasoning:\n_Because it helps_", "Final alert"],
      },
      {
        name: "reasoning + HEARTBEAT_OK",
        caseDir: "hb-reasoning-heartbeat-ok",
        replies: [{ text: "Reasoning:\n_Because it helps_" }, { text: "HEARTBEAT_OK" }],
        expectedTexts: ["Reasoning:\n_Because it helps_"],
      },
    ]),
  )(
    "handles reasoning payload delivery variants: $name",
    async ({ name, caseDir, replies, expectedTexts }) => {
      const replySpy = vi.fn();
      try {
        const tmpDir = await createCaseDir(caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                includeReasoning: true,
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "120363401234567890@g.us",
            },
          }),
        );

        replySpy.mockClear();
        replySpy.mockResolvedValue(replies);
        const sendWhatsApp = vi
          .fn<
            (
              to: string,
              text: string,
              opts?: unknown,
            ) => Promise<{ messageId: string; toJid: string }>
          >()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
        });

        expect(sendWhatsApp, name).toHaveBeenCalledTimes(expectedTexts.length);
        for (const [index, text] of expectedTexts.entries()) {
          expect(sendWhatsApp, name).toHaveBeenNthCalledWith(
            index + 1,
            "120363401234567890@g.us",
            text,
            expect.any(Object),
          );
        }
      } finally {
        replySpy.mockReset();
      }
    },
  );

  it("loads the default agent session from templated stores", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "whatsapp" } },
          list: [{ id: "work", default: true }],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = resolveStorePath(storeTemplate, { agentId });

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "120363401234567890@g.us",
        "Hello from heartbeat",
        expect.any(Object),
      );
    } finally {
      replySpy.mockReset();
    }
  });

  type HeartbeatFileState = "empty" | "actionable" | "missing" | "read-error";

  async function runHeartbeatFileScenario(params: {
    fileState: HeartbeatFileState;
    reason?: "interval" | "wake";
    queueCronEvent?: boolean;
    replyText?: string;
  }) {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    if (params.fileState === "empty") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );
    } else if (params.fileState === "actionable") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n- Check server logs\n- Review pending PRs\n",
        "utf-8",
      );
    } else if (params.fileState === "read-error") {
      // readFile on a directory triggers EISDIR.
      await fs.mkdir(path.join(workspaceDir, "HEARTBEAT.md"), { recursive: true });
    }

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "whatsapp" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    if (params.queueCronEvent) {
      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });
    }

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: params.replyText ?? "Checked logs and PRs" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const res = await runHeartbeatOnce({
      cfg,
      reason: params.reason,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });
    return { res, replySpy, sendWhatsApp, workspaceDir };
  }

  it("adds explicit workspace HEARTBEAT.md path guidance to heartbeat prompts", async () => {
    const { res, replySpy, sendWhatsApp, workspaceDir } = await runHeartbeatFileScenario({
      fileState: "actionable",
      reason: "interval",
      replyText: "Checked logs and PRs",
    });
    try {
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { Body?: string };
      const expectedPath = path.join(workspaceDir, "HEARTBEAT.md").replace(/\\/g, "/");
      expect(calledCtx.Body).toContain(`use workspace file ${expectedPath} (exact case)`);
      expect(calledCtx.Body).toContain("Do not read docs/heartbeat.md.");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("applies HEARTBEAT.md gating rules across file states and triggers", async () => {
    const cases: Array<{
      name: string;
      fileState: HeartbeatFileState;
      reason?: "interval" | "wake";
      queueCronEvent?: boolean;
      expectedStatus: "ran" | "skipped";
      expectedSkipReason?: "empty-heartbeat-file";
      expectedSendCalls: number;
      expectedReplyCalls: number;
      expectCronContext?: boolean;
      replyText?: string;
    }> = [
      {
        name: "empty file + interval skips",
        fileState: "empty",
        expectedStatus: "skipped",
        expectedSkipReason: "empty-heartbeat-file",
        expectedSendCalls: 0,
        expectedReplyCalls: 0,
      },
      {
        name: "empty file + wake runs",
        fileState: "empty",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "empty file + queued cron interval runs",
        fileState: "empty",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
      {
        name: "actionable file runs",
        fileState: "actionable",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file runs",
        fileState: "missing",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "read error runs",
        fileState: "read-error",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file + wake runs",
        fileState: "missing",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "missing file + queued cron interval runs",
        fileState: "missing",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
    ];

    for (const {
      name,
      expectedStatus,
      expectedSkipReason,
      expectedReplyCalls,
      expectedSendCalls,
      expectCronContext,
      ...scenario
    } of cases) {
      const { res, replySpy, sendWhatsApp } = await runHeartbeatFileScenario(scenario);
      try {
        expect(res.status, name).toBe(expectedStatus);
        if (res.status === "skipped") {
          expect(res.reason, name).toBe(expectedSkipReason);
        }
        expect(replySpy, name).toHaveBeenCalledTimes(expectedReplyCalls);
        expect(sendWhatsApp, name).toHaveBeenCalledTimes(expectedSendCalls);
        if (expectCronContext) {
          const calledCtx = replySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
          expect(calledCtx.Provider, name).toBe("cron-event");
          expect(calledCtx.Body, name).toContain("scheduled reminder has been triggered");
        }
      } finally {
        replySpy.mockReset();
      }
    }
  });

  it("uses an internal-only cron prompt when heartbeat delivery target is none", async () => {
    const tmpDir = await createCaseDir("hb-cron-target-none");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "none" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    enqueueSystemEvent("Cron: rotate logs", {
      sessionKey,
      contextKey: "cron:rotate-logs",
    });

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: "Handled internally" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
      expect(calledCtx.Provider).toBe("cron-event");
      expect(calledCtx.Body).toContain("Handle this reminder internally");
      expect(calledCtx.Body).not.toContain("Please relay this reminder to the user");
    } finally {
      replySpy.mockReset();
    }
  });

  it("uses an internal-only exec prompt when heartbeat delivery target is none", async () => {
    const tmpDir = await createCaseDir("hb-exec-target-none");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "none" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    enqueueSystemEvent("exec finished: backup completed", {
      sessionKey,
      contextKey: "exec:backup",
    });

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: "Handled internally" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "exec-event",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
      const calledCtx = replySpy.mock.calls[0]?.[0] as {
        Provider?: string;
        Body?: string;
        ForceSenderIsOwnerFalse?: boolean;
      };
      expect(calledCtx.Provider).toBe("exec-event");
      expect(calledCtx.ForceSenderIsOwnerFalse).toBe(true);
      expect(calledCtx.Body).toContain("Handle the result internally");
      expect(calledCtx.Body).not.toContain("Please relay the command output to the user");
    } finally {
      replySpy.mockReset();
    }
  });
});
