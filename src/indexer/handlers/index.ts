export interface IndexerHandler {
  readonly event: string;
  handle(payload: unknown): Promise<void>;
}

export const handlers: readonly IndexerHandler[] = [];
