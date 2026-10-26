/**
 * JWT helpers for session tokens.
 */

import jwt from "jsonwebtoken";

export interface SessionPayload {
  sub: string; // Stellar address
  iat?: number;
  exp?: number;
}

export function signToken(
  address: string,
  secret: string,
  expiresIn: string,
): string {
  return jwt.sign({ sub: address }, secret, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string, secret: string): SessionPayload {
  const payload = jwt.verify(token, secret) as SessionPayload;
  return payload;
}
