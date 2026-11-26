// M8 E2E: install the plugin from this repository's marketplaces the way the host tools do,
// then run every skill's bundled CLI from the installed copy (ADR-0006).
//
// Needs no build: it exercises the committed bundle under plugins/sentinel/skills/*/scripts/.
// When the `claude` CLI is on PATH it also does a real `claude plugin install` into a
// throwaway config dir; otherwise that part is skipped, unless SENTINEL_REQUIRE_CLAUDE=1 (CI).
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/exec.js';

// resolve() drops the trailing separator, which would break a quoted Windows argument.
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PLUGIN = 'sentinel';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const { version } = readJson(join(root, 'package.json')) as { version: string };

interface Marketplace {
  name: string;
  plugins: { name: string; source: unknown; version?: string }[];
}

/** One tool's catalog, how it resolves a plugin's folder and which manifest it reads there. */
interface Tool {
  readonly tool: string;
  readonly catalog: string;
  readonly source: (source: unknown) => string;
  readonly manifests: readonly string[];
}

const TOOLS: readonly Tool[] = [
  {
    tool: 'claude-code',
    catalog: '.claude-plugin/marketplace.json',
    source: (source) => source as string,
    manifests: ['.claude-plugin/plugin.json'],
  },
  {
    tool: 'codex',
    catalog: '.agents/plugins/marketplace.json',
    source: (source) => {
      const local = source as { source: string; path: string };
      expect(local.source).toBe('local');
      return local.path;
    },
    manifests: ['plugin.json', '.codex-plugin/plugin.json'],
  },
  {
    tool: 'cursor',
    catalog: '.cursor-plugin/marketplace.json',
    source: (source) => source as string,
    manifests: ['.cursor-plugin/plugin.json', 'plugin.json'],
  },
];

// Canonical path: macOS tmpdir is a symlink and Windows TEMP can be an 8.3 short name.
const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-e2e-')));
// The skills run from a directory outside any git repository, like a fresh project.
const workDir = join(tempRoot, 'work');
mkdirSync(workDir);

afterAll(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // Windows can keep a handle open briefly after a child exits; leftovers are harmless.
    console.warn(`could not remove ${tempRoot}:`, error);
  }
});

/** Files a git clone of the marketplace would contain under `relDir` (tracked files only). */
function trackedFiles(relDir: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--', relDir], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter((file) => file !== '');
}

/** Resolves the plugin from a catalog and copies its tracked files to `dest`. */
function installFromCatalog(tool: Tool, dest: string): string {
  const catalog = readJson(join(root, tool.catalog)) as Marketplace;
  const entry = catalog.plugins.find((plugin) => plugin.name === PLUGIN);
  if (entry === undefined) throw new Error(`${tool.catalog} lists no "${PLUGIN}" plugin`);
  if (entry.version !== undefined) expect(entry.version).toBe(version);

  // Plugin sources are relative to the marketplace root, which is the repository root.
  const relSource = tool.source(entry.source).replace(/^\.\//, '');
  expect(existsSync(join(root, relSource)), `${tool.catalog} source ${relSource}`).toBe(true);
  const files = trackedFiles(relSource);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const target = join(dest, file.slice(relSource.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target);
  }
  return dest;
}

/** Skill folders of an installed plugin, discovered from disk so new skills are covered. */
function skillsOf(pluginDir: string): string[] {
  const skillsDir = join(pluginDir, 'skills');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (dirent) => dirent.isDirectory() && existsSync(join(skillsDir, dirent.name, 'SKILL.md')),
    )
    .map((dirent) => dirent.name)
    .sort();
}

const repoSkills = skillsOf(join(root, 'plugins', PLUGIN));

const bundled = (pluginDir: string, skill: string, ...args: string[]) =>
  runCommand(
    process.execPath,
    [join(pluginDir, 'skills', skill, 'scripts', 'sentinel.mjs'), ...args],
    {
      cwd: workDir,
      timeoutMs: 45_000,
    },
  );

/** The checks every installed copy must pass, whichever tool installed it. */
async function verifyInstalledPlugin(pluginDir: string, manifests: readonly string[]) {
  const manifest = manifests.map((rel) => join(pluginDir, rel)).find((path) => existsSync(path));
  if (manifest === undefined) throw new Error(`no plugin manifest in ${pluginDir}`);
  expect((readJson(manifest) as { name: string }).name).toBe(PLUGIN);
  expect((readJson(manifest) as { version: string }).version).toBe(version);

  const skills = skillsOf(pluginDir);
  expect(skills).toEqual(repoSkills);

  for (const skill of skills) {
    const versionResult = await bundled(pluginDir, skill, '--version');
    expect(versionResult.exitCode, `${skill} --version: ${versionResult.stderr}`).toBe(0);
    expect(versionResult.stdout.trim(), `${skill} --version`).toBe(version);

    const help = await bundled(pluginDir, skill, '--help');
    expect(help.exitCode, `${skill} --help: ${help.stderr}`).toBe(0);
    expect(help.stdout, `${skill} --help`).toContain('Usage:');

    const doctor = await bundled(pluginDir, skill, 'doctor', '--json');
    expect(doctor.timedOut, `${skill} doctor timed out; stderr: ${doctor.stderr}`).toBe(false);
    let report: { ok: boolean; checks: { id: string; status: string }[] };
    try {
      report = JSON.parse(doctor.stdout) as typeof report;
    } catch {
      throw new Error(
        `${skill} doctor --json printed no JSON (exit ${String(doctor.exitCode)})\n${doctor.stderr}`,
      );
    }
    expect(report.checks.find((check) => check.id === 'node')?.status, skill).toBe('pass');
    expect(report.checks.find((check) => check.id === 'git-repo')?.status, skill).toBe('warn');
    expect(doctor.exitCode, `${skill} doctor exit code`).toBe(report.ok ? 0 : 1);
  }
}

describe('plugin as the marketplaces install it', () => {
  it('the repository has skills to check', () => {
    expect(repoSkills.length).toBeGreaterThan(0);
  });

  // Up to three CLI runs per skill, so the budget grows with the skill count.
  const timeout = 60_000 + repoSkills.length * 3 * 20_000;
  it.each(TOOLS)(
    '$tool: installs from $catalog and every skill runs',
    { timeout },
    async (tool) => {
      const pluginDir = installFromCatalog(tool, join(tempRoot, tool.tool, PLUGIN));
      await verifyInstalledPlugin(pluginDir, tool.manifests);
    },
  );
});

// `claude` is an npm shim (`claude.cmd`) on Windows, which only a shell can start.
const isWindows = process.platform === 'win32';
// Arguments are fixed words and paths, which cannot contain `"` on Windows.
const quote = (arg: string) => `"${arg}"`;

function claude(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = isWindows
    ? spawnSync(['claude', ...args].map(quote).join(' '), {
        cwd: root,
        env,
        encoding: 'utf8',
        shell: true,
        timeout: 120_000,
      })
    : spawnSync('claude', args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const hasClaude = claude(['--version']).status === 0;

describe('claude CLI requirement', () => {
  it.runIf(process.env.SENTINEL_REQUIRE_CLAUDE === '1')('claude is on PATH', () => {
    expect(hasClaude, 'SENTINEL_REQUIRE_CLAUDE=1 but `claude --version` failed').toBe(true);
  });
});

describe.skipIf(!hasClaude)('plugin installed by Claude Code (claude CLI on PATH)', () => {
  // A throwaway config dir keeps the install away from the developer's own Claude Code setup.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(tempRoot, 'claude-config') };
  const run = (...args: string[]) => {
    const result = claude(args, env);
    expect(result.status, `claude ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };

  it('validates the marketplace and the plugin', () => {
    run('plugin', 'validate', root);
    run('plugin', 'validate', join(root, 'plugins', PLUGIN));
  });

  it('installs from the local marketplace and every skill runs', { timeout: 300_000 }, async () => {
    const { name: marketplace } = readJson(
      join(root, '.claude-plugin/marketplace.json'),
    ) as Marketplace;
    run('plugin', 'marketplace', 'add', root);
    run('plugin', 'install', `${PLUGIN}@${marketplace}`, '--scope', 'user');

    const installed = JSON.parse(run('plugin', 'list', '--json')) as {
      id: string;
      version: string;
      installPath?: string;
    }[];
    const plugin = installed.find((entry) => entry.id === `${PLUGIN}@${marketplace}`);
    expect(plugin?.version).toBe(version);
    const installPath = plugin?.installPath;
    if (installPath === undefined) throw new Error('claude plugin list reported no installPath');
    const canonical = (path: string) =>
      isWindows ? realpathSync.native(path).toLowerCase() : realpathSync.native(path);
    expect(canonical(installPath).startsWith(canonical(tempRoot)), installPath).toBe(true);
    await verifyInstalledPlugin(installPath, ['.claude-plugin/plugin.json']);
  });
});
