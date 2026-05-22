# Postgly

A modern, cross-platform desktop app for managing multiple PostgreSQL
databases — built with **Tauri 2** (Rust) and **React + TypeScript**.

> **Status: Phase 1 — Connection manager.** Saved connections can be
> created, edited, tested and deleted; passwords live in the OS keyring.
> The database explorer (Phase 2) is next.

## Tech stack

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Shell    | Tauri 2 — native window, packaging, IPC       |
| Backend  | Rust — engine-agnostic `DatabaseDriver` trait |
| Frontend | React 19 + TypeScript + Vite                  |
| Styling  | Tailwind CSS 4 + shadcn/ui design tokens      |
| Icons    | lucide-react                                  |

## Prerequisites

- Node.js 20+
- Rust (stable) + the [Tauri 2 system dependencies](https://tauri.app/start/prerequisites/)

## Development

```bash
npm install        # install frontend dependencies
npm run tauri dev  # run the desktop app with hot reload
```

Other scripts:

```bash
npm run typecheck    # type-check the frontend
npm run tauri build  # produce an installable bundle for the host OS
```

## Project structure

```
src/                      Frontend (React)
  components/
    ui/                   shadcn/ui primitives (button, input, dialog, ...)
    theme-provider.tsx    light / dark / system theme state
    theme-toggle.tsx
  features/
    connections/          connection manager (list, form, IPC wrappers)
  lib/                    shared helpers (cn, ...)
  App.tsx

src-tauri/                Backend (Rust / Tauri)
  src/
    commands/             Tauri command handlers (IPC surface)
      connections.rs      connection CRUD + test
    connections/          metadata store (JSON) + keyring helpers
    db/
      driver.rs           DatabaseDriver trait + DTOs
      postgres.rs         Postgres implementation (sqlx)
    error.rs              AppError — the error type crossing IPC
    lib.rs                Tauri builder / entry point
```

## Architecture notes

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
| 2     | Database explorer: schemas, tables, structure tab    |
| 3     | Data grid, quick filter, SQL editor                  |
| 4     | Global tabs — work across multiple databases at once |
| 5     | Polish, installers, auto-update                      |

## License

Private — all rights reserved.
