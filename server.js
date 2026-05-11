// TweetPulse — server.js
// Monitors @GemisAlpha → sends all tweets + RTs to @gemtweets
// 30-second polling, 3-minute keepalive

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────
const BOT_TOKEN  = '8725848636:AAF9rTW6KtsecwpsWEoeZeM5zTya8j1Saps';
const CHAT_ID    = '@gemtweets';
const HANDLE     = 'GemisAlpha';

// FIX: hardcoded as fallback since RENDER_EXTERNAL_URL is only on paid plans
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://gemtweets.onrender.com';

const NITTER_HOSTS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
];

// ─── STATE ─────────────────────────────────────────────────
let lastTweetId = null;
let isFirstRun  = true;
let pollErrors  = 0;
let isPolling   = false;
const logs      = [];

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ─── SCRAPE VIA NITTER RSS ─────────────────────────────────
async function getLatestTweets() {
  for (const host of NITTER_HOSTS) {
    try {
      const url = `${host}/${HANDLE}/rss`;
      addLog('info', `Trying ${host}...`);

      const { data } = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        }
      });

      if (!data || !data.includes('<item>')) {
        addLog('warn', `${host} returned invalid RSS — skipping`);
        continue;
      }

      const $ = cheerio.load(data, { xmlMode: true });
      const items = [];

      $('item').each((_, el) => {
        const title   = $(el).find('title').text().trim();
        const link    = $(el).find('link').text().trim();
        const guid    = $(el).find('guid').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        items.push({ title, link, guid, pubDate });
      });

      if (!items.length) {
        addLog('warn', `${host} returned 0 items — skipping`);
        continue;
      }

      addLog('info', `Fetched ${items.length} tweets via ${host}`);
      return items;

    } catch (err) {
      addLog('warn', `${host} failed: ${err.message}`);
    }
  }

  addLog('error', 'All Nitter hosts failed this round');
  return [];
}

// ─── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      },
      { timeout: 10000 }
    );

    if (!res.data.ok) {
      addLog('error', `Telegram API error: ${JSON.stringify(res.data)}`);
    } else {
      addLog('success', 'Telegram notification sent ✅');
    }
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    addLog('error', `Telegram failed: ${detail}`);
  }
}

// ─── BUILD MESSAGE ─────────────────────────────────────────
function buildMessage(tweet) {
  const isRT    = tweet.title.startsWith('RT @');
  const isReply = tweet.title.startsWith('@');
  const icon    = isRT ? '🔁' : isReply ? '💬' : '🐦';
  const type    = isRT ? 'Retweeted' : isReply ? 'Replied' : 'New Tweet';

  const twitterLink = tweet.link.replace(/https?:\/\/nitter\.[^/]+\//, 'https://x.com/');

  return (
    `${icon} <b>@${HANDLE} — ${type}</b>\n\n` +
    `${tweet.title}\n\n` +
    `🔗 <a href="${twitterLink}">View on Twitter/X</a>\n` +
    `<i>${tweet.pubDate}</i>`
  );
}

// ─── MAIN POLL ─────────────────────────────────────────────
async function poll() {
  if (isPolling) {
    addLog('info', 'Poll skipped — previous poll still running');
    return;
  }

  isPolling = true;

  try {
    addLog('info', `Polling @${HANDLE}...`);
    const tweets = await getLatestTweets();
    if (!tweets.length) return;

    const latest = tweets[0];

    // First run: set baseline, don't notify
    if (isFirstRun) {
      lastTweetId = latest.guid;
      isFirstRun  = false;
      addLog('info', `✅ Baseline set — watching @${HANDLE} from now`);
      return;
    }

    // Nothing new
    if (lastTweetId === latest.guid) {
      addLog('info', `@${HANDLE} — no new tweets`);
      return;
    }

    // Collect new tweets since last seen
    const newTweets = [];
    for (const tweet of tweets) {
      if (tweet.guid === lastTweetId) break;
      newTweets.push(tweet);
    }

    // FIX: update lastTweetId BEFORE sending so a Telegram crash can't cause duplicates
    lastTweetId = latest.guid;

    // FIX: reverse first (oldest → newest), THEN cap at 5 to avoid wrong-order splice
    newTweets.reverse();
    if (newTweets.length > 5) {
      addLog('warn', `${newTweets.length} new tweets — capping at 5 to avoid spam`);
      newTweets.splice(0, newTweets.length - 5); // keep the 5 most recent
    }

    for (const tweet of newTweets) {
      await sendTelegram(buildMessage(tweet));
      await new Promise(r => setTimeout(r, 1500));
    }

    addLog('success', `Notified: ${newTweets.length} new tweet(s) from @${HANDLE}`);

  } finally {
    // Always release the lock, even on error
    isPolling = false;
  }
}

// ─── SAFE POLL WRAPPER ─────────────────────────────────────
async function safePoll() {
  try {
    await poll();
    pollErrors = 0;
  } catch (err) {
    pollErrors++;
    isPolling = false; // safety reset in case finally didn't fire
    addLog('error', `Unhandled poll error #${pollErrors}: ${err.message}`);
    if (pollErrors === 5) {
      await sendTelegram('⚠️ <b>TweetPulse</b>: 5 consecutive errors. Still running — check /logs.').catch(() => {});
    }
  }
}

// ─── SELF-PING KEEPALIVE (every 3 minutes) ─────────────────
function startKeepalive() {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 8000 });
      addLog('info', '🏓 Keepalive ping OK');
    } catch (err) {
      addLog('warn', `Keepalive ping failed: ${err.message}`);
    }
  }, 3 * 60 * 1000);

  addLog('info', `🏓 Keepalive active — pinging ${SELF_URL}/health every 3min`);
}

// ─── 30-SECOND POLL INTERVAL ───────────────────────────────
setInterval(safePoll, 30 * 1000);
addLog('info', '⏱ Poll interval: every 30 seconds');

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status     : 'running ✅',
    watching   : `@${HANDLE}`,
    notifying  : CHAT_ID,
    pollEvery  : '30 seconds',
    keepalive  : '3 minutes',
    lastTweetId,
    pollErrors,
    uptime     : `${Math.floor(process.uptime() / 60)} min`,
    recentLogs : logs.slice(0, 10),
  });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/logs',   (req, res) => res.json(logs));

app.post('/force-poll', async (req, res) => {
  addLog('info', 'Force poll triggered via /force-poll');
  await safePoll();
  res.json({ ok: true });
});

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  addLog('info', `🚀 TweetPulse live on port ${PORT}`);
  addLog('info', `👁  Watching @${HANDLE} → ${CHAT_ID}`);

  // First poll 5s after boot
  setTimeout(safePoll, 5000);

  // Start keepalive after 15s
  setTimeout(startKeepalive, 15000);
});

// ─── GLOBAL CRASH GUARD ────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  addLog('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  addLog('error', `Uncaught exception: ${err.message} — continuing`);
});
