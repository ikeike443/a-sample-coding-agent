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
  /**
   * Logical identity of the trigger — `repository#issue:action:label` — used to
   * drop repeat deliveries that carry a different `X-GitHub-Delivery` id.
   */
  triggerKey?: string;
  actionable: boolean;
  /** The delivery reports the issue as closed, so its runs can be closed out. */
  issueClosed: boolean;
  /** The delivery reports a pull request as closed, merged or not. */
  pullRequestClosed: boolean;
  /** Set alongside `pullRequestClosed`; the pull request the run produced. */
  pullRequestUrl?: string;
  /** Whether the closed pull request was merged rather than discarded. */
  pullRequestMerged: boolean;
  reason: string;
}

interface GitHubPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  issue?: { number?: unknown; labels?: unknown };
  pull_request?: { number?: unknown; labels?: unknown; html_url?: unknown; merged?: unknown };
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

/** `repository#issue:action:label`; stable across deliveries of the same trigger. */
function triggerKey(event: NormalisedEvent): string {
  const repository = event.repository ?? "unknown";
  const issue = event.issueNumber ?? "unknown";
  return `${repository}#${issue}:${event.action ?? "unknown"}:${REMEDIATE_LABEL}`;
}

export function isSupportedEvent(event: string): event is SupportedEvent {
  return (SUPPORTED_EVENTS as readonly string[]).includes(event);
}

/**
 * Turns a raw GitHub delivery into the shape the orchestrator works with and
 * decides whether it should be handed to the Devin client.
 *
 * Only `issues` deliveries carrying the `devin-remediate` label are actionable
 * today; everything else is acknowledged and ignored. Two deliveries are
 * special cases that dispatch nothing but do resolve existing runs:
 * `issues.closed` closes out the issue's runs, and `pull_request.closed`
 * records whether the run's pull request was merged or discarded.
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
    issueClosed: false,
    pullRequestClosed: false,
    pullRequestMerged: false,
    reason: "",
  };

  if (!isSupportedEvent(event)) {
    return { ...base, reason: "unsupported_event" };
  }

  // A closed pull request settles the run behind it: merged means the work
  // landed, closed unmerged means it was thrown away. Either way the run's
  // status stops depending on a session the poller may no longer watch.
  if (event === "pull_request" && base.action === "closed") {
    const url = asString(body.pull_request?.html_url);
    return url === undefined
      ? { ...base, reason: "pull_request_without_url" }
      : {
          ...base,
          pullRequestClosed: true,
          pullRequestUrl: url,
          pullRequestMerged: body.pull_request?.merged === true,
          reason: "pull_request_closed",
        };
  }

  if (event !== "issues") {
    return { ...base, reason: "event_not_actionable_yet" };
  }

  // A closed issue is not dispatched, but it does resolve the runs behind it:
  // the issue has been dealt with, with or without a pull request.
  if (base.action === "closed" && base.issueNumber !== undefined) {
    return { ...base, issueClosed: true, reason: "issue_closed" };
  }

  if (base.action !== "labeled") {
    return { ...base, reason: "action_not_actionable" };
  }

  const addedLabel = asString(body.label?.name);
  // Only the label this delivery added counts. Falling back to the issue's full
  // label set would make *every* later `labeled` delivery on an issue that
  // already carries `devin-remediate` actionable, which starts a second run.
  const hasRemediateLabel =
    addedLabel === undefined ? labels.includes(REMEDIATE_LABEL) : addedLabel === REMEDIATE_LABEL;

  if (!hasRemediateLabel) {
    return { ...base, reason: "label_not_matched" };
  }

  return { ...base, actionable: true, reason: "actionable", triggerKey: triggerKey(base) };
}
