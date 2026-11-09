import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';
import { listItems, mermaidLabel, renderReadme } from '../../src/core/readme-renderer.js';
import { ECOSYSTEMS, plannedProject } from '../../src/core/stack-analyzer.js';
import { renderWorkflows, tierCommand } from '../../src/core/workflows.js';

const [tests, load] = [0, 1] as const;

describe('renderWorkflows', () => {
  it('puts unit, integration and e2e on push and PR, and load on its own schedule', () => {
    const files = renderWorkflows([plannedProject('node', '.', 'pnpm')], DEFAULT_CONFIG);
    const main = files[tests]?.content ?? '';
    const loadYml = files[load]?.content ?? '';
    expect(files[tests]?.path).toBe('.github/workflows/sentinel-tests.yml');
    expect(main).toContain('pull_request:');
    expect(main).toContain('branches: [main]');
    for (const tier of ['unit', 'integration', 'e2e']) expect(main).toContain(`  ${tier}:`);
    expect(main).not.toContain('  load:');
    expect(main).toContain('pnpm install --frozen-lockfile');
    expect(main).toContain('npx playwright install --with-deps');
    expect(loadYml).toContain('workflow_dispatch:');
    expect(loadYml).toContain('schedule:');
    expect(loadYml).not.toContain('pull_request');
    expect(loadYml).not.toContain('push:');
    expect(loadYml).toContain('grafana/setup-k6-action@v1');
  });

  it('uses the configured command before the ecosystem default', () => {
    const config = {
      ...DEFAULT_CONFIG,
      testing: { ...DEFAULT_CONFIG.testing, unit: 'make unit', load: null },
    };
    const project = plannedProject('go');
    expect(tierCommand(project, 'unit', config.testing)).toBe('make unit');
    expect(tierCommand(project, 'integration', config.testing)).toBe('go test -tags=integration ./...');
    expect(renderWorkflows([project], config)[tests]?.content).toContain('      - run: make unit');
  });

  it('writes one job per tier and project in a monorepo, scoped to its folder', () => {
    const content =
      renderWorkflows(
        [plannedProject('node', 'apps/web'), plannedProject('python', 'services/api')],
        DEFAULT_CONFIG,
      )[tests]?.content ?? '';
    expect(content).toContain('  unit-apps-web:');
    expect(content).toContain('  unit-services-api:');
    expect(content).toContain('working-directory: services/api');
    expect(content).toContain('actions/setup-python@v5');
  });

  it('covers every ecosystem with a setup step and four tier commands', () => {
    for (const ecosystem of ECOSYSTEMS) {
      const [main, loadFile] = renderWorkflows([plannedProject(ecosystem)], DEFAULT_CONFIG);
      expect(main?.content, ecosystem).toContain('actions/checkout@v5');
      expect(main?.content.split('      - run:').length, ecosystem).toBeGreaterThanOrEqual(4);
      expect(loadFile?.content, ecosystem).toContain('load:');
    }
  });
});

describe('README renderer', () => {
  const answers = {
    problem: 'Teams lose track of work.',
    users: 'Managers; Engineers',
    data: 'Tasks',
    scale: '500 users',
    integrations: 'Slack, GitHub',
    journeys: '1. Create a task\n2. Close a task',
    pii: 'yes',
    regulations: 'GDPR',
  };

  it('renders the domain and both diagrams', () => {
    const readme = renderReadme({
      name: 'Tracker',
      answers,
      projects: [plannedProject('node')],
    });
    expect(readme).toContain('# Tracker');
    expect(readme).toContain('## Problem');
    expect(readme).toContain('- Create a task');
    expect(readme).toContain('## Compliance');
    expect(readme).toContain('GDPR');
    expect(readme.match(/```mermaid/g)).toHaveLength(2);
    expect(readme).toContain('flowchart LR');
    expect(readme).toContain('u0 --> system');
    expect(readme).toContain('system --> x1');
    expect(readme).toContain('flowchart TB');
    expect(readme).toContain('c0 --> store');
  });

  it('omits empty sections and falls back to generic nodes', () => {
    const readme = renderReadme({ name: 'X', answers: { problem: 'P' }, projects: [] });
    expect(readme).not.toContain('## Integrations');
    expect(readme).not.toContain('## Compliance');
    expect(readme).toContain('["Users"]');
    expect(readme).toContain('["Application"]');
  });

  it('keeps Mermaid labels safe', () => {
    expect(mermaidLabel('Admin "root" [x] (y) {z} <b> | `c`; & #')).toBe('Admin root x y z b c');
    expect(mermaidLabel('  ')).toBe('unnamed');
    expect(mermaidLabel('a'.repeat(60))).toHaveLength(40);
  });

  it('splits list answers', () => {
    expect(listItems('none')).toEqual([]);
    expect(listItems('a, b; c')).toEqual(['a', 'b', 'c']);
    expect(listItems('- one\n* two\n3) three')).toEqual(['one', 'two', 'three']);
    expect(listItems(undefined)).toEqual([]);
  });
});
