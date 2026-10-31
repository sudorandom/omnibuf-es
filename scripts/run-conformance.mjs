#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = resolve(rootDir, 'packages/omnibuf-node/dist/bin/conformance-es.js');
// Keep the runner and testdata/conformance_corpus.json on the same upstream revision.
const upstreamRevision = '9b0d5a7faf8ba742d5f9fb7df2b8507fbde2bf68';
const runnerDir = resolve(rootDir, 'bin/conformance', upstreamRevision);
const localRunner = resolve(runnerDir, 'conformance-runner');

function resolveRunnerBinary() {
  if (process.env.CONFORMANCE_RUNNER && existsSync(process.env.CONFORMANCE_RUNNER)) {
    return process.env.CONFORMANCE_RUNNER;
  }
  if (existsSync(localRunner)) {
    return localRunner;
  }
  mkdirSync(runnerDir, { recursive: true });
  execFileSync(
    'go',
    ['install', `github.com/sudorandom/omnibuf/cmd/conformance-runner@${upstreamRevision}`],
    {
      cwd: rootDir,
      env: { ...process.env, GOBIN: runnerDir },
      stdio: 'inherit',
    },
  );
  return localRunner;
}

const runner = resolveRunnerBinary();
execFileSync(runner, [process.execPath, adapterPath], {
  cwd: rootDir,
  stdio: 'inherit',
});
