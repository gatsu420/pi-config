/**
 * Tavily Web Search Extension
 *
 * Registers a `tavily_search` tool that searches the web via the Tavily API.
 *
 * API key is stored in ~/.pi/agent/.env:
 *   TAVILY_API_KEY=tvly-...
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.registerTool(tavilySearchTool);
}
