import { createHash } from 'node:crypto';

export interface FailureError {
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly message: string;
  /** The log line the error was read from. */
  readonly excerpt: string;
}

/** What the agent receives to fix a red CI run. */
export interface FailurePacket {
  /** Stable id of the failure; unchanged when only line numbers or counts move. */
  readonly signature: string;
  readonly toolchain: string;
  readonly jobs: readonly string[];
  readonly errors: readonly FailureError[];
  /** True when the log looks like an infrastructure hiccup, not a code defect. */
  readonly suspectedFlaky: boolean;
}

const MAX_LINE = 1000;
const MAX_ERRORS = 20;
const MAX_EXCERPT = 300;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const INFRA =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|Could not resolve host|503 Service Unavailable|rate limit exceeded|runner has received a shutdown signal|The operation was canceled/i;

interface Line {
  readonly job: string | undefined;
  readonly text: string;
}

/** Strips colours and the `job<TAB>step<TAB>timestamp` prefix of `gh run view --log-failed`. */
function toLines(log: string): Line[] {
  return log.split(/\r?\n/).map((raw) => {
    const clean = raw.replace(ANSI, '').slice(0, MAX_LINE);
    const parts = clean.split('\t');
    if (parts.length < 3) return { job: undefined, text: clean };
    let text = parts.slice(2).join('\t');
    const space = text.indexOf(' ');
    if (space > 19 && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(text.slice(0, space))) {
      text = text.slice(space + 1);
    }
    return { job: parts[0], text };
  });
}

function error(
  file: string | undefined,
  line: string | number | undefined,
  message: string,
  excerpt: string,
): FailureError {
  return {
    file,
    line: line === undefined ? undefined : Number(line),
    message: message.trim().slice(0, 500),
    excerpt: excerpt.trim().slice(0, MAX_EXCERPT),
  };
}

type Detector = (lines: readonly string[]) => FailureError[];

const tsc: Detector = (lines) => {
  const found: FailureError[] = [];
  for (const text of lines) {
    const paren = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/.exec(text);
    const colon = /^(\S+?):(\d+):\d+ - error (TS\d+): (.+)$/.exec(text);
    const m = paren ?? colon;
    if (m) found.push(error(m[1], m[2], `${m[3] ?? ''}: ${m[4] ?? ''}`, text));
  }
  return found;
};

const dotnet: Detector = (lines) => {
  const found: FailureError[] = [];
  for (const text of lines) {
    const m = /^(.+?)\((\d+),\d+\): error ([A-Z]+\d+): (.+?)(?: \[[^\]]*\])?$/.exec(text);
    if (m) found.push(error(m[1], m[2], `${m[3] ?? ''}: ${m[4] ?? ''}`, text));
  }
  return found;
};

const eslint: Detector = (lines) => {
  const found: FailureError[] = [];
  let file: string | undefined;
  for (const text of lines) {
    if (/^\S+\.[A-Za-z]{1,5}$/.test(text) && (text.includes('/') || text.includes('\\'))) {
      file = text;
      continue;
    }
    const m = /^\s+(\d+):\d+\s+error\s+(.+?)(?:\s{2,}(\S+))?$/.exec(text);
    if (m && file !== undefined) {
      found.push(error(file, m[1], m[3] === undefined ? (m[2] ?? '') : `${m[3]}: ${m[2] ?? ''}`, text));
    }
  }
  return found;
};

const vitestJest: Detector = (lines) => {
  const found: FailureError[] = [];
  let file: string | undefined;
  for (const text of lines) {
    const vitest = /^\s*FAIL\s+(\S+\.\w+)\s+>\s+(.+)$/.exec(text);
    if (vitest) {
      file = vitest[1];
      found.push(error(file, undefined, vitest[2] ?? '', text));
      continue;
    }
    const jestFile = /^\s*FAIL\s+(\S+\.\w+)\s*$/.exec(text);
    if (jestFile) {
      file = jestFile[1];
      continue;
    }
    const jest = /^\s*● (.+)$/.exec(text);
    if (jest && file !== undefined) {
      found.push(error(file, undefined, jest[1] ?? '', text));
      continue;
    }
    const last = found.at(-1);
    const detail = /^\s*(?:AssertionError|TypeError|ReferenceError|Error): (.+)$/.exec(text);
    if (last !== undefined && detail && !last.message.includes(': ')) {
      found[found.length - 1] = error(last.file, last.line, `${last.message}: ${detail[1] ?? ''}`, last.excerpt);
    }
    const stack = /^\s*❯ (\S+):(\d+):\d+/.exec(text);
    if (last !== undefined && stack && last.line === undefined) {
      found[found.length - 1] = error(last.file, stack[2], last.message, last.excerpt);
    }
  }
  return found;
};

const pytest: Detector = (lines) => {
  const found: FailureError[] = [];
  for (const text of lines) {
    const m = /^FAILED (\S+?)::(\S+)(?: - (.+))?$/.exec(text);
    if (m) found.push(error(m[1], undefined, m[3] === undefined ? (m[2] ?? '') : `${m[2] ?? ''} - ${m[3]}`, text));
  }
  return found;
};

const go: Detector = (lines) => {
  const found: FailureError[] = [];
  for (const text of lines) {
    const m = /^\s*(\S+\.go):(\d+):(?:\d+:)? (.+)$/.exec(text);
    if (m) found.push(error(m[1], m[2], m[3] ?? '', text));
  }
  return found;
};

const cargo: Detector = (lines) => {
  const found: FailureError[] = [];
  lines.forEach((text, index) => {
    const m = /^error(?:\[(E\d+)\])?: (.+)$/.exec(text);
    if (!m || (m[2] ?? '').startsWith('could not compile')) return;
    const where = /^\s*--> (.+):(\d+):\d+$/.exec(lines[index + 1] ?? '');
    found.push(error(where?.[1], where?.[2], m[1] === undefined ? (m[2] ?? '') : `${m[1]}: ${m[2] ?? ''}`, text));
  });
  return found;
};

const generic: Detector = (lines) => {
  const found: FailureError[] = [];
  lines.forEach((text, index) => {
    const m = /^\s*(?:Uncaught |Unhandled )?([A-Za-z]*Error): (.+)$/.exec(text);
    if (!m) return;
    const frame = /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(lines[index + 1] ?? '');
    found.push(error(frame?.[1], frame?.[2], `${m[1] ?? ''}: ${m[2] ?? ''}`, text));
  });
  return found;
};

const DETECTORS: readonly (readonly [string, Detector])[] = [
  ['tsc', tsc],
  ['dotnet', dotnet],
  ['eslint', eslint],
  ['vitest/jest', vitestJest],
  ['pytest', pytest],
  ['go', go],
  ['cargo', cargo],
  ['generic', generic],
];

function normalise(message: string): string {
  return message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
}

function signatureOf(toolchain: string, errors: readonly FailureError[]): string {
  const key = errors
    .slice(0, 5)
    .map((e) => `${e.file ?? ''}|${normalise(e.message)}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(`${toolchain}\n${key}`).digest('hex').slice(0, 12);
}

/** Turns the failed-step log of a CI run into a {@link FailurePacket}. */
export function parseFailureLog(log: string, jobsHint: readonly string[] = []): FailurePacket {
  const lines = toLines(log);
  const texts = lines.map((l) => l.text);
  const jobs = [...new Set([...jobsHint, ...lines.map((l) => l.job).filter((j) => j !== undefined)])];

  let toolchain = 'unknown';
  let errors: FailureError[] = [];
  for (const [name, detect] of DETECTORS) {
    const hits = detect(texts);
    if (hits.length > 0) {
      toolchain = name;
      errors = hits;
      break;
    }
  }
  if (errors.length === 0) {
    const tail = texts.filter((t) => t.trim() !== '').slice(-10);
    const last = tail.at(-1);
    if (last !== undefined) errors = [error(undefined, undefined, last, tail.join('\n'))];
  }

  const seen = new Set<string>();
  const unique = errors.filter((e) => {
    const key = `${e.file ?? ''}:${String(e.line ?? '')}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const capped = unique.slice(0, MAX_ERRORS);

  const infra = INFRA.test(log);
  const located = capped.some((e) => e.file !== undefined);
  return {
    signature: signatureOf(toolchain, capped),
    toolchain,
    jobs,
    errors: capped,
    suspectedFlaky: infra && (toolchain === 'unknown' || toolchain === 'generic' || !located),
  };
}
