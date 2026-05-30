# pi-agentic-search

A [pi](https://pi.dev) extension that provides a deep research agent that autonomously searches, fetches, and synthesizes web information.

Unlike the primitive `search` and `fetch` tools — which return raw results — this agent reasons across multiple sources, follows leads, resolves conflicts, and returns a structured Research Summary. Use when the topic requires depth, cross-referencing, or synthesis beyond a single query.

## Installation

### Via `pi install` (recommended)

```bash
pi install git:github.com/jandrikus/pi-agentic-search
```

### Manual

```bash
# Global (available in all projects)
cp -r pi-agentic-search ~/.pi/agent/extensions/

# Or symlink
ln -sf /path/to/pi-agentic-search ~/.pi/agent/extensions/pi-agentic-search
```

### Project-local

```bash
cp -r pi-agentic-search .pi/extensions/
```

## Usage

Research is automatically available after installation. Use it for complex topics requiring synthesis:

```
Use agentic_search to research current best practices for rate limiting in distributed APIs
```

```
Research the tradeoffs between different database migration strategies
```

Or with parameters directly:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `goal` | Yes | The research question — be specific and outcome-oriented |
| `context` | Yes | Background that helps focus: what's known, what angle matters, what to prioritize |

## When to Use

| Use `agentic_search` | Use `search` + `fetch` directly |
|----------------------|--------------------------------|
| Comparing technologies or approaches | Simple factual lookup |
| Understanding trends across sources | Looking up a specific URL |
| Resolving conflicting information | Checking documentation |
| Producing a structured summary | Quick reference check |
| Following chains of references | Single-source answer |

## How It Works

1. Research agent spawns a **background pi process** with `search` and `fetch` tools
2. A **live progress widget** shows real-time search queries, fetched URLs, and cost
3. When finished, a **comprehensive Research Summary** is delivered as a follow-up message

The agent uses a cheap model to minimize cost — run it freely for any non-trivial research.

## Features

- **Autonomous research** — Searches, fetches, reads full sources, and synthesizes
- **Live progress widget** — See queries, fetches, token usage, and cost in real time
- **Auto-retry on transient errors** — Transparently retries on 429, 5xx, and network errors
- **Customizable system prompt** — Edit via config files that survive updates
- **Long task support** — Large prompts are automatically written to temp files

## Configuration

### Settings

Extension settings live in `settings.json`:

- **Project-local**: `.pi/config/pi-agentic-search/settings.json`
- **Global**: `~/.pi/config/pi-agentic-search/settings.json`

```json
{
  "model": "claude-haiku-4-5"
}
```

Leave `model` empty or remove it to use pi's default model.

### System Prompt Customization

Three files in the config directory let you customize the research agent's behavior:

| File | Purpose | Survives Updates |
|------|---------|------------------|
| `prepend-system-prompt.md` | Added before the default prompt | ✅ |
| `append-system-prompt.md` | Added after the default prompt | ✅ |
| `replace-system-prompt.md` | Replaces the default prompt entirely | ✅ |

Lines starting with `#` are treated as comments and ignored.

**Priority**: If `replace-system-prompt.md` has non-comment content, it is used entirely. Otherwise, prepend + default + append are combined.

## Security

- Research agent is **read-only** by design — it can only search and fetch
- It only has access to: `search`, `fetch`
- Uses `--no-skills` to prevent skill interference
- Runs with `--no-session` so it doesn't persist state

## License

Apache-2.0
