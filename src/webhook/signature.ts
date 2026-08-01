import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Computes the `sha256=<hex>` signature GitHub sends for a raw delivery body.
 */
export function computeSignature(secret: string, payload: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Constant-time comparison of the received signature against the expected one.
 */
export function verifySignature(
  secret: string,
  payload: Buffer | string,
  signature: string | undefined,
): boolean {
  if (!secret || !signature) {
    return false;
  }

  const expected = Buffer.from(computeSignature(secret, payload), "utf8");
  const received = Buffer.from(signature, "utf8");

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
