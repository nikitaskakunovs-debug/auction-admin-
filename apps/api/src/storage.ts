import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ApiConfig } from "./config.js";

/**
 * Item-photo storage behind one interface: local disk in dev/tests (served by
 * the API at /uploads), any S3-compatible bucket (DigitalOcean Spaces) in
 * production. Keys are server-generated (`items/<itemId>/<uuid>-web.webp` plus
 * a `-thumb` sibling); the public URL returned by put() is what gets stored on
 * the item row, so switching drivers never rewrites existing rows.
 */
export interface PhotoStorage {
  /** Persist a processed image and return its public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Best-effort delete — missing objects are not an error. */
  remove(key: string): Promise<void>;
  /** Storage key for a URL this store produced, or null for foreign URLs. */
  keyFor(url: string): string | null;
}

/** The thumbnail sibling of a web-size key/URL (same name, -thumb suffix). */
export const thumbKey = (webKey: string): string => webKey.replace(/-web\.webp$/, "-thumb.webp");

class LocalPhotoStorage implements PhotoStorage {
  private readonly root: string;
  constructor(
    dir: string,
    private readonly baseUrl: string,
  ) {
    this.root = path.resolve(dir);
  }

  private fileFor(key: string): string {
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error("storage key escapes upload root");
    return file;
  }

  async put(key: string, body: Buffer): Promise<string> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return `${this.baseUrl}/uploads/${key}`;
  }

  async remove(key: string): Promise<void> {
    await unlink(this.fileFor(key)).catch(() => undefined);
  }

  keyFor(url: string): string | null {
    const prefix = `${this.baseUrl}/uploads/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }
}

class S3PhotoStorage implements PhotoStorage {
  private readonly client: S3Client;
  constructor(private readonly cfg: NonNullable<ApiConfig["s3"]>) {
    this.client = new S3Client({
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ACL: "public-read",
        // Keys are content-unique (uuid per photo), so cache forever.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return `${this.cfg.publicUrl}/${key}`;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key })).catch(() => undefined);
  }

  keyFor(url: string): string | null {
    const prefix = `${this.cfg.publicUrl}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }
}

export function createStorage(config: ApiConfig): PhotoStorage {
  if (config.storageDriver === "s3" && config.s3) return new S3PhotoStorage(config.s3);
  return new LocalPhotoStorage(config.uploadDir, config.publicBaseUrl);
}
