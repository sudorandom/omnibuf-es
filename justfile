# List available recipes
default:
    @just --list

# Install workspace dependencies
install:
    pnpm install --frozen-lockfile

# Build all packages (@omnibuf/core, @omnibuf/web, @omnibuf/node, @omnibuf/protoc-gen-omnibuf-es)
build:
    pnpm run build

# Format all TypeScript, JSON, Markdown, and YAML files using Prettier
fmt:
    pnpm run fmt

# Check code formatting without modifying files
fmt-check:
    pnpm run fmt:check

# Lint and typecheck all packages using ESLint + TypeScript
lint:
    pnpm run lint

# Run TypeScript typechecking across all packages
typecheck:
    pnpm run typecheck

# Run all unit, golden, and corpus tests across packages
test:
    pnpm run test

# Run the cross-language conformance test runner against the Node.js adapter binary
conformance: build
    pnpm run conformance

# Run performance benchmarks against protobufjs, @bufbuild/protobuf, google-protobuf, msgpack, and JSON
bench:
    pnpm run bench

# Run full CI suite (format check, lint, typecheck, build, test, conformance)
ci: fmt-check lint build test conformance
