import crypto from "node:crypto";

/**
 * Encryption at rest for third-party credentials — right now, Immich API keys.
 *
 * An Immich API key is a skeleton key to somebody's entire photo library, and
 * this app has no accounts to hang a per-user secret off. So we derive one key
 * from SESSION_SECRET (which the operator already has to set and keep safe) and
 * seal each credential with AES-256-GCM. A dump of the database on its own is
 * useless; you need the .env too.
 *
 * Node built-ins live here, which is why this module is a subpath export and
 * not part of the package index — importing it from a client component would
 * break the browser bundle.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
/** Domain separation, so this key can never collide with cookie signing. */
const KEY_INFO = "vlogbuddy:immich-api-key";
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

function keyFrom(secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set (at least 16 characters) to store credentials");
  }
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(secret, KEY_INFO, 32);
  }
  return cachedKey;
}

/** Returns `v1:<iv>:<tag>:<ciphertext>`, all base64url. */
export function sealSecret(plaintext: string, secret: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(":");
}

export function openSecret(sealed: string, secret: string): string {
  const [version, ivPart, tagPart, dataPart] = sealed.split(":");
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error("Stored credential is malformed");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    keyFrom(secret),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Almost always means SESSION_SECRET changed since the key was saved.
    throw new Error("Couldn't read that saved credential — reconnect your Immich account");
  }
}

/** Last four characters, for showing which key is stored without revealing it. */
export function secretHint(plaintext: string): string {
  return plaintext.length <= 4 ? "••••" : `••••${plaintext.slice(-4)}`;
}
