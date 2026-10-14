export async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const providedSignature = signature.slice(7);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computedSignature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return isTimingSafeEqual(computedSignature, providedSignature);
}

// How far a GitLab delivery's timestamp may be from the worker's clock.
const GITLAB_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks a GitLab webhook signed with its hook's signing token, the Standard
 * Webhooks way: webhook-signature lists `v1,<base64>` HMAC-SHA256s of
 * `${webhook-id}.${webhook-timestamp}.${body}`, keyed with the base64 key after
 * the secret's `whsec_`, and any one may match. A timestamp more than 5 minutes
 * off fails, so a captured delivery can't be replayed later; GitLab stamps a
 * resent one afresh.
 */
export async function verifyGitLabSignature(
  body: string,
  { id, timestamp, signature }: { id: string; timestamp: string; signature: string },
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (
    !secret.startsWith('whsec_') ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(nowMs / 1000 - Number(timestamp)) > GITLAB_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return false;
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), (char) => char.codePointAt(0)!);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCodePoint(...new Uint8Array(mac)));

  return signature.split(' ').some((entry) => entry.startsWith('v1,') && isTimingSafeEqual(entry.slice(3), expected));
}

function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.codePointAt(i)! ^ b.codePointAt(i)!;
  }

  return result === 0;
}
