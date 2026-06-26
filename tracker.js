const config = require("./config.json");

const API_KEY = process.env.YOUTUBE_API_KEY;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!API_KEY || !WEBHOOK_URL) {
  console.error("Missing YOUTUBE_API_KEY or DISCORD_WEBHOOK_URL environment variables.");
  process.exit(1);
}

// ─── Fetch live videos for a channel ─────────────────────────────────────────
async function getLiveStreams(channelId) {
  // Use videos.list with liveBroadcastContent=live — costs ~5 units vs 100 for search
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    console.error(`YouTube API error for ${channelId}:`, data.error.message);
    return [];
  }

  return data.items ?? [];
}

// ─── Send Discord notification ────────────────────────────────────────────────
async function sendDiscordNotification(stream) {
  const { snippet } = stream;
  const videoId = stream.id.videoId;
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
  // If no keywords set, match everything
  if (!config.keywords || config.keywords.length === 0) return true;
  const lower = title.toLowerCase();
  return config.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}
async function sendTestMessage() {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "✅ Tracker ran successfully!" }),
  });
  if (!res.ok) {
    console.error(`Failed to send test message: ${res.status}`);
  } else {
    console.log("✅ Test message sent to Discord");
  }
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Checking ${config.channels.length} channel(s) for live streams...`);

  for (const channelId of config.channels) {
    console.log(`Checking channel: ${channelId}`);
    const streams = await getLiveStreams(channelId);

    if (streams.length === 0) {
      console.log(`  → Not live`);
      continue;
    }

    for (const stream of streams) {
      const title = stream.snippet?.title ?? "";
      if (matchesKeyword(title)) {
        console.log(`  → LIVE and matches keyword: "${title}"`);
        await sendDiscordNotification(stream);
      } else {
        console.log(`  → Live but title doesn't match keywords: "${title}"`);
      }
    }
  }

  console.log("Done.");
}
sendTestMessage().then(() => main()).catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
