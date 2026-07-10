import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(secret("OAUTH_ENCRYPTION_KEY")).digest();
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Malformed encrypted value.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function signPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret("SESSION_SECRET"))
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyPayload<T>(value: string): T | null {
  const [encoded, supplied] = value.split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", secret("SESSION_SECRET"))
    .update(encoded)
    .digest();
  const suppliedBuffer = Buffer.from(supplied, "base64url");
  if (expected.length !== suppliedBuffer.length || !timingSafeEqual(expected, suppliedBuffer)) {
    return null;
  }
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
