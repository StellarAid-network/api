import { describe, it, expect } from "vitest";
import {
  isValidIpfsCid,
  escapeHtml,
  isAccountOldEnough,
  PostBodySchema,
  CommentBodySchema,
  MediaHashesSchema,
} from "../../src/lib/content";

describe("Content and social validation utilities", () => {
  it("validates IPFS CID formats", () => {
    // CIDv0 (Qm... 46 chars base58)
    const cidv0 = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    expect(isValidIpfsCid(cidv0)).toBe(true);

    // CIDv1 (bafy... base32)
    const cidv1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(isValidIpfsCid(cidv1)).toBe(true);

    // Invalid CIDs
    expect(isValidIpfsCid("not-a-cid")).toBe(false);
    expect(isValidIpfsCid("https://ipfs.io/ipfs/Qm123")).toBe(false);
    expect(isValidIpfsCid("")).toBe(false);
  });

  it("validates post and comment body lengths", () => {
    expect(PostBodySchema.safeParse("Hello world").success).toBe(true);
    expect(PostBodySchema.safeParse("").success).toBe(false);
    expect(PostBodySchema.safeParse("a".repeat(2001)).success).toBe(false);

    expect(CommentBodySchema.safeParse("Great request!").success).toBe(true);
    expect(CommentBodySchema.safeParse("").success).toBe(false);
    expect(CommentBodySchema.safeParse("a".repeat(501)).success).toBe(false);
  });

  it("validates media hashes limit and format", () => {
    const validCids = [
      "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    ];
    expect(MediaHashesSchema.safeParse(validCids).success).toBe(true);

    // Max 4 media hashes
    const tooMany = Array(5).fill("QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");
    expect(MediaHashesSchema.safeParse(tooMany).success).toBe(false);

    // Invalid hash inside array
    expect(MediaHashesSchema.safeParse(["invalid-cid"]).success).toBe(false);
  });

  it("escapes unsafe HTML characters on output", () => {
    const input = `<script>alert("XSS & attack")</script>`;
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;script&gt;alert(&quot;XSS &amp; attack&quot;)&lt;/script&gt;");
  });

  it("enforces account age rules", () => {
    const minAgeSeconds = 300; // 5 minutes
    const now = Date.now();

    // Account created 10 minutes ago -> old enough
    const oldAccount = new Date(now - 600 * 1000);
    expect(isAccountOldEnough(oldAccount, minAgeSeconds)).toBe(true);

    // Account created 1 minute ago -> too new
    const newAccount = new Date(now - 60 * 1000);
    expect(isAccountOldEnough(newAccount, minAgeSeconds)).toBe(false);

    // When minAgeSeconds is 0 -> always old enough
    expect(isAccountOldEnough(newAccount, 0)).toBe(true);
    expect(isAccountOldEnough(null, 0)).toBe(true);
  });
});
