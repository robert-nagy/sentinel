import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_NAME,
  PATHS,
  checkConsistency,
  deriveCodexMarketplace,
  deriveCursorMarketplace,
  deriveManifests,
  skillDirs,
  toJsonText,
} from '../../scripts/plugin-lib.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// A stand-in for the real bundle: answers the two commands check:plugin runs.
const FAKE_BUNDLE = [
  "const args = process.argv.slice(2).join(' ');",
  "if (args === '--version') process.stdout.write('1.0.0\\n');",
  "else if (args === 'config schema') process.stdout.write('{\"type\":\"object\"}\\n');",
  '',
].join('\n');

const marketplace = {
  name: 'acme',
  owner: { name: 'Acme' },
  metadata: { description: 'd' },
  plugins: [{ name: 'tool', source: './plugins/tool', description: 'x', category: 'development' }],
};
const claudePlugin = { name: 'tool', version: '1.0.0', description: 'x', keywords: ['k'] };

let root;

function write(relPath, content) {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function writeFixture() {
  write('package.json', toJsonText({ name: 'p', version: '1.0.0' }));
  write(PATHS.claudeMarketplace, toJsonText(marketplace));
  write('plugins/tool/.claude-plugin/plugin.json', toJsonText(claudePlugin));
  for (const [path, value] of Object.entries(deriveManifests(root))) write(path, toJsonText(value));
  for (const skill of ['one', 'two']) {
    write(`plugins/sentinel/skills/${skill}/SKILL.md`, `---\nname: ${skill}\n---\n`);
    write(`plugins/sentinel/skills/${skill}/scripts/${BUNDLE_NAME}`, FAKE_BUNDLE);
  }
  write(PATHS.schema, toJsonText({ type: 'object' }));
}

describe('derived manifests', () => {
  it('lists the plugin in the Codex catalog with a local source', () => {
    const codex = deriveCodexMarketplace(marketplace);
    expect(codex.plugins[0]?.source).toEqual({ source: 'local', path: './plugins/tool' });
  });

  it('lists the plugin in the Cursor catalog without a leading ./', () => {
    expect(deriveCursorMarketplace(marketplace).plugins[0]?.source).toBe('plugins/tool');
  });
});

describe('checkConsistency', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sentinel-plugin-'));
    // The fixture's plugin dir is `tool`, but skills live under the fixed PLUGIN_DIR.
    mkdirSync(join(root, 'plugins/tool/.claude-plugin'), { recursive: true });
    write('plugins/sentinel/.claude-plugin/plugin.json', toJsonText(claudePlugin));
    writeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes for a consistent plugin', () => {
    expect(checkConsistency(root)).toEqual([]);
  });

  it('finds the skills', () => {
    expect(skillDirs(root)).toEqual([
      'plugins/sentinel/skills/one',
      'plugins/sentinel/skills/two',
    ]);
  });

  it('flags a hand-edited generated manifest', () => {
    write(PATHS.codexMarketplace, toJsonText({ name: 'tampered', plugins: [] }));
    expect(checkConsistency(root).join('\n')).toContain('does not match');
  });

  it('flags a version that differs from package.json', () => {
    write('package.json', toJsonText({ name: 'p', version: '2.0.0' }));
    expect(checkConsistency(root).join('\n')).toContain('differs from package.json');
  });

  it('flags bundle copies that are not identical', () => {
    write(`plugins/sentinel/skills/two/scripts/${BUNDLE_NAME}`, `${FAKE_BUNDLE}// changed\n`);
    expect(checkConsistency(root).join('\n')).toContain('bundle copies differ');
  });

  it('flags a skill without a bundle copy', () => {
    write('plugins/sentinel/skills/three/SKILL.md', '---\nname: three\n---\n');
    expect(checkConsistency(root).join('\n')).toContain('skills/three/scripts');
  });

  it('flags a bundle whose version differs from package.json', () => {
    write('package.json', toJsonText({ name: 'p', version: '1.0.1' }));
    write('plugins/sentinel/.claude-plugin/plugin.json', toJsonText({ ...claudePlugin, version: '1.0.1' }));
    expect(checkConsistency(root).join('\n')).toContain('the committed bundle reports version');
  });

  it('flags a schema that does not match the bundle', () => {
    write(PATHS.schema, toJsonText({ type: 'string' }));
    expect(checkConsistency(root).join('\n')).toContain('does not match the committed bundle');
  });
});

describe('this repository', () => {
  it('has a consistent committed plugin', () => {
    expect(checkConsistency(repoRoot)).toEqual([]);
  });

  it('installs under the name sentinel from the marketplace robert-nagy', () => {
    const catalog = JSON.parse(readFileSync(join(repoRoot, PATHS.claudeMarketplace), 'utf8'));
    expect(catalog.name).toBe('robert-nagy');
    expect(catalog.plugins.map((p) => p.name)).toContain('sentinel');
  });
});
