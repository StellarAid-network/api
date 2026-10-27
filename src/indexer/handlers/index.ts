export interface IndexerHandler {
  readonly event: string;
  handle(payload: unknown): Promise<void>;
}

export const handlers: readonly IndexerHandler[] = [];

export { handleHelpRequestEvent } from "./help-request";
export { handleGiveawayRecord, handleGiveawayClaim } from "./giveaway";
