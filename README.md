# Postgly

A modern, cross-platform desktop app for managing multiple PostgreSQL
databases — fast, local and open. Built with **Tauri 2** (Rust) and
**React + TypeScript**.

![Postgly](src/assets/postgly-logo.png)

## Features

- **Multiple connections** — manage every database from one window, each
  open in its own tab.
- **Schema explorer** — browse schemas, tables and views, inspect column
  and index structure.
- **Records grid** — browse rows with a quick-filter, sort by any column
  and paginate through results.
- **Edit, insert and delete** rows directly; JSON / JSONB columns get a
  dedicated JSON view.
- **SQL editor** — syntax-highlighted free-form queries; run only the
  selected statement, with a per-session command history.
- **Local & private** — connection passwords live in the OS keyring,
  never in a plain file.
- **Light & dark themes**, following the system by default.

## Download

Grab the installer for your operating system from the latest release:

| OS                       | Installer                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🍎 macOS (Apple Silicon) | [Download `.dmg`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-macos-arm64.dmg)                                                                                                                   |
| 🍎 macOS (Intel)         | [Download `.dmg`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-macos-x64.dmg)                                                                                                                     |
| 🪟 Windows               | [`.exe`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-windows-x64-setup.exe) / [`.msi`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-windows-x64.msi)              |
| 🐧 Linux                 | [`.AppImage`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-linux-x86_64.AppImage) / [`.deb`](https://github.com/alissonpelizaro/postgly/releases/latest/download/Postgly-linux-amd64.deb)         |

> Installers are currently **unsigned** — macOS and Windows may warn on
> first launch. Code signing / notarization is planned.
>
> All builds are on the [Releases page](https://github.com/alissonpelizaro/postgly/releases).

---

## Contributing

Postgly is open to contributions. The sections below cover running the
app locally and how the codebase is organized.

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
- Rust (stable) + the [Tauri 2 system dependencies](https://tauri.app/start/prerequisites/)

### Development

```bash
make install       # install frontend deps + cargo-llvm-cov
make dev           # run the desktop app with hot reload
```

`make help` lists every target. The most useful ones day to day:

```bash
make web                # Vite frontend only (no Tauri shell)
make typecheck          # type-check the frontend
make fmt / make lint    # rustfmt / clippy on the backend
make check              # fmt-check + clippy — same gate the CI runs
make build              # produce an installable bundle for the host OS
```

### Backend tests

The Rust suite is split in two: in-process unit tests and integration
tests that hit a real Postgres. `make pg-up` spins up an ephemeral
`postgres:16-alpine` container (port `5544` by default) and exports
`POSTGLY_TEST_DB_URL` so the integration tests pick it up automatically.

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

The CI workflow runs `cargo llvm-cov` with `--fail-under-lines 90
--fail-under-file-lines 90`, so a PR that drops backend coverage below
90% overall (or below 90% on any single file) fails the build.

**Keyboard shortcuts:** `Cmd/Ctrl+1`–`9` jump to the Nth connection tab,
`Cmd/Ctrl+0` returns to the connection manager, `Cmd/Ctrl+Enter` runs the
SQL editor.

### Releases

Pushing a version tag builds and publishes installers for macOS, Windows
and Linux to a draft GitHub Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

### Project structure

```
src/                      Frontend (React)
  assets/                 brand logo
  components/
    ui/                   shadcn/ui primitives (button, input, dialog, ...)
    theme-provider.tsx    light / dark / system theme state
    theme-toggle.tsx
  features/
    connections/          connection manager (list, form, IPC wrappers)
    explorer/             connected workspace (schema tree, structure,
                          records grid, quick-filter, SQL editor)
    tabs/                 global tab bar — one tab per open connection
  lib/                    shared helpers (cn, ...)
  App.tsx

src-tauri/                Backend (Rust / Tauri)
  src/
    commands/             Tauri command handlers (IPC surface)
      connections.rs      connection CRUD + test
      explorer.rs         open/close session, schema/table introspection
    connections/          metadata store (JSON) + keyring helpers
    db/
      driver.rs           DatabaseDriver trait + DTOs
      postgres.rs         Postgres implementation (sqlx)
    error.rs              AppError — the error type crossing IPC
    state.rs              open-connection session registry
    lib.rs                Tauri builder / entry point
  tests/
    postgres_driver.rs    integration suite (gated by POSTGLY_TEST_DB_URL)
```

### Architecture notes

- **Engine-agnostic from day one.** Every database backend implements the
  single `DatabaseDriver` trait in `src-tauri/src/db/driver.rs`. Postgres
  is the only engine today; adding MySQL/SQLite later means adding an
  implementation and one match arm in `db::make_driver` — no call sites
  change.
- **Theming** uses CSS custom properties (`src/index.css`) with a `.dark`
  class on `<html>`. The choice (light / dark / system) is persisted to
  `localStorage`.
- **Secrets never touch the metadata store.** Connection metadata is a
  plain JSON file under the app config dir; the password is stored apart
  in the OS keyring, keyed by the connection id.

## Roadmap

| Phase | Scope                                                |
| ----- | ---------------------------------------------------- |
| 0     | Foundation: scaffold, theming, CI, driver trait   ✅ |
| 1     | Connection manager (CRUD, OS keyring)             ✅ |
| 2     | Database explorer: schemas, tables, structure tab ✅ |
| 3     | Data grid, quick filter, SQL editor               ✅ |
| 4     | Global tabs — work across multiple databases at once ✅ |
| 5     | Polish, installers ✅ · auto-update + signing pending |

## License

Private — all rights reserved.
