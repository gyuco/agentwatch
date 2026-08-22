# agentwatch

Live dashboard for **Claude Code**: in the folder where you run it, it reads the
project's `.claude/agents/` and `.claude/skills/`, installs non-blocking hooks,
and shows in real time what the **main agent** and every **subagent** are doing
— tool calls in flight, elapsed time, tasks, and **skill usage** — on a local
web dashboard over SSE.

Zero runtime dependencies. Node >= 18.17.

## Quickstart

```bash
# local development (from this repo)
npm link

# from anywhere
agentwatch            # or: npx agentwatch
```

It prints the hub URL and opens the browser on the projects page. New projects
can be created from the page, or registered without workflow onboarding from
the CLI:

```bash
agentwatch office add path/to/project --name acme
```

When a project is added, agentwatch writes hooks into that project's
`.claude/settings.local.json` (git-ignored by Claude Code). From then on, every
Claude Code session in that project feeds the dashboard — including sessions
started in a new terminal.

Projects created from the web page also get a generic, non-Scrum work-item
workflow: `agentwatch.tasks.json`, `.claude/agents/work-planner.md`,
`.claude/skills/work-items/SKILL.md`, and the configured task directories. If
the configuration already exists, the creation dialog requires an explicit
choice to edit it or overwrite it; existing planner/skill files are preserved.
The same dialog proposes a bundled setup catalog and lets you review every
agent, skill, MCP suggestion, and workflow before anything is installed.

## What you see

- **Catalog** (left): every agent (name, description, enabled tools) and every
  skill (SKILL.md frontmatter) found in `.claude/`.
- **Live cards** (top): the main agent + each running subagent, with ticking
  elapsed timer, the tool currently in flight, the last completed tool with
  duration, and the skills it has loaded.
- **Skills rail**: skills marked **in use** while a subagent is loading them,
  with a use counter.
- **Tasks**: live `TaskCreated` / `TaskCompleted` chips plus a read-only Markdown
  Kanban whose paths and status columns come from `agentwatch.tasks.json`.
- **Feed**: timestamped event timeline, filterable by main/subagents/skills/
  errors, searchable, per-agent on card click.

## Commands

| command | effect |
|---|---|
| `agentwatch` (or `serve`, or `hub`) | show the projects page and dashboards for registered projects |
| `agentwatch project` | scan, install hooks, start one project dashboard from the detected root |
| `agentwatch hub stop` | uninstall hooks from registered projects and stop the hub |
| `agentwatch hub status` | list registered projects and hub status |
| `agentwatch office add <path>` | register a project and install hooks |
| `agentwatch stop` | uninstall hooks and stop a single-project dashboard |
| `agentwatch status` | single-project root, catalog, running agents, port |
| `agentwatch hooks` | show hook events configured in the project |

Options: `--port N`, `--no-open`, `--no-hooks` (view only), `--project DIR`.

## Answering AskUserQuestion from the dashboard

When the model calls `AskUserQuestion` (or `Question`), the dashboard shows the
question with clickable options — plus a free-text field for a custom answer.
This works through a **synchronous** hook (`src/ask-hook.js`), installed
alongside the regular async ones, scoped via `matcher: "AskUserQuestion|Question"`
on `PreToolUse`:

1. The hook posts the question to the running dashboard (`POST /api/ask/create`)
   and polls `GET /api/ask/poll` for up to ~5 minutes. In hub mode the hook
   reaches the hub, which routes the question to the office that owns the
   project — the alert appears in that office's dashboard.
2. Picking an option in the dashboard calls `POST /api/ask/answer`.
3. The hook returns `permissionDecision: "allow"` with the original tool input
   plus the selected value in `updatedInput.answers`. Claude Code receives the
   same structured answer it would receive from its terminal prompt.
4. Questions containing multiple prompts or multi-select choices are left to
   the terminal because the dashboard currently presents one single-choice
   prompt at a time.
5. If the dashboard is closed or nobody answers before the timeout, the hook
   allows the call through unchanged, and the normal terminal prompt appears.

## How it works

1. The CLI installs **async command hooks** (`async: true`, never block the
   agent loop) in `.claude/settings.local.json` for: `SessionStart`,
   `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
   `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`,
   `SessionEnd`. It also installs one **synchronous** hook (`src/ask-hook.js`,
   no `async`), scoped to `AskUserQuestion`/`Question` on `PreToolUse`, so it
   can hold the tool call open while the dashboard collects an answer — see
   [Answering AskUserQuestion from the dashboard](#answering-askuserquestion-from-the-dashboard).
2. Each hook pipes the event JSON on stdin to `src/run-hook.js`, which appends
   it to `.agentwatch/events.ndjson` (local, instant, works even when the
   dashboard is down; capped at 4 MB and rotated).
3. The dashboard server (port 4579 by default) ingests the queue — including
   **retroactively on start**, so events from a session that ran before you
   opened the dashboard are shown — and streams them via SSE.
4. Tool events carry `agent_id`/`agent_type` for subagents; events without an
   id belong to the main agent. Skill loads are detected from `Skill` tool
   calls and highlighted as skill-in-use.

Hook installation never edits committed files: `.claude/settings.local.json`
is git-ignored and prior content is backed up to `.agentwatch/backups/`. The
optional web onboarding does create the versionable workflow, agent, and skill
files listed above.

## Work-item workflow

The board treats each Markdown file as a generic work item. Types and parent
relationships are optional; Scrum concepts are not assumed. A minimal config:

```json
{
  "version": 1,
  "paths": ["tasks"],
  "statuses": ["todo", "in-progress", "done"],
  "defaultStatus": "todo"
}
```

Status values are preserved and rendered as dynamic columns. Frontmatter may
add `type`, `parent`, `priority`, or `lane`. Projects created before this
feature remain readable through automatic discovery of `tasks`, `docs/tasks`,
and `docs/stories`.

## Onboarding catalog

Agentwatch ships a local, versioned catalog in `catalog/`. The first catalog
includes `Minimal` and `Development` packs, six agents, three skills, two
generic workflows, and a GitHub MCP suggestion. Recommendations are
deterministic: repositories with common software markers receive the
Development proposal; other folders receive Minimal.

The onboarding dialog supports a custom selection. Existing target files are
reported and preserved. MCP entries are proposals only and never create
credentials or connections automatically. Installed catalog versions are
recorded in the versionable `agentwatch.setup.json` file so later updates can
distinguish Agentwatch-managed content from project-owned files.

## Notes

- Hooks are read at session start: sessions already open when you launch
  `agentwatch` only appear from their next turn onward (earlier events still
  arrive in the queue from the moment hooks exist).
- `agentwatch stop` restores the previous `settings.local.json`; the queue and
  backups remain in `.agentwatch/` (delete the folder to purge).

## Publishing

```bash
npm version patch   # or minor
npm publish         # check name availability first: npm view agentwatch
```
