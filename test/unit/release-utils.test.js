import { describe, expect, it } from 'vitest';
import {
  extractChangelogSection,
  isPrerelease,
  planStage,
  readVersion,
  versionLinePattern,
} from '../../scripts/release-utils.js';

describe('planStage', () => {
  it('stages when the version changed in a push', () => {
    const plan = planStage({
      eventName: 'push',
      versionBefore: '0.1.0',
      versionNow: '0.2.0',
      live: false,
    });
    expect(plan.action).toBe('stage');
    expect(plan.reason).toContain('0.1.0');
    expect(plan.reason).toContain('0.2.0');
  });

  it('does not re-stage on later pushes while the version waits for approval', () => {
    const plan = planStage({
      eventName: 'push',
      versionBefore: '0.2.0',
      versionNow: '0.2.0',
      live: false,
    });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('did not change');
  });

  it('skips when the version is already live, even if it just changed', () => {
    const plan = planStage({
      eventName: 'push',
      versionBefore: '0.1.0',
      versionNow: '0.2.0',
      live: true,
    });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('already published');
  });

  it('stages when the previous version is unknown (e.g. a new branch)', () => {
    expect(
      planStage({ eventName: 'push', versionBefore: undefined, versionNow: '1.0.0', live: false })
        .action,
    ).toBe('stage');
  });

  it('always attempts a manual run so a failed stage can be retried', () => {
    const plan = planStage({
      eventName: 'workflow_dispatch',
      versionBefore: undefined,
      versionNow: '0.2.0',
      live: false,
    });
    expect(plan.action).toBe('stage');
    expect(plan.reason).toContain('manual');
  });

  it('never stages a manual run of a version that is already live', () => {
    expect(
      planStage({
        eventName: 'workflow_dispatch',
        versionBefore: undefined,
        versionNow: '0.2.0',
        live: true,
      }).action,
    ).toBe('skip');
  });
});

describe('readVersion', () => {
  it('reads the version field', () => {
    expect(readVersion('{"name":"x","version":"1.2.3"}')).toBe('1.2.3');
  });

  it('returns undefined for invalid JSON or a missing/non-string version', () => {
    expect(readVersion('not json')).toBeUndefined();
    expect(readVersion('{"name":"x"}')).toBeUndefined();
    expect(readVersion('{"version":3}')).toBeUndefined();
  });
});

const CHANGELOG = `# @robert-nagy/sentinel

## 0.2.0

### Patch Changes

- abc1234: Faster doctor.

## 0.1.0

### Minor Changes

- def5678: Project foundation.
`;

describe('extractChangelogSection', () => {
  it('returns the section for a version, stopping at the next heading', () => {
    expect(extractChangelogSection(CHANGELOG, '0.2.0')).toBe(
      '### Patch Changes\n\n- abc1234: Faster doctor.',
    );
  });

  it('returns the last section through the end of the file', () => {
    expect(extractChangelogSection(CHANGELOG, '0.1.0')).toBe(
      '### Minor Changes\n\n- def5678: Project foundation.',
    );
  });

  it('handles CRLF line endings', () => {
    expect(extractChangelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.2.0')).toBe(
      '### Patch Changes\n\n- abc1234: Faster doctor.',
    );
  });

  it('does not match a different version that shares a prefix', () => {
    expect(extractChangelogSection('## 0.10.0\n\n- x\n', '0.1.0')).toBeUndefined();
  });

  it('returns undefined when the version is absent or its section is empty', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeUndefined();
    expect(extractChangelogSection('## 1.0.0\n\n## 0.9.0\n\n- y\n', '1.0.0')).toBeUndefined();
  });
});

describe('isPrerelease', () => {
  it('detects pre-release versions', () => {
    expect(isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('versionLinePattern', () => {
  const matches = (version, line) => new RegExp(versionLinePattern(version)).test(line);

  it('matches the version line with any spacing', () => {
    expect(matches('0.2.0', '  "version": "0.2.0",')).toBe(true);
    expect(matches('0.2.0', '{"name":"x","version":"0.2.0"}')).toBe(true);
    expect(matches('0.2.0', '"version":   "0.2.0"')).toBe(true);
  });

  it('does not match other versions or look-alikes', () => {
    expect(matches('0.2.0', '"version": "0.2.1"')).toBe(false);
    expect(matches('0.2.0', '"version": "10.2.0"')).toBe(false);
    expect(matches('0.2.0', '"version": "0x2y0"')).toBe(false);
  });

  it('escapes regex metacharacters in pre-release versions', () => {
    expect(matches('1.0.0-beta.1+build', '"version": "1.0.0-beta.1+build"')).toBe(true);
    expect(matches('1.0.0-beta.1', '"version": "1.0.0-beta.1"')).toBe(true);
  });
});
