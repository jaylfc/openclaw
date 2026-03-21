import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "../../src/plugins/types.js";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";

const pluginApiMocks = vi.hoisted(() => ({
  clearDeviceBootstrapTokens: vi.fn(async () => ({ removed: 2 })),
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "boot-token",
    expiresAtMs: Date.now() + 10 * 60_000,
  })),
  revokeDeviceBootstrapToken: vi.fn(async () => ({ removed: true })),
  renderQrPngBase64: vi.fn(async () => "ZmFrZXBuZw=="),
  resolvePreferredOpenClawTmpDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-device-pair-tests")),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<object>("./api.js");
  return {
    ...actual,
    approveDevicePairing: vi.fn(),
    clearDeviceBootstrapTokens: pluginApiMocks.clearDeviceBootstrapTokens,
    issueDeviceBootstrapToken: pluginApiMocks.issueDeviceBootstrapToken,
    listDevicePairing: vi.fn(async () => ({ pending: [] })),
    renderQrPngBase64: pluginApiMocks.renderQrPngBase64,
    revokeDeviceBootstrapToken: pluginApiMocks.revokeDeviceBootstrapToken,
    resolvePreferredOpenClawTmpDir: pluginApiMocks.resolvePreferredOpenClawTmpDir,
    resolveGatewayBindUrl: vi.fn(),
    resolveTailnetHostWithRunner: vi.fn(),
    runPluginCommandWithTimeout: vi.fn(),
  };
});

vi.mock("./notify.js", () => ({
  armPairNotifyOnce: vi.fn(async () => false),
  formatPendingRequests: vi.fn(() => "No pending device pairing requests."),
  handleNotifyCommand: vi.fn(async () => ({ text: "notify" })),
  registerPairingNotifierService: vi.fn(),
}));

import registerDevicePair from "./index.js";

function createApi(params?: {
  runtime?: OpenClawPluginApi["runtime"];
  pluginConfig?: Record<string, unknown>;
  registerCommand?: (command: OpenClawPluginCommandDefinition) => void;
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "device-pair",
    name: "device-pair",
    source: "test",
    config: {
      gateway: {
        auth: {
          mode: "token",
          token: "gateway-token",
        },
      },
    },
    pluginConfig: {
      publicUrl: "ws://51.79.175.165:18789",
      ...(params?.pluginConfig ?? {}),
    },
    runtime: (params?.runtime ?? {}) as OpenClawPluginApi["runtime"],
    registerCommand: params?.registerCommand,
  }) as OpenClawPluginApi;
}

function createCommandContext(params?: Partial<PluginCommandContext>): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: "/pair qr",
    args: "qr",
    config: {},
    ...params,
  };
}

describe("device-pair /pair qr", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pluginApiMocks.issueDeviceBootstrapToken.mockResolvedValue({
      token: "boot-token",
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    await fs.mkdir(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true, force: true });
  });

  it("returns an inline QR image for webchat surfaces", async () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    registerDevicePair.register(
      createApi({
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    const result = await command?.handler(createCommandContext({ channel: "webchat" }));

    expect(pluginApiMocks.renderQrPngBase64).toHaveBeenCalledTimes(1);
    expect(result?.text).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(result?.text).toContain("![OpenClaw pairing QR](data:image/png;base64,ZmFrZXBuZw==)");
    expect(result?.text).toContain("- Security: single-use bootstrap token");
    expect(result?.text).toContain("**Important:** Run `/pair cleanup` after pairing finishes.");
    expect(result?.text).toContain("If this QR code leaks, run `/pair cleanup` immediately.");
    expect(result?.text).not.toContain("```");
  });

  it.each([
    {
      label: "Telegram",
      runtimeKey: "telegram",
      sendKey: "sendMessageTelegram",
      ctx: {
        channel: "telegram",
        senderId: "123",
        accountId: "default",
        messageThreadId: 271,
      },
      expectedTarget: "123",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
        expect(opts.messageThreadId).toBe(271);
      },
    },
    {
      label: "Discord",
      runtimeKey: "discord",
      sendKey: "sendMessageDiscord",
      ctx: {
        channel: "discord",
        senderId: "123",
        accountId: "default",
      },
      expectedTarget: "user:123",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
      },
    },
    {
      label: "Slack",
      runtimeKey: "slack",
      sendKey: "sendMessageSlack",
      ctx: {
        channel: "slack",
        senderId: "user:U123",
        accountId: "default",
        messageThreadId: "1234567890.000001",
      },
      expectedTarget: "user:U123",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
        expect(opts.threadTs).toBe("1234567890.000001");
      },
    },
    {
      label: "Signal",
      runtimeKey: "signal",
      sendKey: "sendMessageSignal",
      ctx: {
        channel: "signal",
        senderId: "signal:+15551234567",
        accountId: "default",
      },
      expectedTarget: "signal:+15551234567",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
      },
    },
    {
      label: "iMessage",
      runtimeKey: "imessage",
      sendKey: "sendMessageIMessage",
      ctx: {
        channel: "imessage",
        senderId: "+15551234567",
        accountId: "default",
      },
      expectedTarget: "+15551234567",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
      },
    },
    {
      label: "WhatsApp",
      runtimeKey: "whatsapp",
      sendKey: "sendMessageWhatsApp",
      ctx: {
        channel: "whatsapp",
        senderId: "+15551234567",
        accountId: "default",
      },
      expectedTarget: "+15551234567",
      assertOpts: (opts: Record<string, unknown>) => {
        expect(opts.accountId).toBe("default");
        expect(opts.verbose).toBe(false);
      },
    },
  ])("sends $label a real QR image attachment", async (testCase) => {
    let sentPng = "";
    const sendMessage = vi.fn().mockImplementation(async (_target, _caption, opts) => {
      if (opts?.mediaUrl) {
        sentPng = await fs.readFile(opts.mediaUrl, "utf8");
      }
      return { messageId: "1" };
    });
    let command: OpenClawPluginCommandDefinition | undefined;
    registerDevicePair.register(
      createApi({
        runtime: {
          channel: {
            [testCase.runtimeKey]: {
              [testCase.sendKey]: sendMessage,
            },
          },
        } as unknown as OpenClawPluginApi["runtime"],
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    const result = await command?.handler(createCommandContext(testCase.ctx));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [target, caption, opts] = sendMessage.mock.calls[0] as [
      string,
      string,
      {
        mediaUrl?: string;
        mediaLocalRoots?: string[];
        accountId?: string;
      } & Record<string, unknown>,
    ];
    expect(target).toBe(testCase.expectedTarget);
    expect(caption).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(caption).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(caption).toContain("If this QR code leaks, run /pair cleanup immediately.");
    expect(opts.mediaUrl).toMatch(/pair-qr\.png$/);
    expect(opts.mediaLocalRoots).toEqual([path.dirname(opts.mediaUrl!)]);
    testCase.assertOpts(opts);
    expect(sentPng).toBe("fakepng");
    await expect(fs.access(opts.mediaUrl!)).rejects.toBeTruthy();
    expect(result?.text).toContain("QR code sent above.");
    expect(result?.text).toContain("IMPORTANT: Run /pair cleanup after pairing finishes.");
  });

  it("reissues the bootstrap token after QR delivery failure before falling back", async () => {
    pluginApiMocks.issueDeviceBootstrapToken
      .mockResolvedValueOnce({
        token: "first-token",
        expiresAtMs: Date.now() + 10 * 60_000,
      })
      .mockResolvedValueOnce({
        token: "second-token",
        expiresAtMs: Date.now() + 10 * 60_000,
      });

    const sendMessage = vi.fn().mockRejectedValue(new Error("upload failed"));
    let command: OpenClawPluginCommandDefinition | undefined;
    registerDevicePair.register(
      createApi({
        runtime: {
          channel: {
            discord: {
              sendMessageDiscord: sendMessage,
            },
          },
        } as unknown as OpenClawPluginApi["runtime"],
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    const result = await command?.handler(
      createCommandContext({
        channel: "discord",
        senderId: "123",
      }),
    );

    expect(pluginApiMocks.revokeDeviceBootstrapToken).toHaveBeenCalledWith({
      token: "first-token",
    });
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(2);
    expect(result?.text).toContain("Pairing setup code generated.");
    expect(result?.text).toContain("If this code leaks or you are done, run /pair cleanup");
  });

  it("falls back to the setup code instead of ASCII when the channel cannot send media", async () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    registerDevicePair.register(
      createApi({
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    const result = await command?.handler(
      createCommandContext({
        channel: "msteams",
        senderId: "8:orgid:123",
      }),
    );

    expect(result?.text).toContain("QR image delivery is not available on this channel");
    expect(result?.text).toContain("Setup code:");
    expect(result?.text).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(result?.text).not.toContain("```");
  });

  it("supports invalidating unused setup codes", async () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    registerDevicePair.register(
      createApi({
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    const result = await command?.handler(
      createCommandContext({
        args: "cleanup",
        commandBody: "/pair cleanup",
      }),
    );

    expect(pluginApiMocks.clearDeviceBootstrapTokens).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "Invalidated 2 unused setup codes." });
  });
});
