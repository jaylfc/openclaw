/**
 * taos-bridge — connects openclaw to taOS.
 *
 * Only active when TAOS_BRIDGE_URL is set in the environment; without
 * that env var this module is a complete no-op and the build behaves
 * identically to upstream.  When active:
 *
 *  - Fetches a bootstrap document from taOS on startup
 *    (schema_version === 1, else fails loud).
 *  - Opens a long-lived SSE connection to the taOS events endpoint.
 *    On user_message events, dispatches the message into openclaw's
 *    session pipeline via dispatchReplyFromConfig (the same function
 *    all bundled channels use for inbound messages).
 *  - Posts reply deltas, final messages, and errors back to taOS via
 *    the reply URL in the bootstrap.
 *  - Reconnects with 2-second backoff on any SSE error.
 *  - Shuts down cleanly on SIGTERM/SIGINT (openclaw process exit).
 *
 * Coupling policy:
 *  Only two openclaw internals are imported here:
 *    a) dispatchReplyFromConfig + withReplyDispatcher (reply pipeline)
 *    b) buildAgentSessionKey (routing)
 *    c) loadConfig (config snapshot)
 *  All other behaviour is self-contained or uses Node built-ins.
 *  If any import path does not resolve, the bridge logs a clear
 *  error and disables itself — it never monkey-patches internals.
 *
 *  The models.providers.taos entry is NOT written here.  The taOS
 *  deployer already writes it into /root/.openclaw/openclaw.json
 *  before openclaw starts (schema_version === 1 validates this).
 *
 * Hard cap: ≤ 400 LoC (check with `wc -l src/taos-bridge.ts`).
 */

import type { DispatchFromConfigParams } from "./auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatcher } from "./auto-reply/reply/reply-dispatcher.types.js";
// Only these types are imported at the top level; implementations are
// loaded lazily inside register() to keep startup cost minimal.
import type { FinalizedMsgContext } from "./auto-reply/templating.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";

// ── Bootstrap schema (schema_version === 1) ───────────────────────────

interface TaosBootstrap {
  schema_version: number;
  agent_name: string;
  session_id: string;
  models: {
    providers: Array<{
      id: string;
      api: string;
      baseUrl: string;
      apiKey: string;
      default_model: string | null;
    }>;
  };
  channel: {
    provider: string;
    events_url: string;
    reply_url: string;
    auth_bearer: string;
  };
  memory: unknown;
  skills_mcp_url: string | null;
}

// ── SSE event payloads ────────────────────────────────────────────────

interface TaosUserMessageEvent {
  id: string;
  trace_id: string;
  channel_id: string;
  from: string;
  text: string;
  created_at: string;
}

// ── Internals loaded at register() time ──────────────────────────────

type BridgeApis = {
  dispatchReplyFromConfig: (params: DispatchFromConfigParams) => Promise<unknown>;
  withReplyDispatcher: <T>(params: {
    dispatcher: ReplyDispatcher;
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
  }) => Promise<T>;
  buildAgentSessionKey: (params: {
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer?: { kind: "direct" | "group" | "channel"; id: string } | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  }) => string;
  loadConfig: () => OpenClawConfig;
};

// ── Constants ─────────────────────────────────────────────────────────

const CHANNEL_ID = "taos";
const RECONNECT_DELAY_MS = 2000;

// ── Module-level abort controller for clean shutdown ──────────────────

let bridgeAbortController: AbortController | null = null;

function shutdownBridge(): void {
  if (bridgeAbortController) {
    bridgeAbortController.abort();
    bridgeAbortController = null;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────

async function fetchBootstrap(
  bridgeUrl: string,
  agentName: string,
  token: string,
): Promise<TaosBootstrap> {
  const url = `${bridgeUrl}/api/openclaw/bootstrap?agent=${encodeURIComponent(agentName)}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new Error(`taos-bridge: bootstrap request failed: ${String(err)}`, { cause: err });
  }
  if (!resp.ok) {
    throw new Error(`taos-bridge: bootstrap HTTP ${resp.status} from ${url}`);
  }
  return (await resp.json()) as TaosBootstrap;
}

// ── Reply to taOS ─────────────────────────────────────────────────────

async function postReply(
  replyUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const resp = await fetch(replyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`[taos-bridge] reply POST HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[taos-bridge] reply POST failed: ${String(err)}`);
  }
}

function buildDispatcher(params: {
  replyUrl: string;
  token: string;
  msgId: string;
  traceId: string;
}): ReplyDispatcher {
  const { replyUrl, token, msgId, traceId } = params;
  const queued = { tool: 0, block: 0, final: 0 };
  const failed = { tool: 0, block: 0, final: 0 };
  let idleResolve: (() => void) | null = null;
  const idlePromise = new Promise<void>((res) => {
    idleResolve = res;
  });

  const fire = (kind: string, text: string | undefined): void => {
    void postReply(replyUrl, token, { kind, id: msgId, trace_id: traceId, content: text }).then(
      () => {
        if (kind === "final" || kind === "error") {
          idleResolve?.();
          idleResolve = null;
        }
      },
    );
  };

  return {
    sendToolResult(p) {
      queued.tool++;
      fire("tool_result", p.text);
      return true;
    },
    sendBlockReply(p) {
      queued.block++;
      fire("delta", p.text);
      return true;
    },
    sendFinalReply(p) {
      queued.final++;
      fire("final", p.text);
      return true;
    },
    waitForIdle() {
      return idlePromise;
    },
    getQueuedCounts() {
      return { ...queued };
    },
    getFailedCounts() {
      return { ...failed };
    },
    markComplete() {
      idleResolve?.();
      idleResolve = null;
    },
  };
}

// ── Inbound dispatch ──────────────────────────────────────────────────

async function dispatchMessage(
  event: TaosUserMessageEvent,
  bootstrap: TaosBootstrap,
  agentName: string,
  apis: BridgeApis,
): Promise<void> {
  const { channel } = bootstrap;
  const sessionKey = apis.buildAgentSessionKey({
    agentId: agentName,
    channel: CHANNEL_ID,
    accountId: null,
    peer: { kind: "direct", id: event.from },
    dmScope: "per-channel-peer",
  });

  const dispatcher = buildDispatcher({
    replyUrl: channel.reply_url,
    token: channel.auth_bearer,
    msgId: event.id,
    traceId: event.trace_id,
  });

  const ctx: FinalizedMsgContext = {
    Body: event.text,
    RawBody: event.text,
    CommandBody: event.text,
    From: event.from,
    To: agentName,
    SessionKey: sessionKey,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ChatType: "direct",
    MessageSid: event.id,
    CommandAuthorized: true,
  };

  try {
    await apis.withReplyDispatcher({
      dispatcher,
      onSettled: () => {},
      run: () => apis.dispatchReplyFromConfig({ ctx, cfg: apis.loadConfig(), dispatcher }),
    });
  } catch (err) {
    console.error(`[taos-bridge] dispatch error for msg ${event.id}: ${String(err)}`);
    void postReply(channel.reply_url, channel.auth_bearer, {
      kind: "error",
      id: event.id,
      trace_id: event.trace_id,
      error: String(err),
    });
  }
}

// ── SSE loop ──────────────────────────────────────────────────────────

function parseSseField(line: string): { field: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) {
    return null;
  }
  return { field: line.slice(0, idx).trim(), value: line.slice(idx + 1).trimStart() };
}

async function runSseLoop(params: {
  bootstrap: TaosBootstrap;
  agentName: string;
  abortSignal: AbortSignal;
  onMessage: (event: TaosUserMessageEvent) => void;
}): Promise<void> {
  const { bootstrap, abortSignal, onMessage } = params;
  const { channel } = bootstrap;

  while (!abortSignal.aborted) {
    try {
      const resp = await fetch(channel.events_url, {
        headers: {
          Authorization: `Bearer ${channel.auth_bearer}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: abortSignal,
      });

      if (!resp.ok || !resp.body) {
        console.warn(`[taos-bridge] SSE HTTP ${resp.ok ? "no-body" : resp.status}; retry`);
        await new Promise<void>((r) => setTimeout(r, RECONNECT_DELAY_MS));
        continue;
      }

      console.log("[taos-bridge] SSE connected");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let evtType = "";
      let evtData = "";
      let reading = true;

      while (reading && !abortSignal.aborted) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch {
          reading = false;
          break;
        }
        if (done) {
          reading = false;
          break;
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trimEnd();
          if (line === "") {
            if (evtType === "user_message" && evtData) {
              try {
                onMessage(JSON.parse(evtData) as TaosUserMessageEvent);
              } catch (e) {
                console.warn(`[taos-bridge] parse error: ${String(e)}`);
              }
            }
            evtType = "";
            evtData = "";
            continue;
          }
          if (line.startsWith(":")) {
            continue;
          }
          const f = parseSseField(line);
          if (!f) {
            continue;
          }
          if (f.field === "event") {
            evtType = f.value;
          }
          if (f.field === "data") {
            evtData = evtData ? `${evtData}\n${f.value}` : f.value;
          }
        }
      }

      reader.cancel().catch(() => {});
    } catch (err) {
      if (abortSignal.aborted) {
        break;
      }
      console.warn(`[taos-bridge] SSE error (${String(err)}); retry`);
    }

    if (!abortSignal.aborted) {
      await new Promise<void>((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
  console.log("[taos-bridge] SSE loop stopped");
}

// ── Public register() — called once at gateway startup ────────────────

export async function register(): Promise<void> {
  const bridgeUrl = process.env.TAOS_BRIDGE_URL;
  if (!bridgeUrl) {
    return;
  } // regression guard — no-op when env unset

  const agentName = process.env.TAOS_AGENT_NAME ?? "";
  const token = process.env.TAOS_LOCAL_TOKEN ?? "";

  if (!agentName) {
    console.error("[taos-bridge] TAOS_AGENT_NAME is not set; bridge disabled");
    return;
  }

  // Lazy-load openclaw internals.  Fail loud if any import path broke.
  let apis: BridgeApis;
  try {
    const [dispatchMod, dispatcherMod, routeMod, configMod] = await Promise.all([
      import("./auto-reply/reply/dispatch-from-config.js"),
      import("./auto-reply/dispatch-dispatcher.js"),
      import("./routing/resolve-route.js"),
      import("./config/config.js"),
    ]);
    apis = {
      dispatchReplyFromConfig:
        dispatchMod.dispatchReplyFromConfig as BridgeApis["dispatchReplyFromConfig"],
      withReplyDispatcher: dispatcherMod.withReplyDispatcher,
      buildAgentSessionKey: routeMod.buildAgentSessionKey as BridgeApis["buildAgentSessionKey"],
      loadConfig: configMod.loadConfig,
    };
  } catch (err) {
    throw new Error(
      `taos-bridge: failed to load openclaw APIs — ${String(err)}. ` +
        "Single-coupling rule: do not patch.",
      { cause: err },
    );
  }

  const bootstrap = await fetchBootstrap(bridgeUrl, agentName, token);

  if (bootstrap.schema_version !== 1) {
    throw new Error(
      `taos-bridge: unsupported schema_version ${bootstrap.schema_version} (expected 1)`,
    );
  }

  bridgeAbortController = new AbortController();
  process.once("SIGTERM", shutdownBridge);
  process.once("SIGINT", shutdownBridge);

  console.log(
    `[taos-bridge] starting; agent=${agentName} schema_version=${bootstrap.schema_version}`,
  );

  // Run SSE loop in background — do not block gateway startup.
  void runSseLoop({
    bootstrap,
    agentName,
    abortSignal: bridgeAbortController.signal,
    onMessage(event) {
      void dispatchMessage(event, bootstrap, agentName, apis);
    },
  });
}
