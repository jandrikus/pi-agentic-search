# pi-agentic-search

A [pi](https://pi.dev) extension that provides a deep research agent that autonomously searches, fetches, and synthesizes web information.

Unlike the primitive `search` and `fetch` tools — which return raw results — this agent reasons across multiple sources, follows leads, resolves conflicts, and returns a structured Research Summary. Use when the topic requires depth, cross-referencing, or synthesis beyond a single query.

## Prerequisites

This extension requires [`pi-search-tool`](https://github.com/jandrikus/pi-search-tool) which provides the `search` and `fetch` tools. The extension loads it automatically at runtime, but you need the underlying [`search-headless`](https://github.com/jandrikus/search-headless) installed on your machine.

### Install search-headless

```bash
# Clone and install
git clone git@github.com:jandrikus/search-headless.git ~/dev/search-headless
cd ~/dev/search-headless
./install.sh
```

Verify it works:

```bash
search-web "test query" --limit 3
fetch-content https://example.com --max-chars 500
```

## Installation

```bash
pi install npm:pi-agentic-search
```

This installs the extension and adds it to your settings automatically.

## Usage

The research agent is automatically available after installation. Use it for complex topics requiring synthesis:

```
Research the current best practices for rate limiting in distributed APIs
```

```
Compare the approaches of different database migration tools
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

1. Research agent spawns a **background pi process** with `search` and `fetch` tools (from `pi-search-tool`)
2. A **live progress widget** shows real-time search queries, fetched URLs, and cost
3. When finished, a **comprehensive Research Summary** is delivered as a follow-up message

The agent uses a cheap model to minimize cost — run it freely for any non-trivial research.

## Features

- **Autonomous research** — Searches, fetches, reads full sources, and synthesizes
- **Live progress widget** — See queries, fetches, token usage, and cost in real time
- **Agent control panel** — `Ctrl+Shift+2` to stop, cancel, or retry running agents
- **Auto-retry on transient errors** — Transparently retries on 429, 5xx, and network errors
- **Customizable system prompt** — Edit via config files that survive updates
- **Activity timeout** — Detects stuck processes (2 min) and marks as "probably failed"

## Agent Control Panel

Press `Ctrl+Shift+2` to open the control panel. From there you can:

| Key | Action | Effect |
|-----|--------|--------|
| `S` | Stop | Pauses agent, keeps widget visible, no LLM feedback |
| `C` | Cancel | Kills agent, sends "canceled by user" to LLM, removes widget |
| `R` | Retry | Restarts agent fresh, reuses same widget |
| `A` | Stop All | Stops all running agents |
| `Esc` | Close | Closes the control panel |

## Configuration

### Settings

Extension settings live in `settings.json`:

- **Global**: `~/.pi/config/pi-agentic-search/settings.json`

```json
{
  "model": "xiaomi-token-plan-ams/mimo-v2.5",
  "keybinding": 2
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `model` | *(empty)* | Model to use (empty = pi's default) |
| `keybinding` | `2` | Number key for control panel (`Ctrl+Shift+N`) |

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
