import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";

// Use the installed Pi SDK. No test dependencies or real credentials are needed.
const sdkRoot = process.env.PI_PACKAGE_DIR;
if (!sdkRoot) throw new Error("Set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent directory.");
const sdkEntry = pathToFileURL(join(sdkRoot, "dist/index.js"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkEntry);
const require = createRequire(sdkEntry);
const aiRoot = require.resolve.paths("@earendil-works/pi-ai")
  .map((dir) => join(dir, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
assert.ok(aiRoot, "Pi's pi-ai dependency must be installed");
const { InMemoryCredentialStore } = await import(pathToFileURL(aiRoot));
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/tavily-search.ts");

function responseStream(withSearch) {
  const citation = { type: "url_citation", url: "https://example.com/release", title: "Release [notes]", start_index: 0, end_index: 7 };
  const search = { id: "ws_1", type: "web_search_call", status: "completed", action: {
    type: "search", query: "release", sources: [citation, { url: "javascript:alert(1)" }],
  } };
  const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [
    { type: "output_text", text: "Release found.", annotations: withSearch ? [citation] : [] },
  ] };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    ...(withSearch ? [{ type: "response.output_item.done", output_index: 0, item: search }] : []),
    { type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Release found." },
    ...(withSearch ? [{ type: "response.output_text.annotation.added", output_index: 1, annotation: citation }] : []),
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response: {
      id: "resp_1", status: "completed", output: withSearch ? [search, item] : [item],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function setup({ live = false, excludeTools, provider = "openai" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-integration-"));
  const credentials = new InMemoryCredentialStore();
  if (!live) {
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
    await credentials.modify(provider, async () => ({
      type: "oauth", access: `fixture.${claims}.fixture`, refresh: "fixture", clientId: "fixture",
      expires: Date.now() + 86_400_000, scopes: ["chatgpt.tokens.use.direct"],
    }));
  }
  const runtime = await ModelRuntime.create(live ? {
    // Live mode delegates auth to Pi. Never read or print tokens in this test.
    modelsPath: null, allowModelNetwork: false,
  } : { credentials, modelsPath: null, allowModelNetwork: false });
  const model = provider === "openai" ?
    runtime.getModel(provider, process.env.PI_WEB_SEARCH_MODEL ?? "gpt-6.1-sol") : runtime.getModels(provider)[0];
  assert.ok(model, "Configured OpenAI test model must exist");
  if (live) assert.equal(runtime.isUsingOAuth("openai"), true, "Live test requires ChatGPT sign-in, not an API key");
  let pi;
  let injectDuplicate = false;
  let searches = 0;
  const errors = [];
  const settings = SettingsManager.inMemory({
    defaultTools: [], transport: "sse", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
    // Run the fixture hook first, as if an earlier extension enabled search.
    extensionsOverride: (base) => ({ ...base, extensions: [...base.extensions].reverse() }),
    extensionFactories: [(api) => {
      pi = api;
      api.on("before_provider_request", (event) => {
        if (injectDuplicate) return {
          ...event.payload,
          tools: [...(event.payload.tools ?? []), { type: "web_search" }],
          include: [...(event.payload.include ?? []), "web_search_call.action.sources"],
        };
      });
      api.on("provider_stream_event", (event) => {
        if (event.data.type === "response.output_item.done" && event.data.item?.type === "web_search_call") searches++;
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, model, thinkingLevel: "low",
    resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), excludeTools,
  });
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  return { session, runtime, model, errors, get pi() { return pi; },
    duplicate() { injectDuplicate = true; }, get searches() { return searches; },
    async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

// Runs the actual extension, session lifecycle, OpenAI request serializer and SSE parser.
// Only HTTP is replaced. Unexpected network calls fail, including calls to Tavily.
test("subscription search and provider switching through the Pi SDK", async () => {
  const originalFetch = globalThis.fetch;
  const originalOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const requests = [];
  let withSearch = true;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/responses"), `Unexpected HTTP endpoint: ${url}`);
    requests.push(JSON.parse(options.body));
    return responseStream(withSearch);
  };
  let env;
  try {
    env = await setup();
    const { session, model } = env;
    const exposure = () => env.pi.getAllTools().find((tool) => tool.name === "tavily_search")?.exposure;
    assert.equal(exposure(), "hidden");
    await session.prompt("Search for release notes.");
    assert.equal(requests.at(-1).tools.filter((tool) => tool.type === "web_search").length, 1);
    assert.equal(requests.at(-1).tools.find((tool) => tool.type === "web_search").external_web_access, true);
    assert.ok(requests.at(-1).include.includes("web_search_call.action.sources"));
    assert.ok(requests.at(-1).include.includes("reasoning.encrypted_content"));
    assert.ok(!JSON.stringify(requests.at(-1).tools).includes("tavily_search"));
    assert.match(JSON.stringify(requests.at(-1)), /native OpenAI web_search/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Use tavily_search/);
    const answer = session.getLastAssistantText();
    assert.match(answer, /Web search sources/);
    assert.equal(answer.split("https://example.com/release").length - 1, 1, "Deduplicate source URLs");
    assert.doesNotMatch(answer, /javascript:/);
    assert.doesNotMatch(answer, /\[Release \[notes\]\]/);
    assert.ok(env.searches > 0);

    withSearch = false;
    await session.prompt("Say hello without searching.");
    assert.doesNotMatch(session.getLastAssistantText(), /Web search sources/, "Do not leak citations between messages");

    env.duplicate();
    await session.prompt("Say hello again.");
    assert.equal(requests.at(-1).tools.filter((tool) => tool.type === "web_search").length, 1);
    assert.equal(requests.at(-1).include.filter((item) => item === "web_search_call.action.sources").length, 1);
    // End the duplicate-injection session before checking other providers.
    await env.close();
    env = await setup();
    await env.runtime.setRuntimeApiKey("openai", "sk-integration-only");
    await env.session.prompt("API-key mode.");
    assert.ok(!requests.at(-1).tools.some((tool) => tool.type === "web_search"));
    assert.ok(JSON.stringify(requests.at(-1).tools).includes("tavily_search"));
    assert.match(env.session.systemPrompt, /Use tavily_search/);
    assert.doesNotMatch(env.session.systemPrompt, /native OpenAI web_search/);
    assert.deepEqual(env.errors, []);

    await env.runtime.removeRuntimeApiKey("openai");
    await env.session.prompt("Subscription mode again.");
    assert.ok(requests.at(-1).tools.some((tool) => tool.type === "web_search"));
    assert.equal(env.pi.getAllTools().find((tool) => tool.name === "tavily_search").exposure, "hidden");

    env.runtime.registerProvider("search-integration-other", {
      api: "openai-responses", baseUrl: "https://example.test/v1", apiKey: "sk-integration-only",
      models: [{ ...model, id: "other-model", name: "Other integration model" }],
    });
    await env.session.setModel(env.runtime.getModel("search-integration-other", "other-model"));
    await env.session.prompt("Other provider mode.");
    assert.ok(JSON.stringify(requests.at(-1).tools).includes("tavily_search"));
    assert.ok(!requests.at(-1).tools.some((tool) => tool.type === "web_search"));
    await env.session.setModel(env.model);
    await env.session.prompt("Back to ChatGPT.");
    assert.ok(requests.at(-1).tools.some((tool) => tool.type === "web_search"));
    assert.deepEqual(env.errors, []);
  } finally {
    if (env) await env.close();
    globalThis.fetch = originalFetch;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
  }
});

test("legacy Codex subscription uses native search through the real SSE adapter", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
    const body = typeof options.body === "string" ? options.body : zstdDecompressSync(options.body).toString();
    request = JSON.parse(body);
    return responseStream(true);
  };
  let env;
  try {
    env = await setup({ provider: "openai-codex" });
    await env.session.prompt("Search for release notes.");
    const last = env.session.messages.filter((message) => message.role === "assistant").at(-1);
    assert.equal(last.stopReason, "stop", last.errorMessage);
    assert.ok(request.tools.some((tool) => tool.type === "web_search"));
    assert.ok(!JSON.stringify(request.tools).includes("tavily_search"));
    assert.match(env.session.getLastAssistantText(), /Web search sources/);
    assert.ok(env.searches > 0);
    assert.deepEqual(env.errors, []);
  } finally {
    if (env) await env.close();
    globalThis.fetch = originalFetch;
  }
});

test("explicit Tavily exclusion survives a switch away from subscription auth", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return responseStream(false);
  };
  let env;
  try {
    env = await setup({ excludeTools: ["tavily_search"] });
    await env.runtime.setRuntimeApiKey("openai", "sk-integration-only");
    await env.session.prompt("No search tools, please.");
    assert.ok(!JSON.stringify(request.tools ?? []).includes("tavily_search"));
    assert.ok(!(request.tools ?? []).some((tool) => tool.type === "web_search"));
    assert.deepEqual(env.errors, []);
  } finally {
    if (env) await env.close();
    globalThis.fetch = originalFetch;
  }
});

test("third-party OpenAI gateway does not receive the native hosted tool", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://gateway.example.test/v1/responses");
    request = JSON.parse(options.body);
    return responseStream(false);
  };
  let env;
  try {
    env = await setup();
    env.runtime.registerProvider("openai", { baseUrl: "https://gateway.example.test/v1" });
    await env.session.setModel(env.runtime.getModel("openai", env.model.id));
    await env.session.prompt("Gateway mode.");
    assert.ok(!request.tools.some((tool) => tool.type === "web_search"));
    assert.ok(JSON.stringify(request.tools).includes("tavily_search"));
    assert.deepEqual(env.errors, []);
  } finally {
    if (env) await env.close();
    globalThis.fetch = originalFetch;
  }
});

test("one live native search using ChatGPT sign-in", { skip: process.env.PI_WEB_SEARCH_LIVE !== "1", timeout: 180_000 }, async () => {
  const env = await setup({ live: true });
  try {
    await env.session.prompt(
      "Use your native web_search once to find the official Node.js releases page. " +
      "Return its URL and one short sentence. Do not use any other tool."
    );
    const last = env.session.messages.filter((message) => message.role === "assistant").at(-1);
    assert.equal(last.stopReason, "stop", last.errorMessage);
    assert.ok(env.searches > 0, "Must observe an actual hosted web_search_call, not just a claimed search");
    assert.match(env.session.getLastAssistantText(), /https:\/\//);
    assert.match(env.session.getLastAssistantText(), /Web search sources/);
    assert.deepEqual(env.errors, []);
    console.log(`Live native search verified: ${env.searches} hosted search call(s).`);
    console.log(env.session.getLastAssistantText());
  } finally {
    await env.close();
  }
});
