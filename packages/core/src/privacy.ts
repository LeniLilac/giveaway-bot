import { createHmac } from "node:crypto";

/** Private database key for deletion fencing; never expose this value publicly. */
export function privacyFenceHash(secret: string, userId: string): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Privacy hash secret must contain at least 32 bytes.");
  }
  if (!userId) throw new Error("User ID is required.");
  return createHmac("sha256", secret)
    .update("lilac-privacy-fence/v1:")
    .update(userId)
    .digest("hex");
}
