export const SUPPORTED_EVENTS = ["issues", "issue_comment", "pull_request"] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

export const REMEDIATE_LABEL = "devin-remediate";

export interface NormalisedEvent {
  deliveryId: string;
  event: string;
  action?: string;
  repository?: string;
  issueNumber?: number;
  labels: string[];
  actionable: boolean;
  reason: string;
}

interface GitHubPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  issue?: { number?: unknown; labels?: unknown };
  pull_request?: { number?: unknown; labels?: unknown };
  label?: { name?: unknown };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) =>
      typeof label === "string" ? label : asString((label as { name?: unknown })?.name),
    )
    .filter((name): name is string => name !== undefined);
}

export function isSupportedEvent(event: string): event is SupportedEvent {
  return (SUPPORTED_EVENTS as readonly string[]).includes(event);
}

/**
 * Turns a raw GitHub delivery into the shape the orchestrator works with and
 * decides whether it should be handed to the Devin client.
 *
 * Only `issues` deliveries carrying the `devin-remediate` label are actionable
 * today; everything else is acknowledged and ignored.
 */
export function normaliseEvent(
  deliveryId: string,
  event: string,
  payload: unknown,
): NormalisedEvent {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as GitHubPayload;
  const subject = body.issue ?? body.pull_request;
  const labels = labelNames(subject?.labels);
  const base: NormalisedEvent = {
    deliveryId,
    event,
    action: asString(body.action),
    repository: asString(body.repository?.full_name),
    issueNumber: asNumber(subject?.number),
    labels,
    actionable: false,
    reason: "",
  };

  if (!isSupportedEvent(event)) {
    return { ...base, reason: "unsupported_event" };
  }

  if (event !== "issues") {
    return { ...base, reason: "event_not_actionable_yet" };
  }

  if (base.action !== "labeled") {
    return { ...base, reason: "action_not_actionable" };
  }

  const addedLabel = asString(body.label?.name);
  const hasRemediateLabel =
    addedLabel === REMEDIATE_LABEL || labels.includes(REMEDIATE_LABEL);

  if (!hasRemediateLabel) {
    return { ...base, reason: "label_not_matched" };
  }

  return { ...base, actionable: true, reason: "actionable" };
}
