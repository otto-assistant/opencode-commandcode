<p align="center">
  <img src="docs/header.svg" width="828" alt="opencode-commandcode — Command Code in OpenCode, Laguna S 2.1 gateway">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@otto-assistant/opencode-commandcode"><img src="https://img.shields.io/npm/v/%40otto-assistant%2Fopencode-commandcode?style=flat-square&color=7dcea0&labelColor=0c1412&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7dcea0?style=flat-square&labelColor=0c1412" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/linux%20·%20macos%20·%20windows-7dcea0?style=flat-square&labelColor=0c1412" alt="linux, macos, windows">
</p>

<p align="center">
  <strong>Command Code inside OpenCode</strong> — Go-plan ($1) browser login,<br>
  gateway proxy, free Laguna S 2.1, tools/MCP, attachments, compact, usage.
</p>

---

Run [Command Code](https://commandcode.ai) models from OpenCode by proxying the same gateway that `npm i -g command-code@latest` uses (`POST /alpha/generate`). Default and exclusive live-test target: **Laguna S 2.1 free** (`poolside/laguna-s-2.1-free`, 256k context, $0).

Plugin shape mirrors [@otto-assistant/opencode-claude](https://github.com/otto-assistant/opencode-claude) and [@otto-assistant/opencode-cursor](https://github.com/otto-assistant/opencode-cursor).

## Install

```bash
# global (recommended)
opencode plugin @otto-assistant/opencode-commandcode -g

# or project-local
opencode plugin @otto-assistant/opencode-commandcode
```

Optional provider naming:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-commandcode"],
  "provider": {
    "command-code": { "name": "Command Code" }
  }
}
```

From source:

```bash
git clone https://github.com/otto-assistant/opencode-commandcode.git
cd opencode-commandcode
bun install && bun run build
opencode plugin file://$PWD
```

## Authenticate

Uses the **Command Code Go plan ($1/mo)** — same browser login as `cmd login`. No Studio API key.

```bash
npm i -g command-code@latest
cmd login   # browser → Studio CLI auth (Go plan). Laguna S 2.1 is $0 credits.

opencode auth login --provider command-code
# pick "Login with Command Code (Go $1)"  — or "Use existing cmd login session"
```

Then:

```bash
opencode run "Summarise this repository in five bullets." --model command-code/laguna-s-2.1-free
```

Laguna S 2.1 free requires an active Go (or higher) account with credits on file; requests on that model still bill **$0**.

## Why this plugin

| | |
|---|---|
| **Gateway proxy** | Talks to `api.commandcode.ai/alpha/generate` — same transport as the `cmd` CLI. |
| **Laguna S 2.1 free** | 256k context, reasoning, $0 while the deal lasts. |
| **Go-plan auth** | Browser OAuth like `cmd login` ($1/mo). Syncs `~/.commandcode/auth.json`. No API key. |
| **Agent-grade tools** | OpenCode tool calls park and resume; MCP-prefixed tools are tracked separately. |
| **Attachments** | Images, PDFs, text/binary files from OpenCode. Text-only models get image placeholders (Command Code behavior). |
| **Compact** | Context-fraction tips + tiered client compact before the 256k window overflows. |
| **Usage** | Per-turn and session totals via SSE `usage` + `GET /v1/usage`. |

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy (dynamic port, prefer 8797)
            └─ POST https://api.commandcode.ai/alpha/generate
                 └─ poolside/laguna-s-2.1-free (default)
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Command Code CLI](https://www.npmjs.com/package/command-code) (`npm i -g command-code@latest`) and a free account
- Bun (plugin runtime) · Node.js ≥ 18 (CLI needs ≥ 22)

## Development

```bash
bun install
bun run build
bun run test          # mocked gateway — attachments, tools, compact, usage
bun run test:live     # live Laguna S 2.1 (needs `cmd login` / Go plan session)
```

Debug: `OPENCODE_COMMANDCODE_DEBUG=1`.

Optional knobs:

- `OPENCODE_COMMANDCODE_PROXY_PORT` — pin a fixed local proxy port (otherwise dynamic: prefer `8797`, then scan upward / ephemeral)
- `OPENCODE_COMMANDCODE_CWD` — working directory reported to the gateway
- `COMMANDCODE_API_URL` — override API base (default `https://api.commandcode.ai`)

## License

[MIT](LICENSE)
