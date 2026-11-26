import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../src/cli/index.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { nodeFiles } from '../../src/core/fs.js';
import { linkAttachment } from '../../src/core/local-tracker.js';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-intake-'));
  await mkdir(join(repo, '.git'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const deps: CliDeps = {
    run: () =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: '', notFound: true, timedOut: false }),
    files: nodeFiles,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    setExitCode: (c) => {
      exitCode = c;
    },
    nodeVersion: '22.11.0',
    platform: 'linux',
    cwd: repo,
    homeDir: join(repo, 'home'),
    env: { XDG_CONFIG_HOME: join(repo, 'xdg'), APPDATA: join(repo, 'appdata') },
    now: () => new Date('2026-11-26T12:00:00Z'),
  };
  return {
    run: async (...args: string[]) => {
      out.length = 0;
      err.length = 0;
      exitCode = undefined;
      await main(['node', 'sentinel', ...args], deps);
    },
    text: () => out.join('\n'),
    json: (): unknown => JSON.parse(out.join('\n')),
    err: () => err.join('\n'),
    exitCode: () => exitCode,
  };
}

const fixture = (name: string) =>
  copyFile(join(fixtures, name), join(repo, name.split('/').pop() ?? name));
const config = (value: unknown) =>
  writeFile(join(repo, 'sentinel.config.json'), JSON.stringify(value), 'utf8');

describe('sentinel issue template', () => {
  it('prints the body and, with --json, the section definition', async () => {
    const c = cli();
    await c.run('issue', 'template', 'bug');
    expect(c.text()).toContain('## Steps to reproduce');
    expect(c.text()).toContain('<component>: <symptom>');
    await c.run('issue', 'template', 'feature', '--json');
    const result = c.json() as { sections: { id: string }[]; body: string };
    expect(result.sections.map((s) => s.id)).toContain('user-story');
    expect(result.body).toContain('## Problem');
  });

  it('rejects an unknown kind with exit 1', async () => {
    const c = cli();
    await c.run('issue', 'template', 'epic');
    expect(c.err()).toContain('unknown issue kind');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });
});

describe('sentinel issue lint', () => {
  it('exits 0 for a good issue and 2 for a bad one', async () => {
    await fixture('issues/feature-good.md');
    await fixture('issues/bug-bad.md');
    const c = cli();
    await c.run('issue', 'lint', 'feature-good.md', '--kind', 'feature');
    expect(c.text()).toContain('may be filed');
    expect(c.exitCode()).toBeUndefined();
    await c.run('issue', 'lint', 'bug-bad.md', '--kind', 'bug');
    expect(c.text()).toMatch(/problem\(s\) to fix/);
    expect(c.exitCode()).toBe(ExitCode.Refine);
  });

  it('takes the title from --title and returns the body to file', async () => {
    const body = (await readFile(join(fixtures, 'issues/feature-good.md'), 'utf8')).replace(
      /^# .*\n/,
      '',
    );
    await writeFile(join(repo, 'body.md'), body);
    const c = cli();
    await c.run(
      'issue',
      'lint',
      'body.md',
      '--kind',
      'feature',
      '--title',
      'Export invoices as CSV',
      '--json',
    );
    const result = c.json() as { ok: boolean; title: string; body: string };
    expect(result).toMatchObject({ ok: true, title: 'Export invoices as CSV' });
    expect(result.body.startsWith('## Problem')).toBe(true);
  });

  it('reports a missing draft with exit 1', async () => {
    const c = cli();
    await c.run('issue', 'lint', 'nope.md', '--kind', 'bug');
    expect(c.err()).toContain('issue draft not found');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });
});

describe('sentinel issue attachments', () => {
  it('plans each file and exits 2 when one is blocked', async () => {
    await fixture('attachments/long.log');
    await fixture('attachments/screenshot.png');
    await fixture('attachments/deploy.env');
    const c = cli();
    await c.run('issue', 'attachments', 'long.log', 'screenshot.png', '--json');
    const ok = c.json() as { ok: boolean; files: { action: string }[]; section: string };
    expect(ok.ok).toBe(true);
    expect(ok.files.map((f) => f.action)).toEqual(['inline', 'pending-upload']);
    expect(ok.section).toContain('## Attachments');
    expect(c.exitCode()).toBeUndefined();

    await c.run('issue', 'attachments', 'screenshot.png', 'deploy.env', '--tracker-uploads');
    expect(c.text()).toMatch(/^attach\s+screenshot\.png/m);
    expect(c.text()).toMatch(/^blocked\s+deploy\.env/m);
    expect(c.text()).not.toContain('AKIA');
    expect(c.exitCode()).toBe(ExitCode.Refine);
  });

  it('reports a missing file with exit 1', async () => {
    const c = cli();
    await c.run('issue', 'attachments', 'gone.png');
    expect(c.err()).toContain('attachment not found');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });
});

describe('local tracker update and attach', () => {
  it('updates the title and body, keeping comments, then attaches files', async () => {
    await fixture('attachments/screenshot.png');
    await writeFile(
      join(repo, 'new.md'),
      '## Problem\n\nNew body.\n\n## Attachments\n\n- `screenshot.png`: the page (pending upload)\n',
    );
    const c = cli();
    await c.run('issue', 'create', '--title', 'Old title', '--body', 'old body');
    await c.run('issue', 'comment', '1', '--body', 'Original body:\n\nold body');
    await c.run(
      'issue',
      'update',
      '1',
      '--title',
      'Export invoices as CSV',
      '--body-file',
      'new.md',
      '--json',
    );
    const updated = c.json() as { title: string; body: string; comments: unknown[] };
    expect(updated).toMatchObject({ title: 'Export invoices as CSV' });
    expect(updated.body).toContain('New body.');
    expect(updated.comments).toHaveLength(1);

    await c.run('issue', 'attach', '1', 'screenshot.png');
    expect(c.text()).toBe('attached attachments/1/screenshot.png to #1');
    const stored = await readFile(join(repo, 'docs/issues/attachments/1/screenshot.png'));
    expect(stored.length).toBe(70);
    await c.run('issue', 'get', '1', '--json');
    expect((c.json() as { body: string }).body).toContain(
      '- [`screenshot.png`](attachments/1/screenshot.png): the page (uploaded)',
    );

    await c.run('issue', 'attach', '1', 'screenshot.png');
    expect(c.err()).toContain('already has an attachment named screenshot.png');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });

  it('refuses to attach a file with a secret, and encodes the link', async () => {
    await fixture('attachments/deploy.env');
    await writeFile(join(repo, 'a (1)#.txt'), 'plain text\n');
    const c = cli();
    await c.run('issue', 'create', '--title', 'A thing');
    await c.run('issue', 'attach', '1', 'deploy.env');
    expect(c.err()).toContain('line 3 looks like a secret');
    expect(c.err()).not.toContain('AKIA');
    await c.run('issue', 'attach', '1', 'a (1)#.txt');
    await c.run('issue', 'get', '1', '--json');
    expect((c.json() as { body: string }).body).toContain(
      '[`a (1)#.txt`](attachments/1/a%20%281%29%23.txt)',
    );
    await c.run('issue', 'update', '1', '--body-file', 'missing.md');
    expect(c.err()).toContain('body file not found: missing.md');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });

  it('refuses an empty update and a missing file', async () => {
    const c = cli();
    await c.run('issue', 'create', '--title', 'A thing');
    await c.run('issue', 'update', '1');
    expect(c.err()).toContain('nothing to update');
    await c.run('issue', 'update', '1', '--title', ' ');
    expect(c.err()).toContain('needs a title');
    await c.run('issue', 'attach', '1', 'missing.png');
    expect(c.err()).toContain('file not found');
  });

  it('refuses update and attach when issues live in another tracker', async () => {
    await config({ issueProvider: { tracker: 'github' } });
    const c = cli();
    await c.run('issue', 'update', '1', '--title', 'x');
    expect(c.exitCode()).toBe(ExitCode.Provider);
  });

  it('describes update and attach for the local tracker', async () => {
    await config({ issueProvider: { tracker: 'local' } });
    const c = cli();
    await c.run('issue', 'describe');
    expect(c.text()).toContain('$ sentinel issue update <id>');
    expect(c.text()).toContain('$ sentinel issue attach <id> <file>');
  });
});

describe('linkAttachment', () => {
  it('adds a section, appends to a list, or links an existing bullet', () => {
    expect(linkAttachment('', 'a.png', 'attachments/1/a.png')).toBe(
      '## Attachments\n\n- [`a.png`](attachments/1/a.png) (uploaded)',
    );
    expect(linkAttachment('## Problem\n\nx', 'a b.png', 'attachments/1/a b.png')).toBe(
      '## Problem\n\nx\n\n## Attachments\n\n- [`a b.png`](attachments/1/a%20b.png) (uploaded)',
    );
    const withList =
      '## Attachments\n\n- `log.txt`: trace (inline, below)\n\n<details>\n</details>\n\n## Next';
    expect(linkAttachment(withList, 'a.png', 'x/a.png')).toBe(
      '## Attachments\n\n- `log.txt`: trace (inline, below)\n- [`a.png`](x/a.png) (uploaded)\n\n<details>\n</details>\n\n## Next',
    );
    expect(
      linkAttachment('```\n## Attachments\n```', 'a.png', 'x/a.png').endsWith(
        '```\n\n## Attachments\n\n- [`a.png`](x/a.png) (uploaded)',
      ),
    ).toBe(true);
    expect(linkAttachment('## Attachments\n', 'a.png', 'x/a.png')).toBe(
      '## Attachments\n\n- [`a.png`](x/a.png) (uploaded)\n',
    );
  });
});

describe('sentinel setup --issue-forms', () => {
  it('writes both forms with mapped labels, and refuses to overwrite', async () => {
    await config({
      issueProvider: { tracker: 'github', labelMap: { 'kind/feature': 'enhancement' } },
    });
    const c = cli();
    await c.run('setup', '--issue-forms', '--json');
    expect((c.json() as { files: string[] }).files).toEqual([
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/bug.yml',
    ]);
    const feature = await readFile(join(repo, '.github/ISSUE_TEMPLATE/feature.yml'), 'utf8');
    expect(feature).toContain('labels: ["enhancement"]');
    expect(feature).toContain('id: acceptance-criteria');
    await c.run('setup', '--issue-forms');
    expect(c.err()).toContain('already exists');
    await c.run('setup', '--issue-forms', '--force', '--dry-run');
    expect(c.text()).toContain('(dry run) wrote .github/ISSUE_TEMPLATE/bug.yml');
  });

  it('refuses when the tracker is not GitHub', async () => {
    await config({ issueProvider: { tracker: 'jira' } });
    const c = cli();
    await c.run('setup', '--issue-forms');
    expect(c.err()).toContain('issue forms are for GitHub Issues');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });
});
