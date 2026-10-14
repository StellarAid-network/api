export interface AuthedUser {
  address: string;
}

export interface Pagination {
  limit: number;
  cursor: string | null;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
