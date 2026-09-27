/**
 * The object-storage seam.
 *
 * `@vercel/sandbox` and the S3 client are the two SDKs this package is allowed to
 * talk to, and only through one file each. Keeping the bucket behind an interface
 * means the mirror's path and consistency rules can be tested without an account,
 * which matters because those rules are what keep a cold project's file tree from
 * being read as if it were the live one.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  key: string;
  size: number;
}

export interface ObjectStore {
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<void>;
  /** `null` when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** All keys under `prefix`, without the prefix stripped. */
  list(prefix: string): Promise<StoredObject[]>;
  deletePrefix(prefix: string): Promise<void>;
  copy(sourceKey: string, targetKey: string): Promise<void>;
}

/** R2 speaks the S3 API, so the standard client needs only a custom endpoint. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(deps: { client: S3Client; bucket: string }) {
    this.client = deps.client;
    this.bucket = deps.bucket;
  }

  static forR2(deps: {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }): S3ObjectStore {
    return new S3ObjectStore({
      bucket: deps.bucket,
      client: new S3Client({
        region: "auto",
        endpoint: `https://${deps.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: deps.accessKeyId,
          secretAccessKey: deps.secretAccessKey,
        },
        // R2 has no concept of a bucket location constraint; keeping the force
        // flag set avoids a pre-flight redirect on every request.
        forcePathStyle: true,
      }),
    });
  }

  async put(key: string, body: string | Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0 };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0 });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async deletePrefix(prefix: string): Promise<void> {
    const objects = await this.list(prefix);
    // Batched in chunks of 1000, which is the maximum a single request accepts.
    for (let offset = 0; offset < objects.length; offset += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects.slice(offset, offset + 1000).map((object) => ({ Key: object.key })) },
        })
      );
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({ Bucket: this.bucket, Key: targetKey, CopySource: `${this.bucket}/${sourceKey}` })
    );
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.Code === "NoSuchKey" ||
    candidate.Code === "404" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
