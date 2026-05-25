<div align="center">

<img src="src/assets/postgly-logo-named.png" alt="Postgly" width="376" />

# Postgly

**The modern, local-first PostgreSQL client — now with a natural-language SQL assistant.**

Fast, open, cross-platform. Built with **Tauri 2** (Rust) + **React + TypeScript**.

[![Latest release](https://img.shields.io/github/v/release/alissonpelizaro/postgly?style=flat-square)](https://github.com/alissonpelizaro/postgly/releases/latest)
[![License](https://img.shields.io/badge/license-Private-lightgrey?style=flat-square)](#license)

### ⬇️ Download

[**macOS — Apple Silicon**](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-macos-arm64.dmg) ·
[**macOS — Intel**](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-macos-x64.dmg) ·
[**Windows (.exe)**](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-windows-x64-setup.exe) ·
[**Linux (.AppImage)**](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-linux-x86_64.AppImage) ·
[**Linux (.deb)**](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-linux-amd64.deb)

All builds on the [Releases page](https://github.com/alissonpelizaro/postgly/releases). See [install notes](#install-notes) below.

</div>

---

## ✨ Ask your database in plain English (or Portuguese)

Postgly ships with a **natural-language SQL assistant**. Describe what you want; the agent inspects your live schema with real tool calls (`list_tables`, `describe_table`, `list_relations`, `sample_rows`) and hands back a query you can review before running.

> *"todos os usuários cadastrados no mês passado"*
> → `SELECT * FROM public.users WHERE created_at >= date_trunc('month', now() - interval '1 month') AND created_at < date_trunc('month', now());`

- 🧠 **Bring your own LLM** — any OpenAI-compatible endpoint (OpenAI, Ollama, Groq, Together, …). API key lives in the OS keyring.
- 🔍 **Schema-aware** — reads live columns, PKs, FKs and comments. No hallucinated names.
- 🔗 **Joins planned for you** — FKs surfaced via `list_relations`, multi-table questions land as proper JOINs.
- 🛡 **Safe by default** — destructive statements trigger a confirmation modal with `EXPLAIN`-based row estimate.
- 🤝 **Honest about failure** — falls back to `need_info` / `not_found` with reasons, clickable suggestions and fuzzy table matches.
- 🔁 **Refine, retry, recall** — keep context with **Refinar**, browse session history, see live **token usage** per request.
- ▶️ **You decide when to execute** — SQL drops into the editor; nothing runs until you press play.

---

## 🚀 Features

| | |
|---|---|
| 🤖 **NL → SQL** | Schema introspection, tool calls, destructive guard, suggestions, per-session history |
| 🗂 **Multiple connections** | Every database in its own tab — switch instantly |
| 🌳 **Schema explorer** | Browse schemas, tables, views; inspect columns & indexes |
| 📊 **Records grid** | Quick-filter, sort by any column, paginated browsing |
| ✏️ **Edit · Insert · Delete** | Row-level edits inline; dedicated JSON / JSONB view |
| 💻 **SQL editor** | Syntax-highlighted, run-selection, per-session command history |
| 🔐 **Local & private** | Passwords + LLM API keys in the OS keyring — never on disk in plain text |
| 🌓 **Light & dark themes** | Follows the system by default |

**Shortcuts:** `Cmd/Ctrl+1`–`9` jump tabs · `Cmd/Ctrl+0` connection manager · `Cmd/Ctrl+Enter` run SQL.

---

## 📦 Install notes

Installers are currently **unsigned** — first-launch warnings on macOS and Windows are expected. Code signing / notarization is planned.

### 🍎 macOS

1. Open the `.dmg`, drag **Postgly.app** into `/Applications`.
2. Clear the quarantine attribute (one-time, required because the bundle is unsigned):

   ```bash
   xattr -cr /Applications/Postgly.app
   ```

   Without this, macOS refuses to launch with *"Postgly is damaged and can't be opened"*.
3. Launch from Launchpad or `/Applications`.

### 🪟 Windows

1. Run the [`.exe` installer](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-windows-x64-setup.exe) (or the [`.msi`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-windows-x64.msi) for managed deploys).
2. SmartScreen may show *"Windows protected your PC"* — click **More info → Run anyway**.
3. Launch from the Start menu.

### 🐧 Linux

**AppImage**

```bash
chmod +x Postgly-linux-x86_64.AppImage
./Postgly-linux-x86_64.AppImage
```

**Debian / Ubuntu**

```bash
sudo dpkg -i Postgly-linux-amd64.deb
sudo apt-get install -f   # pull missing deps if any
```

---

## 🧑‍💻 Using the natural-language SQL assistant

1. Open **Settings → LLM Config** (header dropdown). Pick a preset (OpenAI / Ollama / Custom), paste base URL + API key, set the model, click **Testar conexão**.
2. *(Optional)* **Settings → Segurança** — keep "Sempre confirmar operações destrutivas" enabled (default) for a confirmation modal + `EXPLAIN` row estimate before any mutation runs.
3. In any connection tab, switch the records pane to **SQL** mode. The bar with the ✨ icon sits above the editor — type your request:

   > *"vendas do trimestre por cliente, em ordem decrescente"*

4. The agent calls schema tools (visible in the collapsible "Raciocínio do agente" trace) and emits a JSON answer:
   - `ok` + the SQL — click **Editar** to drop it into the editor or **Usar SQL** to replace the current statement, then run it.
   - `need_info` — clarifying questions and clickable example clauses to refine the prompt.
   - `not_found` — table candidates ranked by fuzzy distance against your real schema.
5. Use **Refinar** to keep prior context, or the **history** icon to revisit/restore any past prompt from the session.

Request budget is capped at 8 model turns; per-request token usage is shown alongside the result.

---

## 🛠 Contributing

Postgly is open to contributions.

### Tech stack

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Shell    | Tauri 2 — native window, packaging, IPC       |
| Backend  | Rust — engine-agnostic `DatabaseDriver` trait |
| Frontend | React 19 + TypeScript + Vite                  |
| Styling  | Tailwind CSS 4 + shadcn/ui design tokens      |
| Icons    | lucide-react                                  |

### Prerequisites

- Node.js 20+
- Rust (stable) + [Tauri 2 system dependencies](https://tauri.app/start/prerequisites/)

### Development

```bash
make install       # install frontend deps + cargo-llvm-cov
make dev           # run the desktop app with hot reload
```

`make help` lists every target. Day-to-day:

```bash
make web                # Vite frontend only (no Tauri shell)
make typecheck          # type-check the frontend
make fmt / make lint    # rustfmt / clippy on the backend
make check              # fmt-check + clippy — same gate the CI runs
make build              # produce an installable bundle for the host OS
```

### Backend tests

The Rust suite is split in two: in-process unit tests and integration tests that hit a real Postgres. `make pg-up` spins up an ephemeral `postgres:16-alpine` container (port `5544` by default) and exports `POSTGLY_TEST_DB_URL` so the integration tests pick it up automatically.

```bash
make test-unit          # unit tests only — no Postgres required
make test-integration   # auto-starts the test container, runs the PG suite
make test               # full suite (unit + integration)

make coverage           # llvm-cov with the same >=90% gate the CI enforces
make coverage-html      # browsable HTML report under target/llvm-cov/html
make coverage-lcov      # lcov.info for editor coverage gutters

make pg-up / pg-down    # control the test Postgres container
make pg-psql            # psql shell into the test container
```

CI runs `cargo llvm-cov` with `--fail-under-lines 90 --fail-under-file-lines 90`, so a PR dropping backend coverage below 90% overall (or on any single file) fails the build.

### Releases

Pushing a version tag builds and publishes installers for macOS, Windows and Linux to a draft GitHub Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

### Project structure

```
src/                      Frontend (React)
  assets/                 brand logo
  components/
    ui/                   shadcn/ui primitives (button, input, dialog,
                          dropdown-menu, ...)
    theme-provider.tsx    light / dark / system theme state
    theme-toggle.tsx
  features/
    connections/          connection manager (list, form, IPC wrappers)
    explorer/             connected workspace (schema tree, structure,
                          records grid, quick-filter, SQL editor,
                          NlQueryBar, DestructiveConfirmDialog)
    settings/             Settings shell + per-category panels
                          (LLM Config, Segurança)
    tabs/                 global tab bar — one tab per open connection
  lib/                    shared helpers (cn, ...)
  App.tsx

src-tauri/                Backend (Rust / Tauri)
  src/
    commands/             Tauri command handlers (IPC surface)
      connections.rs      connection CRUD + test
      explorer.rs         open/close session, schema introspection,
                          analyze_statement (destructive guard)
      llm.rs              generate_sql + nl_query_history
      settings.rs         get/save settings, test_llm_config
    connections/          metadata store (JSON) + keyring helpers
    db/
      driver.rs           DatabaseDriver trait + DTOs
      postgres.rs         Postgres implementation (sqlx)
      sql_safety.rs       statement classifier (destructive / WHERE-less)
    llm/
      chat.rs             OpenAI-compatible chat completions client +
                          token usage
      tools.rs            agent tool schemas (list_tables,
                          describe_table, list_relations, sample_rows)
      agent.rs            tool-use loop (8-turn budget, JSON contract)
      fuzzy.rs            Levenshtein-based "did you mean" fallback
    settings/             on-disk Settings (LLM + Safety) + keyring
                          helpers for the LLM API key
    error.rs              AppError — the error type crossing IPC
    state.rs              session registry + schema cache + NL history
    lib.rs                Tauri builder / entry point
  tests/
    postgres_driver.rs    integration suite (gated by POSTGLY_TEST_DB_URL)
```

### Architecture notes

- **Engine-agnostic from day one.** Every database backend implements the single `DatabaseDriver` trait in `src-tauri/src/db/driver.rs`. Postgres is the only engine today; adding MySQL/SQLite later means adding an implementation and one match arm in `db::make_driver` — no call sites change.
- **Theming** uses CSS custom properties (`src/index.css`) with a `.dark` class on `<html>`. The choice (light / dark / system) is persisted to `localStorage`.
- **Secrets never touch the metadata store.** Connection metadata is a plain JSON file under the app config dir; the password is stored apart in the OS keyring, keyed by the connection id.

## License

Private — all rights reserved.
