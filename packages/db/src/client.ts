import "dotenv/config";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.NODE_ENV !== "test") {
  console.warn("[@dai/db] DATABASE_URL is not set;");
}

export const pool = new Pool({ connectionString, max: 20 });

export interface DbError extends Error {
  code?: string;
}

export async function query<T = any>(
  text: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  try {
    const res = await pool.query(text, params as any);
    return { rows: res.rows as T[] };
  } catch (e: any) {
    const err: DbError = new Error(e.message ?? "DB error");
    err.code = e.code;
    throw err;
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

