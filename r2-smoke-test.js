import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
} = process.env;
console.log("ENV DEBUG:", { R2_BUCKET, R2_ENDPOINT });

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  throw new Error("Missing R2 env vars");
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const body = Buffer.from("hello from render", "utf8");

await s3.send(
  new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: "thumbs/hello.txt",
    Body: body,
    ContentType: "text/plain",
  })
);

console.log("Uploaded thumbs/hello.txt to R2 ✅");
