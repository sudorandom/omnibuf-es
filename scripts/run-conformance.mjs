#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = resolve(rootDir, 'testdata/conformance_corpus.json');
const adapterPath = resolve(rootDir, 'packages/omnibuf-node/dist/bin/conformance-es.js');
const localRunner = resolve(rootDir, 'bin/conformance-runner');
const siblingRunner = resolve(rootDir, '../omnibuf/bin/conformance-runner');
const siblingGoRepo = resolve(rootDir, '../omnibuf');

function resolveRunnerBinary() {
  if (process.env.CONFORMANCE_RUNNER && existsSync(process.env.CONFORMANCE_RUNNER)) {
    return process.env.CONFORMANCE_RUNNER;
  }
  if (existsSync(localRunner)) {
    return localRunner;
  }
  if (existsSync(siblingRunner)) {
    return siblingRunner;
  }
  mkdirSync(resolve(rootDir, 'bin'), { recursive: true });
  if (existsSync(resolve(siblingGoRepo, 'cmd/conformance-runner/main.go'))) {
    execFileSync('go', ['build', '-o', localRunner, './cmd/conformance-runner'], {
      cwd: siblingGoRepo,
      stdio: 'inherit',
    });
    return localRunner;
  }
  execFileSync('go', ['install', 'github.com/sudorandom/omnibuf/cmd/conformance-runner@main'], {
    cwd: rootDir,
    env: { ...process.env, GOBIN: resolve(rootDir, 'bin') },
    stdio: 'inherit',
  });
  return localRunner;
}

const runner = resolveRunnerBinary();
execFileSync(runner, ['-corpus', corpusPath, adapterPath], {
  cwd: rootDir,
  stdio: 'inherit',
});
