# Supporto multi-agent (Claude Code + Codex + opencode)

Analisi di fattibilità per rendere agentwatch compatibile non solo con Claude
Code, ma anche con Codex CLI e opencode. Nessun codice scritto, solo
considerazioni architetturali.

## Stato attuale del coupling

L'app è internamente ben disaccoppiata: coda `.agentwatch/events.ndjson`,
collector, server SSE e dashboard sono agnostici rispetto al tool. Il coupling
con Claude Code è concentrato in pochi file puntuali:

| File | Cosa è Claude-specifico |
|---|---|
| `src/settings.js` | scrive gli hook in `.claude/settings.local.json` (schema `hooks` di Claude, `command`+`args`, `async: true`) |
| `src/paths.js` / `src/run-hook.js` | detection della project root su `.claude` |
| `src/collector.js` | parsifica il payload Claude (`hook_event_name`, `agent_id`, `tool_use_id`, `transcript_path`, `duration_ms`, …) |
| `src/scan.js` | catalogo da `.claude/agents` e `.claude/skills` |

Queue, server e dashboard non conoscono Claude e non vanno toccati.

## Codex CLI — difficoltà: BASSA

Da maggio 2026 Codex ha un sistema di hook GA che è di fatto un clone del
modello Claude Code:

- Stessi nomi evento: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`.
- Payload quasi 1:1: `session_id`, `hook_event_name`, `tool_name`,
  `tool_input`, `tool_use_id`, `agent_id`, `agent_type`,
  `last_assistant_message`, `prompt`, `transcript_path`, `model`.
- Compatibilità esplicita: env `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`
  per i plugin.
- `src/run-hook.js` attuale funziona quasi così com'è.

Caveat da gestire:

- **`async` non supportato**: gli hook Codex sono sincroni. Il runner è
  velocissimo (append di una riga), quindi il rischio è basso, ma un hook che
  fallisce può bloccare il tool: va reso più difensivo (try/catch totale, exit
  veloce).
- **Formato config diverso**: `hooks.json` in `.codex/` (progetto) o
  `~/.codex/` (utente), con `command` come stringa shell unica (non
  `command`+`args` come Claude).
- **Trust flow**: gli hook di progetto si caricano solo se l'utente approva la
  layer `.codex/` via `/hooks` nella TUI → serve un passaggio di onboarding in
  più (e documentazione).
- **Eventi mancanti**: niente `PostToolUseFailure` né
  `TaskCreated`/`TaskCompleted`; in compenso `PreCompact`/`PostCompact` e
  `PermissionRequest`. Il collector li gestisce già in assenza, ma task e
  errori su Codex andrebbero derivati dal rollout JSONL (`event_msg` con task
  lifecycle) o accettati come assenti.

Stima: **mezza/una giornata** — un adapter che installa `hooks.json`; il
collector non si tocca (o quasi).

## opencode — difficoltà: MEDIA

Il meccanismo è diverso per natura: opencode non ha hook a riga di comando, ha
un **plugin system in-process** (modulo JS caricato da `opencode.json`, hook
`tool.execute.before`/`tool.execute.after`, `chat.message` e un bus `event`
generico).

Cosa serve:

- Un piccolo **plugin JS** che inoltri gli eventi alla stessa coda
  `.agentwatch/events.ndjson` (HTTP su localhost o append diretto). La
  retroattività su startup (rilettura della coda) continuerebbe a funzionare.
- Il plugin ha `input.sessionID` e `input.callID`, ma niente
  `agent_id`/`agent_type` equivalenti: gli agenti si ricavano da
  `chat.message`/agent del messaggio.
- I nomi tool sono diversi (`bash`, `read`, `edit`, …) → serve una mappatura
  nel collector o un payload normalizzato emesso dal plugin.
- Niente `transcript_path`/usage/costi come su Claude e Codex: il monitoraggio
  dei costi richiederebbe `chat.params`/`chat.message` oppure si rinuncia
  (colonna usage vuota per opencode).
- Catalogo: scan aggiuntivo di `.opencode/skills` e `.opencode/agent` — il
  formato SKILL.md è identico, quindi il parsing frontmatter è riusabile
  gratis.

Stima: **2-4 giorni** (plugin + mapping + scan + test).

## Architettura consigliata

Un solo livello di astrazione vale per entrambi i tool:

1. **Source adapter** per tool: `install(source, root)`, `uninstall(source,
   root)`, ciascuno responsabile del proprio file di config
   (`.claude/settings.local.json`, `.codex/hooks.json`, `opencode.json`).
2. **Root detection multi-dir**: `paths.js` deve riconoscere anche `.codex` e
   `.opencode` (oltre a `.claude` e `.agentwatch`).
3. **Normalizzazione eventi**: funzione `normalize(source, payload)` che
   traduce il payload di ogni tool nel formato interno — quasi identico per
   Claude e Codex, con mappatura dedicata per opencode.
4. **Registro condiviso**: il registro esistente in `.agentwatch/hooks.json`
   supporta già più `runnerPaths` contemporaneamente → più tool possono
   alimentare lo stesso dashboard senza conflitti.

## Riepilogo

| Tool | Sforzo | Meccanismo | Differenze principali |
|---|---|---|---|
| Claude Code | — (esistente) | command hooks, `async` | — |
| Codex CLI | ~1 giorno | command hooks sincroni + trust | `async` non supportato, trust flow, niente Task/PostToolUseFailure |
| opencode | 2-4 giorni | plugin in-process | nessun hook CLI, mapping eventi/tool, niente usage |

In sintesi: **Codex è economico** (OpenAI ha copiato il modello di hook di
Claude), **opencode è il costo reale** (plugin + normalizzazione). Server,
queue e dashboard restano intoccati in entrambi i casi.