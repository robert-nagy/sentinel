// Logic behind scripts/build-plugin.js: derives the generated manifests from the hand-written
// Claude Code ones and checks that the committed plugin is consistent (ADR-0006).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

export const PLUGIN_DIR = 'plugins/sentinel';
export const BUNDLE_NAME = 'sentinel.mjs';
export const BUNDLE_BUILD_PATH = `dist-bundle/${BUNDLE_NAME}`;

export const PATHS = {
  claudeMarketplace: '.claude-plugin/marketplace.json',
  claudePlugin: `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
  agentPlugin: `${PLUGIN_DIR}/plugin.json`,
  codexMarketplace: '.agents/plugins/marketplace.json',
  cursorMarketplace: '.cursor-plugin/marketplace.json',
  schema: 'schema/config.json',
};

export function readJson(root, relPath) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}

export function toJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Agent Plugins 1.0 root manifest (VS Code / Copilot, Codex, Cursor). */
export function deriveAgentPlugin(claudePlugin) {
  const { name, version, description, author, homepage, repository, license, keywords } =
    claudePlugin;
  return {
    name,
    version,
    description,
    author,
    homepage,
    repository,
    license,
    keywords,
    skills: './skills/',
  };
}

/** Codex catalog. */
export function deriveCodexMarketplace(marketplace) {
  return {
    name: marketplace.name,
    interface: { displayName: marketplace.name },
    plugins: marketplace.plugins.map((entry) => ({
      name: entry.name,
      source: { source: 'local', path: entry.source },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: entry.category ?? 'development',
    })),
  };
}

/** Cursor catalog. */
export function deriveCursorMarketplace(marketplace) {
  return {
    name: marketplace.name,
    owner: marketplace.owner,
    metadata: marketplace.metadata,
    plugins: marketplace.plugins.map((entry) => ({
      name: entry.name,
      source: entry.source.replace(/^\.\//, ''),
      description: entry.description,
    })),
  };
}

/** The generated manifests as `{ path: object }`, from the hand-written sources on disk. */
export function deriveManifests(root) {
  const marketplace = readJson(root, PATHS.claudeMarketplace);
  const claudePlugin = readJson(root, PATHS.claudePlugin);
  return {
    [PATHS.agentPlugin]: deriveAgentPlugin(claudePlugin),
    [PATHS.codexMarketplace]: deriveCodexMarketplace(marketplace),
    [PATHS.cursorMarketplace]: deriveCursorMarketplace(marketplace),
  };
}

export function skillDirs(root) {
  const dir = join(root, PLUGIN_DIR, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${PLUGIN_DIR}/skills/${entry.name}`)
    .sort();
}

function runBundle(root, bundlePath, args) {
  return execFileSync(process.execPath, [join(root, bundlePath), ...args], {
    encoding: 'utf8',
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/**
 * Consistency of the committed plugin. Never compares against `src/`, so feature PRs that
 * leave the bundle alone cannot fail it. Returns a list of problems (empty when fine).
 */
export function checkConsistency(root) {
  const problems = [];
  const pkgVersion = readJson(root, 'package.json').version;
  const claudePlugin = readJson(root, PATHS.claudePlugin);
  const marketplace = readJson(root, PATHS.claudeMarketplace);

  if (claudePlugin.version !== pkgVersion) {
    problems.push(
      `${PATHS.claudePlugin} version ${String(claudePlugin.version)} differs from package.json ${pkgVersion}`,
    );
  }
  for (const entry of marketplace.plugins) {
    if (!existsSync(join(root, entry.source, '.claude-plugin/plugin.json'))) {
      problems.push(
        `${PATHS.claudeMarketplace}: plugin "${entry.name}" has no plugin.json at ${entry.source}`,
      );
    }
  }

  for (const [path, expected] of Object.entries(deriveManifests(root))) {
    if (!existsSync(join(root, path))) {
      problems.push(`${path} is missing; run npm run build:plugin`);
    } else if (JSON.stringify(readJson(root, path)) !== JSON.stringify(expected)) {
      problems.push(
        `${path} does not match what the Claude manifests derive; run npm run build:plugin`,
      );
    }
  }

  const skills = skillDirs(root);
  if (skills.length === 0) problems.push(`${PLUGIN_DIR}/skills has no skills`);
  const digests = new Map();
  for (const dir of skills) {
    if (!existsSync(join(root, dir, 'SKILL.md'))) problems.push(`${dir}/SKILL.md is missing`);
    const bundle = join(root, dir, 'scripts', BUNDLE_NAME);
    if (!existsSync(bundle)) {
      problems.push(`${dir}/scripts/${BUNDLE_NAME} is missing; run npm run build:plugin`);
    } else {
      digests.set(dir, sha256(readFileSync(bundle)));
    }
  }
  if (new Set(digests.values()).size > 1) {
    problems.push(`the skill bundle copies differ: ${[...digests.keys()].join(', ')}`);
  }

  const first = skills.find((dir) => digests.has(dir));
  if (first !== undefined) {
    const bundlePath = `${first}/scripts/${BUNDLE_NAME}`;
    try {
      const reported = runBundle(root, bundlePath, ['--version']).trim();
      if (reported !== pkgVersion) {
        problems.push(
          `the committed bundle reports version ${reported}, package.json says ${pkgVersion}`,
        );
      }
      if (existsSync(join(root, PATHS.schema))) {
        const schema = JSON.parse(runBundle(root, bundlePath, ['config', 'schema']));
        if (JSON.stringify(schema) !== JSON.stringify(readJson(root, PATHS.schema))) {
          problems.push(
            `${PATHS.schema} does not match the committed bundle; run npm run build:plugin`,
          );
        }
      } else {
        problems.push(`${PATHS.schema} is missing; run npm run build:plugin`);
      }
    } catch (error) {
      problems.push(
        `the committed bundle does not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems;
}

/** Builds `dist-bundle/sentinel.mjs` from `src/` with tsup. */
export function buildBundle(root) {
  execFileSync('npx', ['tsup', '--config', 'tsup.bundle.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return join(root, BUNDLE_BUILD_PATH);
}

function writeIfChanged(root, relPath, text) {
  const target = join(root, relPath);
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === text) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
}

/** Rebuilds the bundle, copies it into every skill, stamps versions and writes derived files. */
export function buildPlugin(root) {
  const bundlePath = buildBundle(root);
  const bundle = readFileSync(bundlePath);
  const version = readJson(root, 'package.json').version;

  // Stamp the version without reformatting the hand-written file.
  const claudeText = readFileSync(join(root, PATHS.claudePlugin), 'utf8');
  const stamped = claudeText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (stamped !== claudeText) writeFileSync(join(root, PATHS.claudePlugin), stamped, 'utf8');

  for (const dir of skillDirs(root)) {
    const target = join(root, dir, 'scripts', BUNDLE_NAME);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bundle);
  }
  for (const [path, value] of Object.entries(deriveManifests(root))) {
    writeIfChanged(root, path, toJsonText(value));
  }
  const schema = runBundle(root, BUNDLE_BUILD_PATH, ['config', 'schema']);
  writeIfChanged(root, PATHS.schema, toJsonText(JSON.parse(schema)));
}

/**
 * Release-time guard: rebuilds from `src/` and returns the problems found when the committed
 * files differ from the fresh output.
 */
export function verifyFresh(root) {
  const problems = checkConsistency(root);
  const fresh = sha256(readFileSync(buildBundle(root)));
  for (const dir of skillDirs(root)) {
    const committed = join(root, dir, 'scripts', BUNDLE_NAME);
    if (existsSync(committed) && sha256(readFileSync(committed)) !== fresh) {
      problems.push(
        `${dir}/scripts/${BUNDLE_NAME} is stale: it does not match a fresh build of src/`,
      );
    }
  }
  return problems;
}
