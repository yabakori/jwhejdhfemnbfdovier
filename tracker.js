const fs = require("fs");
const config = require("./config.json");

const API_KEY = process.env.YOUTUBE_API_KEY;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const NOTIFIED_FILE = "notified.json";
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

if (!API_KEY || !WEBHOOK_URL) {
  console.error("Missing YOUTUBE_API_KEY or DISCORD_WEBHOOK_URL environment variables.");
  process.exit(1);
}

// ─── Load/save notified state ─────────────────────────────────────────────────
function loadNotified() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFIED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveNotified(data) {
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(data, null, 2));
}

// ─── Get uploads playlist ID for a channel ────────────────────────────────────
async function getUploadsPlaylistId(channelId) {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    console.error(`YouTube API error for ${channelId}:`, data.error.message);
    return null;
  }
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

// ─── Get latest video IDs from uploads playlist ───────────────────────────────
async function getLatestVideoIds(playlistId) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=5&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    console.error(`YouTube API error for playlist ${playlistId}:`, data.error.message);
    return [];
  }
  return data.items?.map((item) => item.contentDetails.videoId) ?? [];
}

// ─── Batch check which videos are live (up to 50 IDs per request) ─────────────
async function getLiveVideos(videoIds) {
  const results = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const ids = batch.join(",");
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`YouTube API error checking videos:`, data.error.message);
      continue;
    }
    const live = data.items?.filter((v) => v.snippet.liveBroadcastContent === "live") ?? [];
    results.push(...live);
  }
  return results;
}

// ─── Send Discord notification ────────────────────────────────────────────────
async function sendDiscordNotification(video) {
  const { snippet } = video;
  const videoId = video.id;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const channelName = snippet.channelTitle;
  const title = snippet.title;
  const thumbnail = snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url;

  const payload = {
    embeds: [
      {
        title: `🔴 ${channelName} is Live!`,
        description: `**${title}**\n${videoUrl}`,
        url: videoUrl,
        color: 0xff0000,
        thumbnail: { url: thumbnail },
        footer: { text: "YouTube Live Tracker" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`Failed to send Discord notification: ${res.status}`);
  } else {
    console.log(`✅ Notified Discord: ${channelName} — "${title}"`);
  }
}

// ─── Check if title matches any keyword ──────────────────────────────────────
function matchesKeyword(title) {
  if (!config.keywords || config.keywords.length === 0) return true;
  const lower = title.toLowerCase();
  return config.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const notified = loadNotified();
  const now = Date.now();

  // Clean up entries older than 1 hour
  for (const videoId of Object.keys(notified)) {
    if (now - notified[videoId] > COOLDOWN_MS) {
      delete notified[videoId];
    }
  }

  console.log(`Checking ${config.channels.length} channel(s) for live streams...`);

  // Step 1 — get all playlist IDs in parallel
  const playlistEntries = await Promise.all(
    config.channels.map(async (channelId) => {
      const playlistId = await getUploadsPlaylistId(channelId);
      return { channelId, playlistId };
    })
  );

  // Step 2 — get all video IDs in parallel
  const allVideoIds = [];
  await Promise.all(
    playlistEntries.map(async ({ channelId, playlistId }) => {
      if (!playlistId) {
        console.log(`  → Could not get uploads playlist for ${channelId}`);
        return;
      }
      const ids = await getLatestVideoIds(playlistId);
      allVideoIds.push(...ids);
    })
  );

  if (allVideoIds.length === 0) {
    console.log("No videos found across all channels.");
    saveNotified(notified);
    return;
  }

  // Step 3 — batch check all video IDs at once
  console.log(`Checking ${allVideoIds.length} videos for live status...`);
  const liveVideos = await getLiveVideos(allVideoIds);

  if (liveVideos.length === 0) {
    console.log("No live streams found.");
    saveNotified(notified);
    return;
  }

  // Step 4 — notify for new live streams
  for (const video of liveVideos) {
    const title = video.snippet?.title ?? "";
    const videoId = video.id;

    if (notified[videoId]) {
      console.log(`  → Already notified for "${title}", skipping`);
      continue;
    }

    if (matchesKeyword(title)) {
      console.log(`  → LIVE and matches keyword: "${title}"`);
      await sendDiscordNotification(video);
      notified[videoId] = now;
    } else {
      console.log(`  → Live but title doesn't match keywords: "${title}"`);
    }
  }

  saveNotified(notified);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
