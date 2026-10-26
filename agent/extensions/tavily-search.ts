/**
 * Web search routing: native OpenAI search for ChatGPT subscriptions,
 * and the `tavily_search` tool for other model connections.
 *
 * API key is stored in ~/.pi/agent/.env:
 *   TAVILY_API_KEY=tvly-...
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAVILY_API_URL = "https://api.tavily.com/search";

function loadApiKey(): string | undefined {
  try {
    const envPath = join(
      process.env.HOME ?? "~",
      ".pi",
      "agent",
      ".env",
    );
    const envRaw = readFileSync(envPath, "utf-8");

    for (const line of envRaw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key === "TAVILY_API_KEY") {
        return value;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

const tavilySearchTool = defineTool({
  name: "tavily_search",
  label: "Web Search",
  description:
    "Search the web for current information using the Tavily search API. Returns relevant web pages with titles, URLs, and content snippets.",
  promptSnippet: "Search the web for current information on any topic",
  promptGuidelines: [
    "Use tavily_search when you need up-to-date information from the web that is not in your training data.",
    "Use tavily_search when the user asks about recent events, news, or current state of something.",
    "Use tavily_search when you need to verify facts or find specific documentation online.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "The search query" }),
    max_results: Type.Optional(
      Type.Number({
        description: "Maximum number of results to return (1-20, default 5)",
        minimum: 1,
        maximum: 20,
      }),
    ),
    search_depth: Type.Optional(
      Type.String({
        description:
          '"basic" for fast results or "advanced" for deeper, more thorough search (default "basic")',
      }),
    ),
    include_raw_content: Type.Optional(
      Type.Boolean({
        description:
          "If true, includes the full raw text of each page (default false)",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const apiKey = loadApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No API key found. Add to ~/.pi/agent/extensions/.env: TAVILY_API_KEY=tvly-...",
          },
        ],
        isError: true,
        details: {},
      };
    }

    const body: Record<string, unknown> = {
      api_key: apiKey,
      query: params.query,
      max_results: params.max_results ?? 5,
      search_depth: params.search_depth ?? "basic",
      include_raw_content: params.include_raw_content ?? false,
    };

    try {
      const response = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text",
              text: `Tavily API error (${response.status}): ${errorText}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const data = (await response.json()) as {
        results?: Array<{
          title: string;
          url: string;
          content: string;
          score?: number;
          published_date?: string;
        }>;
      };

      // Format results
      const parts: string[] = [];

      if (data.results && data.results.length > 0) {
        parts.push(`## Results (${data.results.length})\n`);
        for (const [i, r] of data.results.entries()) {
          const parts2: string[] = [];
          parts2.push(`### ${i + 1}. ${r.title}`);
          parts2.push(`URL: ${r.url}`);
          if (r.score !== undefined) {
            parts2.push(`Relevance: ${(r.score * 100).toFixed(0)}%`);
          }
          if (r.published_date) {
            parts2.push(`Published: ${r.published_date}`);
          }
          parts2.push(`\n${r.content}`);
          parts.push(parts2.join("\n"));
        }
      } else {
        parts.push("No results found.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          query: params.query,
          resultCount: data.results?.length ?? 0,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error calling Tavily API: ${msg}`,
          },
        ],
        isError: true,
        details: {},
      };
    }
  },
});

function usesNativeSearch(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model || !["openai", "openai-codex"].includes(model.provider)) return false;
  if (!ctx.modelRegistry.isUsingOAuth(model)) return false;

  // Only enable hosted search on official OpenAI endpoints.
  try {
    const url = new URL(model.baseUrl);
    if (url.protocol !== "https:") return false;
    return (
      (model.api === "openai-responses" && url.hostname === "api.openai.com") ||
      (model.api === "openai-codex-responses" && url.hostname === "chatgpt.com" &&
        /^\/backend-api(?:\/codex(?:\/responses)?)?\/?$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(tavilySearchTool);

  let nativeSearch = false;
  let restoreTavily = false;
  const sources = new Map<string, string>();
  const citations = new Map<string, string>();
  const clearSources = () => { sources.clear(); citations.clear(); };

  function syncSearch(ctx: ExtensionContext) {
    const enabled = usesNativeSearch(ctx);
    if (enabled === nativeSearch) return;
    nativeSearch = enabled;
    clearSources();

    if (enabled) {
      restoreTavily = pi.getActiveTools().includes("tavily_search");
      // Inactive tools can still be called by codemode. Hidden tools cannot.
      pi.registerTool({ ...tavilySearchTool, exposure: "hidden" });
    } else {
      pi.registerTool(tavilySearchTool);
      if (!restoreTavily) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "tavily_search"));
      }
    }
  }

  pi.on("session_start", (_event, ctx) => syncSearch(ctx));
  pi.on("model_select", (_event, ctx) => syncSearch(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    syncSearch(ctx);
    if (!nativeSearch) return;
    event.systemPromptOptions.promptGuidelines.push(
      "Use the native OpenAI web_search tool for current facts, news, and documentation checks. " +
      "It runs on OpenAI's servers. Call it directly, not through codemode. " +
      "Cite source URLs. Do not use Tavily while native search is enabled.",
    );
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!usesNativeSearch(ctx) || !isRecord(event.payload)) return;
    const payload = event.payload;
    // Ignore auxiliary requests for a different model.
    if (payload.model !== ctx.model?.id) return;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const hasSearch = tools.some((tool) =>
      isRecord(tool) && ["web_search", "web_search_preview"].includes(String(tool.type)),
    );
    const include = Array.isArray(payload.include) ? payload.include : [];
    return {
      ...payload,
      tools: hasSearch ? tools : [...tools, { type: "web_search", external_web_access: true }],
      include: [...new Set([...include, "web_search_call.action.sources"])],
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "tavily_search" && usesNativeSearch(ctx)) {
      return { block: true, reason: "Use native OpenAI web_search for this ChatGPT subscription model." };
    }
  });

  // Pi normalizes text, but does not retain hosted-search citation annotations.
  // Collect only public source links, never full provider responses or credentials.
  function addSource(value: unknown, target = sources) {
    if (!isRecord(value) || typeof value.url !== "string" || target.size >= 50) return;
    try {
      const url = new URL(value.url);
      if (!["http:", "https:"].includes(url.protocol)) return;
      const title = typeof value.title === "string" ? value.title : url.hostname;
      target.set(url.href, title.replace(/[\r\n\[\]\\]/g, " ").trim() || url.hostname);
    } catch { /* Ignore malformed source URLs. */ }
  }

  function collectItem(item: unknown) {
    if (!isRecord(item)) return;
    if (item.type === "web_search_call" && isRecord(item.action) && Array.isArray(item.action.sources)) {
      item.action.sources.forEach((source) => addSource(source));
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && Array.isArray(part.annotations)) {
          part.annotations.forEach((annotation) => addSource(annotation, citations));
        }
      }
    }
  }

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") clearSources();
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (!nativeSearch || !usesNativeSearch(ctx) || event.provider !== ctx.model?.provider ||
        event.model !== ctx.model?.id || !isRecord(event.data)) return;
    const data = event.data;
    if (data.type === "response.output_text.annotation.added") addSource(data.annotation, citations);
    if (data.type === "response.output_item.done") collectItem(data.item);
    if (data.type === "response.completed" && isRecord(data.response) && Array.isArray(data.response.output)) {
      data.response.output.forEach(collectItem);
    }
  });
  pi.on("message_end", (event) => {
    if (!nativeSearch || event.message.role !== "assistant" || (sources.size === 0 && citations.size === 0)) return;
    if (["error", "aborted"].includes(event.message.stopReason)) {
      clearSources();
      return;
    }
    // Prefer cited pages. Consulted pages are only a fallback, not a long results dump.
    const links = [...(citations.size ? citations : sources)].slice(0, 10).map(([url, title]) =>
      `- [${title}](<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`,
    );
    clearSources();
    return {
      message: {
        ...event.message,
        content: [...event.message.content, {
          type: "text" as const,
          text: `\n\n### Web search sources\n${links.join("\n")}`,
        }],
      },
    };
  });
}
