console.log("✅ worker starting", new Date().toISOString());
console.log("env present?", {
  hasZoom: !!process.env.ZOOM_ACCOUNT_ID,
  hasR2: !!process.env.R2_ENDPOINT,
});

import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

ffmpeg.setFfmpegPath(ffmpegPath);

const {
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,

  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE,
} = process.env;

function required(name, v) {
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

required("ZOOM_ACCOUNT_ID", ZOOM_ACCOUNT_ID);
required("ZOOM_CLIENT_ID", ZOOM_CLIENT_ID);
required("ZOOM_CLIENT_SECRET", ZOOM_CLIENT_SECRET);
required("R2_ENDPOINT", R2_ENDPOINT);
required("R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID);
required("R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY);
required("R2_BUCKET", R2_BUCKET);
required("R2_PUBLIC_BASE", R2_PUBLIC_BASE);

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function getZoomAccessToken() {
  const creds = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");

  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: ZOOM_ACCOUNT_ID,
    }),
  });

  if (!res.ok) throw new Error(`Zoom OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function listRecordings(token, days = 30) {
  const from = isoDateDaysAgo(days);
  const to = new Date().toISOString().slice(0, 10);

  const url = `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Zoom recordings list failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return Array.isArray(data.meetings) ? data.meetings : [];
}

function pickMp4File(meeting) {
  const files = Array.isArray(meeting.recording_files) ? meeting.recording_files : [];
  // Prefer speaker view-ish recordings if present, else any MP4
  const preferred = files.find(
    (f) => (f.file_type || "").toUpperCase() === "MP4" && (f.recording_type || "").includes("speaker")
  );
  const anyMp4 = files.find((f) => (f.file_type || "").toUpperCase() === "MP4");
  return preferred || anyMp4 || null;
}

async function alreadyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url, token, destPath) {
  // Zoom download URLs often work with ?access_token=... appended
  const finalUrl = url.includes("access_token=") ? url : `${url}${url.includes("?") ? "&" : "?"}access_token=${token}`;

  const res = await fetch(finalUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${await res.text()}`);

  const fileStream = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

async function makeThumbnailJpg(inputMp4, outputJpg) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputMp4)
      .outputOptions(["-frames:v 1"])
      .seekInput(5)
      .output(outputJpg)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function uploadToR2(key, filePath) {
  const body = fs.readFileSync(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: "image/jpeg",
    })
  );
}

async function run() {
  console.log("Starting thumbnail job", { bucket: R2_BUCKET, endpoint: R2_ENDPOINT });

  const token = await getZoomAccessToken();
  const meetings = await listRecordings(token, 30);

  console.log(`Found ${meetings.length} meetings`);

  let done = 0;

  for (const m of meetings) {
    const meetingId = String(m.uuid || m.id || "").trim();
    if (!meetingId) continue;

    const file = pickMp4File(m);
    if (!file?.download_url) continue;

    const key = `thumbs/${meetingId}.jpg`;

    if (await alreadyExists(key)) {
      // Skip if you want idempotent runs
      continue;
    }

    const mp4Path = `/tmp/${meetingId}.mp4`;
    const jpgPath = `/tmp/${meetingId}.jpg`;

    try {
      console.log("Processing", { meetingId, topic: (m.topic || "").slice(0, 50) });

      await downloadToFile(file.download_url, token, mp4Path);
      await makeThumbnailJpg(mp4Path, jpgPath);
      await uploadToR2(key, jpgPath);

      console.log("✅ Uploaded", `${R2_PUBLIC_BASE}/${key}`);
      done++;
      if (done >= 5) break; // keep runs small while testing
    } catch (e) {
      console.error("❌ Failed", meetingId, e?.message || e);
    } finally {
      try { fs.unlinkSync(mp4Path); } catch {}
      try { fs.unlinkSync(jpgPath); } catch {}
    }
  }

  console.log(`Finished. Generated ${done} thumbnail(s).`);
}

run().catch((e) => {
  console.error("Fatal error:", e?.message || e);
  process.exit(1);
});
