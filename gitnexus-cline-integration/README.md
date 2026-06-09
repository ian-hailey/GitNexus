# GitNexus — Cline integration

Static config that adds GitNexus knowledge-graph augmentation and skill files to Cline (CLI and VSCode extension).

> **⚠️ Cline fork required:** Hook context injection is not yet supported in the official [cline repository](https://github.com/cline/cline). Use the [ian-hailey/cline fork](https://github.com/ian-hailey/cline/tree/hook-context-injection) which enables file-based hooks to inject context into the next model call.

> **Hooks require Cline 3.0+.** Earlier versions may not support all hook events.

## What you get

| Layer                     | What it does                                                                                                                              | How it's installed                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Skills**                | `/gitnexus-exploring`, `/gitnexus-debugging`, `/gitnexus-impact-analysis`, `/gitnexus-pr-review` markdown skills | Copy skill files to `~/.cline/skills/gitnexus/` — see [Skills](#skills) section. |
| **Hooks** (CLI only)      | `PostToolUse` hook that enriches `Grep` / `Glob` / `Bash` tool calls with graph context — same augmentation Claude Code gets | **Manual** — copy the files described below into your project's `.cline/`. |

## MCP setup (VSCode extension)

For the **Cline VSCode extension**, add GitNexus as an MCP server in your VSCode settings:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "/home/ihailey/.npm-global/bin/gitnexus",
      "args": ["mcp"]
    }
  }
}
```

This gives the VSCode extension access to GitNexus tools (`query`, `context`, `impact`, `detect_changes`, `rename`, …).

## Hook install

Cline reads hook files from `.cline/hooks/` in the project root (matching its standard hook system).

### Self-contained hook (single file)

The `PostToolUse.js` hook is fully self-contained (~560 lines) and includes all logic inline:
- Lock acquisition (prevents concurrent hook executions)
- DB lock detection (avoids conflicts with running GitNexus server)
- GitNexus invocation resolution (supports gitnexus, pnpm, npx)
- Pattern extraction and context augmentation

```text
<your-project>/
└── .cline/
    └── hooks/
        └── PostToolUse.js    ← from gitnexus-cline-integration/hooks/PostToolUse.js
```

```bash
mkdir -p .cline/hooks
cp "$GITNEXUS_REPO/gitnexus-cline-integration/hooks/PostToolUse.js" .cline/hooks/PostToolUse.js
```

For CLI global install, the same single file can be installed to `~/.cline/hooks/`.

### Verify

1. Index the project: `npx gitnexus analyze`
2. Run cline with a task that triggers `Grep` / `Glob` / `Bash`. You should see a `[GitNexus]` block appended to the tool result.
3. Diagnose silent no-ops by setting `GITNEXUS_DEBUG=1` in your shell environment.

## Hook contract

The Cline hook receives a JSON event on stdin matching Cline's hook event shape:

```json
{
  "hookName": "tool_result",
  "iteration": 1,
  "tool_result": {
    "id": "...",
    "name": "Grep" | "Glob" | "Bash",
    "input": { /* tool-specific */ },
    "output": "...",
    "error": null,
    "durationMs": 42,
    "startedAt": "...",
    "endedAt": "..."
  },
  "cwd": "/absolute/path/to/project"
}
```

It writes augmentation context to stdout as:

```json
{ "contextModification": "[GitNexus] …" }
```

### Pattern extraction per tool

| Tool    | Pattern source                                                                                                    | Notes                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Grep`  | `tool_input.pattern`                                                                                              | Direct pattern extraction.                                                           |
| `search_codebase` | `tool_input.queries[0]` (Cline CLI)                                                                 | First query from the queries array.                                                  |
| `Glob`  | basename of `tool_input.pattern` (e.g. "**\/foo.ts" → "foo")                                                     | Strips glob chars and extension.                                                      |
| `Bash`  | First positional argument after `rg` / `grep` in `tool_input.command`                                             | Best-effort tokenizer; quoted multi-word patterns extract the first word only.        |

## Troubleshooting

- **Nothing happens** — Use the [ian-hailey/cline fork](https://github.com/ian-hailey/cline/tree/hook-context-injection) which enables file-based hooks to inject context into the next model call. Official cline does not support this feature yet.
- **Cline version** — Confirm you have Cline 3.0+ and the project root has `.cline/hooks/PostToolUse.js`. Then `npx gitnexus list` to confirm the project is indexed.
- **`gitnexus` not found** — The hook falls back to `npx -y gitnexus`. Install globally with `npm i -g gitnexus` to skip the npx cold-start latency.
- **Wrong pattern extracted** — Set `GITNEXUS_DEBUG=1` and run a tool call. The raw stdin payload is logged to stderr.

## Skills

Copy skill files to your global cline skills directory:

```bash
mkdir -p ~/.cline/skills/gitnexus
cp -r "$GITNEXUS_REPO/gitnexus-cline-integration/skills/*" ~/.cline/skills/gitnexus/
```

Available skills:
- `/gitnexus-exploring` — Understand codebase architecture
- `/gitnexus-debugging` — Debug with graph context
- `/gitnexus-impact-analysis` — Analyze change blast radius
- `/gitnexus-pr-review` — Review pull requests efficiently