# Web search integration tests

`../extensions/tavily-search.ts` selects search by the active connection:

- ChatGPT sign-in on the official OpenAI Responses or legacy Codex endpoint: native `web_search`. Tavily is hidden, including from codemode.
- API keys, other providers, and third-party gateways: Tavily keeps its previous enabled or disabled state.
- Search is available to the model, not forced on every message. Native search runs on OpenAI's servers. It cannot be called through `tools.web_search()` in codemode.
- Cited source links are kept in the final message. Consulted pages are a fallback when citations are absent.
- A native-search failure does not silently fall back to Tavily.

Use `/reload` in Pi after changing the extension.

## Offline checks

Set `PI_PACKAGE_DIR` to the directory of your installed `@earendil-works/pi-coding-agent` package. It must contain `dist/index.js` and its installed dependencies.

From the repository root:

```sh
export PI_PACKAGE_DIR="/path/to/node_modules/@earendil-works/pi-coding-agent"
PI_OFFLINE=1 node --test agent/tests/web-search.integration.test.mjs
```

These tests use the real Pi SDK, extension loader, request serializers, and SSE parsers. HTTP is replaced with fixtures. Credentials are fake and in memory. No Tavily requests or real model calls occur.

Coverage includes native-tool injection, preserved request fields, duplicate tools, citation handling, per-message source isolation, API-key authentication, provider switching, legacy Codex, third-party gateways, and explicit tool exclusions.

## Optional live check

This check uses your existing Pi ChatGPT sign-in and subscription allowance. It does not print credentials. It verifies an actual hosted `web_search_call`, not just a model's claim that it searched.

```sh
PI_OFFLINE=1 PI_WEB_SEARCH_LIVE=1 node --test \
  --test-name-pattern='one live native search' \
  agent/tests/web-search.integration.test.mjs
```

`PI_OFFLINE=1` prevents automatic catalog network activity. It does not block the requested model call. The live check defaults to `openai/gpt-6.1-sol`; set `PI_WEB_SEARCH_MODEL` to another available OpenAI model ID if needed. The test asks for one search, but the model can make more than one hosted search call.
