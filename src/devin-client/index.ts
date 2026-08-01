/**
 * Thin wrapper around the Devin V3 API.
 *
 * Planned for a follow-up session:
 * - createSession / getSession / sendMessage / listSessions
 * - authentication via DEVIN_API_KEY (+ DEVIN_ORG_ID)
 * - retries, rate limiting and typed responses
 */
export interface DevinClientOptions {
  apiKey: string;
  baseUrl?: string;
  orgId?: string;
}

export class DevinClient {
  constructor(private readonly options: DevinClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl ?? "https://api.devin.ai/v1";
  }
}
