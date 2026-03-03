import { createClient } from "@supabase/supabase-js";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import fs from "fs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getZoomAccessToken() {
  const creds = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: process.env.ZOOM_ACCOUNT_ID
    })
  });

  const data = await res.json();
  return data.access_token;
}

async function generateThumbnail(recording) {
  const token = await getZoomAccessToken();

  const videoPath = `/tmp/${recording.zoom_meeting_id}.mp4`;
  const outputPath = `/tmp/${recording.zoom_meeting_id}.webp`;

  const res = await fetch(recording.speaker_mp4_download_url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const fileStream = fs.createWriteStream(videoPath);

  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .setFfmpegPath(ffmpegPath)
      .screenshots({
        timestamps: ["5"],
        filename: `${recording.zoom_meeting_id}.webp`,
        folder: "/tmp",
        size: "640x?"
      })
      .on("end", resolve)
      .on("error", reject);
  });

  const fileBuffer = fs.readFileSync(outputPath);

  await supabase.storage
    .from("recording-thumbnails")
    .upload(`${recording.zoom_meeting_id}.webp`, fileBuffer, {
      contentType: "image/webp",
      upsert: true
    });

  const { data } = supabase.storage
    .from("recording-thumbnails")
    .getPublicUrl(`${recording.zoom_meeting_id}.webp`);

  await supabase
    .from("recordings")
    .update({
      thumbnail_url: data.publicUrl,
      thumbnail_status: "ready",
      thumbnail_generated_at: new Date()
    })
    .eq("zoom_meeting_id", recording.zoom_meeting_id);

  fs.unlinkSync(videoPath);
  fs.unlinkSync(outputPath);

  console.log("Thumbnail created:", recording.zoom_meeting_id);
}

async function run() {
  const { data: recordings } = await supabase
    .from("recordings")
    .select("*")
    .is("thumbnail_url", null)
    .not("speaker_mp4_download_url", "is", null)
    .limit(5);

  if (!recordings?.length) {
    console.log("No recordings need thumbnails.");
    return;
  }

  for (const rec of recordings) {
    try {
      await generateThumbnail(rec);
    } catch (err) {
      console.error("Failed:", rec.zoom_meeting_id, err.message);
    }
  }
}

run();
