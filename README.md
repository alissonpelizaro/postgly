# Postgly

A modern, cross-platform desktop app for managing multiple PostgreSQL
databases — built with **Tauri 2** (Rust) and **React + TypeScript**.

> **Status: Phase 0 — Foundation.** Scaffold, theming, CI and the
> engine-agnostic database layer are in place. The connection manager
> (Phase 1) is next.

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
    ui/                   shadcn/ui primitives
    theme-provider.tsx    light / dark / system theme state
    theme-toggle.tsx
  lib/                    shared helpers (cn, ...)
  features/               feature modules — added per phase
  App.tsx

src-tauri/                Backend (Rust / Tauri)
  src/
    commands/             Tauri command handlers (IPC surface)
    db/
      driver.rs           DatabaseDriver trait + DTOs
      postgres.rs         Postgres implementation
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

## Roadmap

| Phase | Scope                                                |
| ----- | ---------------------------------------------------- |
| 0     | Foundation: scaffold, theming, CI, driver trait      |
| 1     | Connection manager (CRUD, OS keyring for passwords)  |
| 2     | Database explorer: schemas, tables, structure tab    |
| 3     | Data grid, quick filter, SQL editor                  |
| 4     | Global tabs — work across multiple databases at once |
| 5     | Polish, installers, auto-update                      |

## License

Private — all rights reserved.
