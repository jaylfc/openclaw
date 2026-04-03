import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelsJsonProvidersCacheForTest } from "./model.js";

// Mock pi-model-discovery to avoid pulling in the full PI SDK dependency chain.
vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: vi.fn(() => undefined),
  loadOpenRouterModelCapabilities: vi.fn(async () => {}),
}));

import { discoverModels } from "../pi-model-discovery.js";
import { resolveModel } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { resetMockDiscoverModels } from "./model.test-harness.js";

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: [],
  });
}

function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir: string,
  cfg?: Parameters<typeof resolveModel>[3],
) {
  return resolveModel(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, agentDir),
    runtimeHooks: createRuntimeHooks(),
  });
}

describe("models.json provider config fallback", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(path.join(tmpdir(), "openclaw-test-models-json-"));
    clearModelsJsonProvidersCacheForTest();
    resetMockDiscoverModels(discoverModels);
  });

  afterEach(() => {
    clearModelsJsonProvidersCacheForTest();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("resolves provider config from models.json when absent from user config", () => {
    const modelsJson = {
      providers: {
        kilocode: {
          baseUrl: "https://api.kilo.ai/api/gateway/",
          api: "openai-completions",
          models: [
            {
              id: "kilocode/anthropic/claude-3.7-sonnet",
              name: "Claude 3.7 Sonnet (Kilocode)",
              contextWindow: 200000,
              maxTokens: 8192,
              reasoning: false,
              input: ["text"],
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson));

    // No kilocode in user config — should fall back to models.json.
    const result = resolveModelForTest(
      "kilocode",
      "kilocode/anthropic/claude-3.7-sonnet",
      agentDir,
    );
    expect(result.model).toBeDefined();
    expect(result.model?.id).toBe("kilocode/anthropic/claude-3.7-sonnet");
    expect(result.model?.provider).toBe("kilocode");
  });

  it("prefers user config over models.json", () => {
    const modelsJson = {
      providers: {
        kilocode: {
          baseUrl: "https://api.kilo.ai/api/gateway/",
          api: "openai-completions",
          models: [
            {
              id: "model-a",
              name: "Model A",
              contextWindow: 8000,
              maxTokens: 4096,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson));

    const cfg = {
      models: {
        providers: {
          kilocode: {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions" as const,
            models: [
              {
                id: "model-a",
                name: "Model A Override",
                contextWindow: 16000,
                maxTokens: 8192,
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };

    const result = resolveModelForTest("kilocode", "model-a", agentDir, cfg);
    expect(result.model).toBeDefined();
    // Should use user config baseUrl, not models.json.
    expect(result.model?.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("returns undefined when models.json does not exist", () => {
    // No models.json written — should gracefully return undefined (no model).
    const result = resolveModelForTest("kilocode", "kilocode/some-model", agentDir);
    expect(result.model).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it("returns undefined when models.json is malformed", () => {
    fs.writeFileSync(path.join(agentDir, "models.json"), "not-valid-json{{{");

    const result = resolveModelForTest("kilocode", "kilocode/some-model", agentDir);
    expect(result.model).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it("returns undefined when models.json has no providers key", () => {
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ other: "data" }));

    const result = resolveModelForTest("kilocode", "kilocode/some-model", agentDir);
    expect(result.model).toBeUndefined();
  });

  it("resolves normalized provider key from models.json", () => {
    // Write with a differently cased key.
    const modelsJson = {
      providers: {
        Kilocode: {
          baseUrl: "https://api.kilo.ai/api/gateway/",
          api: "openai-completions",
          models: [
            {
              id: "test-model",
              name: "Test",
              contextWindow: 8000,
              maxTokens: 4096,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson));

    const result = resolveModelForTest("kilocode", "test-model", agentDir);
    expect(result.model).toBeDefined();
    expect(result.model?.id).toBe("test-model");
  });

  it("caches models.json reads across multiple resolution calls", () => {
    const modelsJson = {
      providers: {
        kilocode: {
          baseUrl: "https://api.kilo.ai/api/gateway/",
          api: "openai-completions",
          models: [
            {
              id: "model-a",
              name: "A",
              contextWindow: 8000,
              maxTokens: 4096,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson));

    const readSpy = vi.spyOn(fs, "readFileSync");

    // Call twice — second call should use cache.
    resolveModelForTest("kilocode", "model-a", agentDir);
    resolveModelForTest("kilocode", "model-a", agentDir);

    const modelsJsonReads = readSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].endsWith("models.json"),
    );
    expect(modelsJsonReads.length).toBe(1);

    readSpy.mockRestore();
  });
});
