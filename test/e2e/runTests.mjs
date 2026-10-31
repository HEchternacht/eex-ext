// Builds the e2e suite, copies sample/ (without its venv) to a temp workspace and runs VS Code against it.
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await esbuild.build({
  entryPoints: [join(root, 'test/e2e/suite/index.ts'), join(root, 'test/e2e/suite/acceptance.test.ts')],
  outdir: join(root, 'out/e2e'),
  bundle: true,
  external: ['vscode', 'mocha'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
});

const workspace = mkdtempSync(join(tmpdir(), 'codeflow-e2e-'));
cpSync(join(root, 'sample'), workspace, {
  recursive: true,
  filter: src => !/[\\/](\.venv|__pycache__|\.pytest_cache|\.vscode)([\\/]|$)/.test(src.slice(root.length)),
});
const python = join(root, 'sample', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) throw new Error(`sample venv missing: ${python}`);

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out/e2e/index.js'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: { CODEFLOW_TEST_PYTHON: python, CODEFLOW_TEST_WORKSPACE: workspace },
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
