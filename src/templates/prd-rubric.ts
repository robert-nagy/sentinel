import { DIMENSIONS, type Dimension } from '../core/prd-validator.js';

export const RUBRIC: Readonly<Record<Dimension, { question: string; anchors: readonly string[] }>> =
  {
    clarity: {
      question: 'Can two engineers read this and build the same thing?',
      anchors: [
        '90-100: precise wording, defined terms, no vague adjectives, no open placeholders',
        '70-89: mostly precise; a few terms need a definition',
        'below 70: ambiguous or contradictory statements, or unfilled placeholders',
      ],
    },
    testability: {
      question: 'Could every requirement be verified by an automated test?',
      anchors: [
        '90-100: every FR has Given/When/Then scenarios; every NFR has a number and unit; the test matrix is concrete',
        '70-89: scenarios exist for most FRs; some targets are loose',
        'below 70: requirements without scenarios, or unmeasurable targets',
      ],
    },
    completeness: {
      question: 'Is everything needed to start designing present?',
      anchors: [
        '90-100: context, FRs, NFRs, security, data models, API contracts and test strategy are all substantive',
        '70-89: all sections exist but some are thin',
        'below 70: a section is missing or only a stub',
      ],
    },
    security: {
      question: 'Are the security boundaries explicit?',
      anchors: [
        '90-100: authentication, authorisation (RBAC) and input validation are specified per resource, plus data protection where relevant',
        '70-89: all three covered at a general level',
        'below 70: one of the three is missing, or security is only mentioned in passing',
      ],
    },
    feasibility: {
      question: 'Can this be built as written, with known technology and effort?',
      anchors: [
        '90-100: targets are realistic for the stack, dependencies and risks are named',
        '70-89: plausible, with some unproven assumptions',
        'below 70: targets that contradict each other or the stack, or hidden large unknowns',
      ],
    },
  };

/** Agent-facing scoring instructions, printed by `sentinel prd rubric`. */
export function formatRubric(): string {
  const lines = [
    'Score each dimension from 0 to 100. Be strict: the validator caps scores to what the document structure supports, and the PRD must reach a mean of at least the configured threshold with no dimension below the floor.',
    '',
  ];
  for (const dimension of DIMENSIONS) {
    const entry = RUBRIC[dimension];
    lines.push(`${dimension}: ${entry.question}`, ...entry.anchors.map((a) => `  ${a}`), '');
  }
  lines.push(
    'Write the scores as JSON and run: sentinel prd validate <file> --scores scores.json',
    '{"clarity": 0, "testability": 0, "completeness": 0, "security": 0, "feasibility": 0}',
  );
  return lines.join('\n');
}
