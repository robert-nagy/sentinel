import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ISSUE_KINDS,
  ISSUE_SECTIONS,
  IssueFormatError,
  findSecrets,
  lintIssue,
  looksLikeText,
  parseIssueKind,
  planAttachment,
  renderAttachmentsSection,
  renderInline,
  renderIssueForm,
  renderTemplate,
  sizeCapFor,
  splitTitle,
  stripComments,
  type AttachmentPlan,
  type IssueKind,
} from '../../src/core/issue-format.js';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const read = (path: string) => readFileSync(join(fixtures, path), 'utf8');

function lintFixture(kind: IssueKind, file: string) {
  const { title, body } = splitTitle(read(`issues/${file}`));
  return lintIssue({ kind, title: title ?? '', body });
}

const codes = (result: ReturnType<typeof lintIssue>) => result.problems.map((p) => p.code);

describe('parseIssueKind', () => {
  it('accepts the two kinds in any case and rejects others', () => {
    expect(parseIssueKind(' Feature ')).toBe('feature');
    expect(parseIssueKind('bug')).toBe('bug');
    expect(() => parseIssueKind('chore')).toThrow(IssueFormatError);
  });
});

describe('golden issues', () => {
  it.each([
    ['feature', 'feature-good.md'],
    ['bug', 'bug-good.md'],
  ] as const)('%s: %s passes', (kind, file) => {
    const result = lintFixture(kind, file);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('feature-bad.md fails with every expected problem', () => {
    const result = lintFixture('feature', 'feature-bad.md');
    expect(result.ok).toBe(false);
    expect(new Set(codes(result))).toEqual(
      new Set([
        'title-format',
        'content-before-sections',
        'unknown-section',
        'section-order',
        'empty-section',
        'user-story',
        'acceptance-criterion',
        'template-comment',
        'placeholder',
        'ambiguous-term',
        'secret',
      ]),
    );
    // Secrets are reported by line and kind, never echoed.
    expect(JSON.stringify(result.problems)).not.toContain('s3cr3tvalue1234');
    expect(result.sections).toEqual([
      'user-story',
      'problem',
      'acceptance-criteria',
      'constraints',
      'context',
    ]);
  });

  it('bug-bad.md fails with every expected problem', () => {
    const result = lintFixture('bug', 'bug-bad.md');
    expect(new Set(codes(result))).toEqual(
      new Set([
        'title-format',
        'section-order',
        'steps-not-numbered',
        'empty-section',
        'placeholder',
        'frequency',
        'missing-section',
      ]),
    );
    expect(result.problems.find((p) => p.code === 'missing-section')?.section).toBe(
      'acceptance-criteria',
    );
  });

  it('feature-good.md is not a valid bug', () => {
    expect(codes(lintFixture('bug', 'feature-good.md'))).toContain('missing-section');
  });
});

describe('lintIssue details', () => {
  const feature = read('issues/feature-good.md');
  const { body } = splitTitle(feature);
  const lint = (title: string, text = body, kind: IssueKind = 'feature') =>
    lintIssue({ kind, title, body: text });

  it('checks the title rules', () => {
    expect(codes(lint(''))).toEqual(['missing-title']);
    expect(codes(lint(`Export ${'x'.repeat(80)}`))).toEqual(['title-too-long']);
    expect(codes(lint('export invoices'))).toEqual(['title-format']);
    expect(codes(lint('Export'))).toEqual(['title-format']);
    expect(codes(lint('Exported invoices'))).toEqual(['title-format']);
    expect(codes(lint('Embed invoices in mail'))).toEqual([]);
    expect(codes(lint('checkout: total is wrong'))).toEqual(['title-format']);
  });

  it('accepts optional sections left out and rejects empty optional ones', () => {
    const minimal = body.split('## Out of scope')[0] ?? '';
    expect(lint('Export invoices', minimal).ok).toBe(true);
    const empty = lint('Export invoices', `${minimal}\n## Context\n`);
    expect(empty.problems).toMatchObject([{ code: 'empty-section', section: 'context' }]);
  });

  it('reports duplicate sections', () => {
    const doubled = `${body}\n\n## Context\n\nMore.`;
    expect(codes(lint('Export invoices', doubled))).toEqual(['duplicate-section']);
  });

  it('ignores headings, placeholders and vague words inside code', () => {
    const extra = `${body}\n\n## Attachments\n\n- \`a.txt\`: sample (inline, below)\n\n<details><summary>a.txt (2 lines)</summary>\n\n\`\`\`\n## Problem\nTODO <role> fast\n\`\`\`\n\n</details>`;
    expect(lint('Export invoices', extra).problems).toEqual([]);
  });

  it('flags an inlined block over 200 lines and accepts 200', () => {
    const block = (n: number) =>
      `${body}\n\n## Attachments\n\n- \`a.log\`: trace (inline, below)\n\n<details><summary>a.log</summary>\n\n\`\`\`\n${Array.from({ length: n }, (_, i) => `l${String(i)}`).join('\n')}\n\`\`\`\n\n</details>`;
    expect(lint('Export invoices', block(200)).ok).toBe(true);
    expect(codes(lint('Export invoices', block(201)))).toEqual(['inline-too-long']);
  });

  it('accepts a generated block for a vaguely named file, and measures nested fences', async () => {
    const md = `# Notes\n\n\`\`\`sh\nnpm test\n\`\`\`\n${Array.from({ length: 250 }, (_, i) => `l${String(i)}`).join('\n')}\n`;
    const plan = await planAttachment(
      {
        path: 'quick-start.md',
        bytes: md.length,
        read: () => Promise.resolve(new TextEncoder().encode(md)),
      },
      { trackerUploads: false },
    );
    const section = renderAttachmentsSection([plan]).replace('<what it shows>', 'setup notes');
    expect(lint('Export invoices', `${body}\n\n${section}`).problems).toEqual([]);
    const untrimmed = `${body}\n\n## Attachments\n\n- \`a.md\`: notes (inline, below)\n\n<details><summary>a.md</summary>\n\n\`\`\`\`\n\`\`\`\n${Array.from({ length: 205 }, () => 'x').join('\n')}\n\`\`\`\n\`\`\`\`\n\n</details>`;
    expect(codes(lint('Export invoices', untrimmed))).toEqual(['inline-too-long']);
  });

  it('requires an AC list and numbered criteria', () => {
    const none = body.replace(
      /## Acceptance criteria[\s\S]*?(?=## Out of scope)/,
      '## Acceptance criteria\n\nSee above.\n\n',
    );
    expect(codes(lint('Export invoices', none))).toEqual(['no-acceptance-criteria']);
  });

  it('accepts the frequency forms', () => {
    const bug = splitTitle(read('issues/bug-good.md')).body;
    for (const value of ['`always`', 'once', 'intermittent (3 of 10 tries)']) {
      const text = bug.replace(/## Frequency\n\nalways/, `## Frequency\n\n${value}`);
      expect(lint('checkout: total ignores discount code', text, 'bug').ok).toBe(true);
    }
  });

  it('reports a secret in the title', () => {
    expect(codes(lint('Rotate AKIAIOSFODNN7EXAMPLE now'))).toContain('secret');
  });
});

describe('stripComments', () => {
  it('drops closed and unclosed comments, leaving no opener behind', () => {
    expect(stripComments('a<!-- x -->b<!-- y')).toBe('ab');
    expect(stripComments('<!<!-- -->-- z')).not.toMatch(/<!--.*-->/);
    expect(stripComments('plain')).toBe('plain');
  });
});

describe('splitTitle', () => {
  it('takes a leading H1 as the title', () => {
    expect(splitTitle('# Hello world\n\n## Problem\n\nx\n')).toEqual({
      title: 'Hello world',
      body: '## Problem\n\nx',
    });
    expect(splitTitle('## Problem\n\nx')).toEqual({ title: undefined, body: '## Problem\n\nx' });
  });
});

describe('template', () => {
  it.each(ISSUE_KINDS)('%s template lists every heading and fails lint until filled', (kind) => {
    const template = renderTemplate(kind);
    for (const section of ISSUE_SECTIONS[kind]) expect(template).toContain(`## ${section.heading}`);
    const result = lintIssue({ kind, title: 'x', body: template });
    expect(codes(result)).toContain('empty-section');
    expect(codes(result)).toContain('template-comment');
  });
});

describe('findSecrets', () => {
  it.each([
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private key'],
    ['key AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    [`ghp_${'a'.repeat(36)}`, 'GitHub token'],
    [`Authorization: Bearer ${'a1'.repeat(15)}`, 'bearer token'],
    ['postgres://admin:hunter22@db:5432/app', 'credentials in a URL'],
    ['DB_PASSWORD=correct-horse-battery', 'password or secret assignment'],
  ])('finds %s', (line, pattern) => {
    expect(findSecrets(`ok\n${line}`)).toContainEqual({ line: 2, pattern });
  });

  it.each(['password: ********', 'api_key=<redacted>', 'token = ${TOKEN}', 'secret: short'])(
    'ignores the redacted or short value %s',
    (line) => {
      expect(findSecrets(line)).toEqual([]);
    },
  );
});

describe('attachments', () => {
  const file = (path: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return { path, bytes: bytes.length, read: () => Promise.resolve(bytes) };
  };
  const fixture = (name: string) => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, 'attachments', name)));
    return file(`test/fixtures/attachments/${name}`, bytes);
  };

  it('trims a long log to its first and last 80 lines', async () => {
    const plan = await planAttachment(fixture('long.log'), { trackerUploads: false });
    expect(plan).toMatchObject({ kind: 'text', action: 'inline', lines: 1000, trimmed: true });
    const inline = plan.inline ?? '';
    expect(inline).toContain('long.log (lines 1–80 and 921–1000 of 1000)');
    expect(inline).toContain('… 840 lines cut (81–920) …');
    expect(inline).toContain('request 80 handled');
    expect(inline).not.toContain('request 81 handled');
    expect(inline).toContain('request 921 handled');
  });

  it('inlines short text whole, with a fence longer than any inside', async () => {
    const plan = await planAttachment(file('a.md', 'one\n```\ncode\n```\n'), {
      trackerUploads: false,
    });
    expect(plan).toMatchObject({ action: 'inline', lines: 4, trimmed: false });
    expect(plan.inline).toContain('````\none');
  });

  it('attaches or defers an image depending on the tracker', async () => {
    expect(await planAttachment(fixture('screenshot.png'), { trackerUploads: true })).toMatchObject(
      {
        kind: 'image',
        action: 'attach',
      },
    );
    expect(
      await planAttachment(fixture('screenshot.png'), { trackerUploads: false }),
    ).toMatchObject({ kind: 'image', action: 'pending-upload' });
  });

  it('blocks text with a token and says where, without the token', async () => {
    const plan = await planAttachment(fixture('deploy.env'), { trackerUploads: true });
    expect(plan).toMatchObject({ kind: 'text', action: 'blocked' });
    expect(plan.secrets).toContainEqual({ line: 3, pattern: 'AWS access key id' });
    expect(JSON.stringify(plan)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('rejects files over the size caps without reading them', async () => {
    const huge = (path: string, bytes: number) => ({
      path,
      bytes,
      read: () => Promise.reject(new Error('should not read')),
    });
    expect(
      await planAttachment(huge('a.png', 11 * 1024 * 1024), { trackerUploads: true }),
    ).toMatchObject({
      action: 'rejected',
    });
    expect(
      await planAttachment(huge('a.zip', 26 * 1024 * 1024), { trackerUploads: true }),
    ).toMatchObject({
      action: 'rejected',
    });
    expect(sizeCapFor('a.PNG')).toBe(10 * 1024 * 1024);
    expect(sizeCapFor('a.mp4')).toBe(25 * 1024 * 1024);
  });

  it('treats binary data and videos as uploads', async () => {
    const zip = await planAttachment(file('a.bin', new Uint8Array([1, 0, 2])), {
      trackerUploads: false,
    });
    expect(zip).toMatchObject({ kind: 'binary', action: 'pending-upload' });
    const video = await planAttachment(file('clip.mp4', 'not really'), { trackerUploads: true });
    expect(video).toMatchObject({ kind: 'video', action: 'attach' });
  });

  it('sniffs text, tolerating a multi-byte character cut by the sample', () => {
    expect(looksLikeText(new TextEncoder().encode('héllo'))).toBe(true);
    const long = new TextEncoder().encode(`${'a'.repeat(8191)}é`);
    expect(looksLikeText(long)).toBe(true);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80]))).toBe(false);
  });

  it('renders the Attachments section that lint accepts once described', async () => {
    const plans: AttachmentPlan[] = [
      await planAttachment(fixture('long.log'), { trackerUploads: false }),
      await planAttachment(fixture('screenshot.png'), { trackerUploads: false }),
      await planAttachment(fixture('deploy.env'), { trackerUploads: false }),
    ];
    const section = renderAttachmentsSection(plans);
    expect(section).toContain('- `long.log`: <what it shows> (inline, below)');
    expect(section).toContain('- `screenshot.png`: <what it shows> (pending upload)');
    expect(section).not.toContain('deploy.env');
    const body = `${splitTitle(read('issues/feature-good.md')).body}\n\n${section}`;
    expect(codes(lintIssue({ kind: 'feature', title: 'Export invoices', body }))).toEqual([
      'placeholder',
      'placeholder',
    ]);
    const described = body.replace(/<what it shows>/g, 'request trace');
    expect(lintIssue({ kind: 'feature', title: 'Export invoices', body: described }).ok).toBe(true);
    expect(renderAttachmentsSection([])).toBe('');
  });

  it('renders a one-line file in the singular', () => {
    expect(renderInline('a.txt', 'x').block).toContain('a.txt (1 line)');
  });
});

describe('GitHub issue forms', () => {
  /** Field ids and required flags, read back from the YAML with plain line matching. */
  function fields(yaml: string): { id: string; required: boolean }[] {
    const result: { id: string; required: boolean }[] = [];
    for (const line of yaml.split('\n')) {
      const id = /^ {4}id: (\S+)$/.exec(line);
      if (id?.[1] !== undefined) result.push({ id: id[1], required: false });
      const required = /^ {6}required: (true|false)$/.exec(line);
      const last = result.at(-1);
      if (required !== null && last !== undefined) last.required = required[1] === 'true';
    }
    return result;
  }

  it.each(ISSUE_KINDS)('the %s form and lint agree on every section id', (kind) => {
    const form = renderIssueForm(kind);
    expect(form.path).toBe(`.github/ISSUE_TEMPLATE/${kind}.yml`);
    expect(fields(form.content)).toEqual(
      ISSUE_SECTIONS[kind].map((s) => ({ id: s.id, required: s.required })),
    );
    // A body written from the form's labels, in order, is what lint parses.
    const body = ISSUE_SECTIONS[kind]
      .map(
        (s) =>
          `## ${JSON.parse(`"${/label: "(.*)"/.exec(form.content.split(`id: ${s.id}`)[1] ?? '')?.[1] ?? ''}"`) as string}\n\ntext`,
      )
      .join('\n\n');
    expect(lintIssue({ kind, title: 'x', body }).sections).toEqual(
      ISSUE_SECTIONS[kind].map((s) => s.id),
    );
  });

  it('maps the kind label through labelMap', () => {
    expect(renderIssueForm('bug', { 'kind/bug': 'bug' }).content).toContain('labels: ["bug"]');
    expect(renderIssueForm('feature').content).toContain('labels: ["kind/feature"]');
  });
});
