# Postgly — local development shortcuts.
#
# Run `make help` for a categorised command list. The Rust backend lives
# in `src-tauri/` and most targets cd into it. Postgres-backed
# integration tests need a database reachable via POSTGLY_TEST_DB_URL;
# `make pg-up` / `make pg-down` spin up an ephemeral container that the
# `test` and `coverage` targets hook into automatically.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- Postgres test container -------------------------------------------------

PG_CONTAINER ?= postgly-test-pg
PG_IMAGE     ?= postgres:16-alpine
PG_PORT      ?= 5544
PG_USER      ?= test
PG_PASSWORD  ?= test
PG_DB        ?= test
POSTGLY_TEST_DB_URL ?= localhost:$(PG_PORT):$(PG_USER):$(PG_PASSWORD):$(PG_DB)
export POSTGLY_TEST_DB_URL

CARGO_FLAGS  ?= --manifest-path src-tauri/Cargo.toml
TEST_FEATURES ?= --features mock-keyring

# --- Help --------------------------------------------------------------------

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z0-9_.-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Setup

.PHONY: install
install: ## Install JS deps + cargo tooling for the test pipeline.
	npm ci
	cargo install cargo-llvm-cov --locked || true

##@ Dev loop

.PHONY: dev
dev: ## Start the Tauri dev app (Vite + Rust backend).
	npm run tauri dev

.PHONY: web
web: ## Run the Vite frontend on its own (no Tauri shell).
	npm run dev

.PHONY: build
build: ## Build the production Tauri bundle for the current platform.
	npm run tauri build

.PHONY: typecheck
typecheck: ## Type-check the TypeScript frontend.
	npm run typecheck

##@ Backend quality

.PHONY: fmt
fmt: ## Apply rustfmt to the backend.
	cargo fmt --all $(CARGO_FLAGS)

.PHONY: fmt-check
fmt-check: ## Fail if backend code isn't rustfmt-clean (CI mirror).
	cargo fmt --all --check $(CARGO_FLAGS)

.PHONY: lint
lint: ## Run clippy with the same -D warnings gate CI uses.
	cargo clippy $(CARGO_FLAGS) -- -D warnings
	cargo clippy $(CARGO_FLAGS) $(TEST_FEATURES) --tests -- -D warnings

.PHONY: check
check: fmt-check lint ## fmt-check + clippy. Quick PR sanity pass.

##@ Tests

.PHONY: test-unit
test-unit: ## Run unit tests only (no Postgres required).
	cargo test $(CARGO_FLAGS) --lib $(TEST_FEATURES) -- --test-threads=1

.PHONY: test-integration
test-integration: pg-up ## Run Postgres integration tests against the local container.
	cargo test $(CARGO_FLAGS) $(TEST_FEATURES) --test postgres_driver -- --test-threads=1

.PHONY: test
test: pg-up ## Run the full backend suite (unit + integration) against the local PG.
	cargo test $(CARGO_FLAGS) $(TEST_FEATURES) -- --test-threads=1

.PHONY: coverage
coverage: pg-up ## Run llvm-cov with the same gate CI enforces (>=90%).
	cargo llvm-cov $(CARGO_FLAGS) \
	  $(TEST_FEATURES) \
	  --ignore-filename-regex '(main\.rs|lib\.rs)$$' \
	  --fail-under-lines 90 \
	  --fail-under-file-lines 90 \
	  -- --test-threads=1

.PHONY: coverage-html
coverage-html: pg-up ## Generate an HTML coverage report under target/llvm-cov/html.
	cargo llvm-cov $(CARGO_FLAGS) \
	  $(TEST_FEATURES) \
	  --ignore-filename-regex '(main\.rs|lib\.rs)$$' \
	  --html \
	  -- --test-threads=1
	@echo "Report: src-tauri/target/llvm-cov/html/index.html"

.PHONY: coverage-lcov
coverage-lcov: pg-up ## Emit lcov.info under src-tauri/ (for editor coverage gutters).
	cargo llvm-cov $(CARGO_FLAGS) \
	  $(TEST_FEATURES) \
	  --ignore-filename-regex '(main\.rs|lib\.rs)$$' \
	  --lcov --output-path src-tauri/lcov.info \
	  -- --test-threads=1

##@ Postgres container

.PHONY: pg-up
pg-up: ## Start (or reuse) the test Postgres container and wait until ready.
	@if [ -z "$$(docker ps -q -f name=^/$(PG_CONTAINER)$$)" ]; then \
	  if [ -n "$$(docker ps -aq -f name=^/$(PG_CONTAINER)$$)" ]; then \
	    docker start $(PG_CONTAINER) >/dev/null; \
	  else \
	    docker run -d --name $(PG_CONTAINER) \
	      -e POSTGRES_USER=$(PG_USER) \
	      -e POSTGRES_PASSWORD=$(PG_PASSWORD) \
	      -e POSTGRES_DB=$(PG_DB) \
	      -p $(PG_PORT):5432 \
	      $(PG_IMAGE) >/dev/null; \
	  fi; \
	  echo "waiting for postgres..."; \
	  until docker exec $(PG_CONTAINER) pg_isready -U $(PG_USER) >/dev/null 2>&1; do sleep 1; done; \
	  echo "postgres ready on localhost:$(PG_PORT)"; \
	fi

.PHONY: pg-down
pg-down: ## Stop and remove the test Postgres container.
	-@docker rm -f $(PG_CONTAINER) >/dev/null 2>&1 || true
	@echo "$(PG_CONTAINER) removed"

.PHONY: pg-logs
pg-logs: ## Tail logs from the test Postgres container.
	docker logs -f $(PG_CONTAINER)

.PHONY: pg-psql
pg-psql: ## Open a psql shell into the test Postgres container.
	docker exec -it $(PG_CONTAINER) psql -U $(PG_USER) -d $(PG_DB)

##@ Cleanup

.PHONY: clean
clean: ## Remove Rust build artefacts and the JS dist directory.
	cargo clean $(CARGO_FLAGS)
	rm -rf dist src-tauri/lcov.info

.PHONY: clean-all
clean-all: clean pg-down ## clean + tear down the test Postgres container.
