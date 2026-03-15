import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { registerContextEngineForOwner } from "../context-engine/registry.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import { registerPluginCommand } from "./commands.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import { registerPluginInteractiveHandler } from "./interactive.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { PluginRuntime } from "./runtime/types.js";
import { defaultSlotIdForKey } from "./slots.js";
import {
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "./types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginHookOptions,
  ProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginBundleFormat,
  PluginFormat,
  PluginLogger,
  PluginOrigin,
  PluginKind,
  PluginHookName,
  PluginHookHandlerMap,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";

export type PluginToolRegistration = {
  pluginId: string;
  pluginName?: string;
  factory: OpenClawPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
  rootDir?: string;
};

export type PluginCliRegistration = {
  pluginId: string;
  pluginName?: string;
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  source: string;
  rootDir?: string;
};

export type PluginHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  source?: string;
};

export type PluginChannelRegistration = {
  pluginId: string;
  pluginName?: string;
  plugin: ChannelPlugin;
  dock?: ChannelDock;
  source: string;
  rootDir?: string;
};

export type PluginProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: ProviderPlugin;
  source: string;
  rootDir?: string;
};

export type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type PluginServiceRegistration = {
  pluginId: string;
  pluginName?: string;
  service: OpenClawPluginService;
  source: string;
  rootDir?: string;
};

export type PluginCommandRegistration = {
  pluginId: string;
  pluginName?: string;
  command: OpenClawPluginCommandDefinition;
  source: string;
  rootDir?: string;
};

export type PluginRecordLifecycleState =
  | "prepared"
  | "imported"
  | "disabled"
  | "validated"
  | "registered"
  | "ready"
  | "error";

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind;
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  lifecycleState?: PluginRecordLifecycleState;
  error?: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: Record<string, unknown>;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  commands: PluginCommandRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  runtime: PluginRuntime;
};

type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
};

const constrainLegacyPromptInjectionHook = (
  handler: PluginHookHandlerMap["before_agent_start"],
): PluginHookHandlerMap["before_agent_start"] => {
  return (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };
};

export function createEmptyPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: OpenClawPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      pluginName: record.name,
      factory,
      names: normalized,
      optional,
      source: record.source,
      rootDir: record.rootDir,
    });
    addExtensionToolRegistration({ registry, record, names: result.names, entry: result.entry });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
  ) => {
    const normalized = resolveExtensionLegacyHookRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      events,
      handler,
      opts,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }
    const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === name);
    if (existingHook) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `hook already registered: ${name} (${existingHook.pluginId})`,
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          metadata: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      pluginId: normalized.entry.pluginId,
      entry: normalized.entry.entry,
      events: normalized.events,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }

    for (const event of normalized.events) {
      registerInternalHook(event, handler);
    }
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
  ) => {
    const result = resolveExtensionGatewayMethodRegistration({
      existing: registry.gatewayHandlers,
      coreGatewayMethods,
      method,
      handler,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    addExtensionGatewayMethodRegistration({
      registry,
      record,
      method: result.method,
      handler: result.handler,
    });
  };

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const result = resolveExtensionHttpRouteRegistration({
      existing: registry.httpRoutes,
      ownerPluginId: record.id,
      ownerSource: record.source,
      route: params,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: result.message === "http route registration missing path" ? "warn" : "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    if (result.action === "replace") {
      addExtensionHttpRouteRegistration({
        registry,
        record,
        action: "replace",
        existingIndex: result.existingIndex,
        entry: result.entry,
      });
      return;
    }
    addExtensionHttpRouteRegistration({
      registry,
      record,
      action: "append",
      entry: result.entry,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
  ) => {
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalized.plugin;
    const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "channel registration missing id",
      });
      return;
    }
    const existing = registry.channels.find((entry) => entry.plugin.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.channelIds.push(id);
    registry.channels.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      dock: normalized.dock,
      source: record.source,
      rootDir: record.rootDir,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    addExtensionChannelRegistration({
      registry,
      record,
      channelId: result.channelId,
      entry: result.entry,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      source: record.source,
      provider,
      pushDiagnostic,
    });
    if (!normalizedProvider) {
      return;
    }
    const result = resolveExtensionProviderRegistration({
      existing: registry.providers,
      ownerPluginId: record.id,
      ownerSource: record.source,
      provider: normalizedProvider,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    record.providerIds.push(id);
    registry.providers.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => {
    const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli registration missing explicit commands metadata",
      });
      return;
    }
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands.some((command) => commands.includes(command)),
    );
    if (existing) {
      const overlap = commands.find((command) => existing.commands.includes(command));
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
      });
      return;
    }
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      pluginId: record.id,
      pluginName: record.name,
      register: registrar,
      commands,
      source: record.source,
      rootDir: record.rootDir,
    });
    addExtensionCliRegistration({
      registry,
      record,
      commands: result.commands,
      entry: result.entry,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const result = resolveExtensionServiceRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      service,
    });
    if (!result.ok) {
      return;
    }
    const existing = registry.services.find((entry) => entry.service.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `service already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      pluginName: record.name,
      service,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const normalized = resolveExtensionCommandRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      command,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }

    // Register with the plugin command system (validates name and checks for duplicates)
    const result = registerPluginCommand(record.id, command, {
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: ${result.error}`,
      });
      return;
    }

    record.commands.push(name);
    registry.commands.push({
      pluginId: record.id,
      pluginName: record.name,
      command,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
    policy?: PluginTypedHookPolicy,
  ) => {
    const normalized = resolveExtensionTypedHookRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      hookName,
      handler,
      priority: opts?.priority,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }
    let effectiveHandler = normalized.entry.handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(normalized.hookName)) {
      if (normalized.hookName === "before_prompt_build") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${normalized.hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        return;
      }
      if (normalized.hookName === "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${normalized.hookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        effectiveHandler = constrainLegacyPromptInjectionHook(
          handler as PluginHookHandlerMap["before_agent_start"],
        ) as PluginHookHandlerMap[K];
      }
    }
    addExtensionTypedHookRegistration({
      registry,
      record,
      entry: {
        ...normalized.entry,
        pluginId: record.id,
        hookName: normalized.hookName,
        handler: effectiveHandler,
      } as TypedPluginHookRegistration,
    });
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
    },
  ): OpenClawPluginApi => {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: registryParams.runtime,
      logger: normalizeLogger(registryParams.logger),
      registerTool: (tool, opts) => registerTool(record, tool, opts),
      registerHook: (events, handler, opts) =>
        registerHook(record, events, handler, opts, params.config),
      registerHttpRoute: (params) => registerHttpRoute(record, params),
      registerChannel: (registration) => registerChannel(record, registration),
      registerProvider: (provider) => registerProvider(record, provider),
      registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerService: (service) => registerService(record, service),
      registerInteractiveHandler: (registration) => {
        const result = registerPluginInteractiveHandler(record.id, registration, {
          pluginName: record.name,
          pluginRoot: record.rootDir,
        });
        if (!result.ok) {
          pushDiagnostic({
            level: "warn",
            pluginId: record.id,
            source: record.source,
            message: result.error ?? "interactive handler registration failed",
          });
        }
      },
      registerCommand: (command) => registerCommand(record, command),
      registerContextEngine: (id, factory) => {
        if (id === defaultSlotIdForKey("contextEngine")) {
          pushDiagnostic({
            level: "error",
            pluginId: record.id,
            source: record.source,
            message: `context engine id reserved by core: ${id}`,
          });
          return;
        }
        const result = registerContextEngineForOwner(id, factory, `plugin:${record.id}`, {
          allowSameOwnerRefresh: true,
        });
        if (!result.ok) {
          pushDiagnostic({
            level: "error",
            pluginId: record.id,
            source: record.source,
            message: `context engine already registered: ${id} (${result.existingOwner})`,
          });
        }
      },
      resolvePath: (input: string) => resolveUserPath(input),
      on: (hookName, handler, opts) =>
        registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
    };
  };

  return {
    registry,
    createApi,
    pushDiagnostic,
    registerTool,
    registerChannel,
    registerProvider,
    registerGatewayMethod,
    registerCli,
    registerService,
    registerCommand,
    registerHook,
    registerTypedHook,
  };
}
