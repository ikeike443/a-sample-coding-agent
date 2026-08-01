/**
 * Structured output contract for remediation sessions.
 *
 * Without a required structured output a session that decides no change is
 * needed simply stops talking: it never signals the end of its turn, so it
 * lingers as `blocked (awaiting instructions)` and the polling worker treats it
 * as working forever. Requiring the schema below forces the session to call
 * `provide_structured_output`, which both ends the turn and states the outcome.
 */

export const REMEDIATION_OUTCOMES = [
  "pr_created",
  "no_action_needed",
  "blocked_on_question",
] as const;

export type RemediationOutcome = (typeof REMEDIATION_OUTCOMES)[number];

export const REMEDIATION_STRUCTURED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary"],
  properties: {
    outcome: {
      type: "string",
      enum: [...REMEDIATION_OUTCOMES],
      description:
        "pr_created when a pull request was opened, no_action_needed when no change was required, blocked_on_question when a human decision is required.",
    },
    summary: {
      type: "string",
      description: "What was done, or why nothing was done.",
    },
    pr_url: {
      type: ["string", "null"],
      description: "URL of the pull request; set only when outcome is pr_created, otherwise null.",
    },
  },
};

export function isRemediationOutcome(value: unknown): value is RemediationOutcome {
  return REMEDIATION_OUTCOMES.includes(value as RemediationOutcome);
}

/** Reads the outcome out of a session's structured output, or `null` if absent/unknown. */
export function parseRemediationOutcome(
  structuredOutput: Record<string, unknown> | null | undefined,
): RemediationOutcome | null {
  const outcome = structuredOutput?.outcome;
  return isRemediationOutcome(outcome) ? outcome : null;
}
