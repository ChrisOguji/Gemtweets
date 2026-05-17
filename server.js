// TweetPulse + SniperBot — server.js v4
// @GemisAlpha monitor → Telegram + Solana auto-buy (40% wallet) + auto-sell 5x/8x
// Fixes: persisted lastTweetId (no spam on restart), Twitter guest token (no 429)

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const {
  Connection, Keypair, PublicKey,
  VersionedTransaction, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58       = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────
const BOT_TOKEN    = '8725848636:AAF9rTW6KtsecwpsWEoeZeM5zTya8j1Saps';
const CHAT_ID      = '@gemtweets';
const HANDLE       = 'GemisAlpha';
const SELF_URL     = process.env.RENDER_EXTERNAL_URL || 'https://gemtweets-ne38.onrender.com';
const STATE_FILE   = path.join('/tmp', 'tweetpulse_state.json'); // persists across soft restarts

const DEVNET       = true; // ← set false for mainnet
const RPC_URL      = DEVNET
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';

const BUY_PCT      = 0.40;    // 40% of wallet per trade
const SLIPPAGE_BPS = 1500;    // 15%
const SELL_HALF_X  = 5;       // sell 50% at 5x
const SELL_ALL_X   = 8;       // sell all at 8x
const MAX_MCAP_USD = 56000;   // skip if mcap > $56k
const WSOL         = 'So11111111111111111111111111111111111111112';
const JUPITER_API  = 'https://quote-api.jup.ag/v6';

// ─── WALLET ────────────────────────────────────────────────
let wallet = null;
try {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY not set in env');
  wallet = Keypair.fromSecretKey(bs58.decode(raw));
  console.log(`[INFO] Wallet: ${wallet.publicKey.toBase58()}`);
} catch (err) {
  console.error(`[ERROR] Wallet load failed: ${err.message}`);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ─── PERSISTENT STATE ──────────────────────────────────────
// Saves lastTweetId to /tmp so restarts don't re-process old tweets
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      addLog('info', `State loaded: lastTweetId = ${data.lastTweetId}`);
      return data;
    }
  } catch (err) {
    addLog('warn', `State load failed: ${err.message}`);
  }
  return { lastTweetId: null };
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTweetId }, 'utf8'));
  } catch (err) {
    addLog('warn', `State save failed: ${err.message}`);
  }
}

// ─── APP STATE ─────────────────────────────────────────────
let lastTweetId  = null;
let isFirstRun   = true;
let pollErrors   = 0;
let isPolling    = false;
let guestToken   = null;
let guestTokenTs = 0;
const positions  = {};
const logs       = [];

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// Load persisted lastTweetId on startup
const savedState = loadState();
if (savedState.lastTweetId) {
  lastTweetId = savedState.lastTweetId;
  isFirstRun  = false; // already have baseline, skip spam
  addLog('info', `Resumed from saved state — lastTweetId: ${lastTweetId}`);
}

// ─── TWITTER GUEST TOKEN ───────────────────────────────────
// Gets a short-lived guest token from Twitter (no auth needed, avoids 429)
async function getGuestToken() {
  const now = Date.now();
  // Reuse token for 30 minutes
  if (guestToken && (now - guestTokenTs) < 30 * 60 * 1000) return guestToken;

  try {
    const res = await axios.post('https://api.twitter.com/1.1/guest/activate.json', null, {
      headers: {
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 8000,
    });
    guestToken   = res.data.guest_token;
    guestTokenTs = now;
    addLog('info', `Guest token refreshed`);
    return guestToken;
  } catch (err) {
    addLog('warn', `Guest token failed: ${err.message}`);
    return null;
  }
}

// ─── TWITTER API (real-time via guest token) ───────────────
async function getTwitterTweets() {
  const token = await getGuestToken();
  if (!token) throw new Error('No guest token');

  const res = await axios.get(
    `https://api.twitter.com/1.1/statuses/user_timeline.json`, {
      params: {
        screen_name     : HANDLE,
        count           : 20,
        tweet_mode      : 'extended',
        include_rts     : 1,
        exclude_replies : 0,
      },
      headers: {
        'Authorization' : 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-guest-token' : token,
        'User-Agent'    : 'Mozilla/5.0',
      },
      timeout: 10000,
    }
  );

  const tweets = res.data.map(t => ({
    guid    : t.id_str,
    title   : t.full_text || t.text || '',
    pubDate : t.created_at,
    link    : `https://x.com/${HANDLE}/status/${t.id_str}`,
    desc    : t.full_text || t.text || '',
  }));

  addLog('info', `Twitter API: fetched ${tweets.length} tweets`);
  return tweets;
}

// ─── NITTER FALLBACK ───────────────────────────────────────
const NITTER_HOSTS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
];

async function getNitterTweets() {
  const cheerio = require('cheerio');
  for (const host of NITTER_HOSTS) {
    try {
      const { data } = await axios.get(`${host}/${HANDLE}/rss`, {
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml' }
      });

      if (!data || !data.includes('<item>')) continue;

      const $     = cheerio.load(data, { xmlMode: true });
      const items = [];
      $('item').each((_, el) => {
        items.push({
          guid    : $(el).find('guid').text().trim(),
          title   : $(el).find('title').text().trim(),
          pubDate : $(el).find('pubDate').text().trim(),
          link    : $(el).find('link').text().trim().replace(/https?:\/\/nitter\.[^/]+\//, 'https://x.com/'),
          desc    : $(el).find('description').text().trim(),
        });
      });

      if (items.length) {
        addLog('info', `Nitter: ${items.length} tweets via ${host}`);
        return items;
      }
    } catch (err) {
      addLog('warn', `Nitter ${host}: ${err.message}`);
    }
  }
  return [];
}

// ─── UNIFIED TWEET FETCHER ─────────────────────────────────
async function getLatestTweets() {
  try {
    const tweets = await getTwitterTweets();
    if (tweets.length) return tweets;
  } catch (err) {
    addLog('warn', `Twitter API failed: ${err.message} — trying Nitter`);
  }
  return getNitterTweets();
}

// ─── CA DETECTOR ───────────────────────────────────────────
function extractCAs(text) {
  const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return matches.filter(m => {
    try { new PublicKey(m); return true; } catch { return false; }
  });
}

// ─── DEXSCREENER MCAP ──────────────────────────────────────
async function getMcap(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = res.data?.pairs;
    if (!pairs?.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best?.fdv || best?.marketCap || null;
  } catch { return null; }
}

// ─── WALLET SOL BALANCE ────────────────────────────────────
async function getWalletSOL() {
  try {
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

// ─── TOKEN BALANCE ─────────────────────────────────────────
async function getTokenBalance(mint) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
    const bal = await connection.getTokenAccountBalance(ata);
    return parseInt(bal.value.amount);
  } catch { return 0; }
}

// ─── TOKEN PRICE ───────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`https://price.jup.ag/v4/price?ids=${mint}`, { timeout: 8000 });
    return res.data?.data?.[mint]?.price || 0;
  } catch { return 0; }
}

// ─── JUPITER BUY ───────────────────────────────────────────
async function jupiterBuy(mint, solAmount) {
  if (!wallet) throw new Error('Wallet not loaded');
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  addLog('info', `Jupiter buy: ${solAmount.toFixed(4)} SOL → ${mint}`);

  const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
    params: { inputMint: WSOL, outputMint: mint, amount: lamports, slippageBps: SLIPPAGE_BPS },
    timeout: 10000,
  });
  const quote = quoteRes.data;
  if (!quote?.outAmount) throw new Error('No quote from Jupiter');

  const swapRes = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: 1000000, priorityLevel: 'veryHigh' }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No swap tx from Jupiter');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Buy confirmed: ${txid}`);
  return { txid, outAmount: parseInt(quote.outAmount) };
}

// ─── JUPITER SELL ───────────────────────────────────────────
async function jupiterSell(mint, amountTokens) {
  if (!wallet) throw new Error('Wallet not loaded');
  addLog('info', `Jupiter sell: ${amountTokens} tokens → SOL`);

  const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
    params: { inputMint: mint, outputMint: WSOL, amount: amountTokens, slippageBps: SLIPPAGE_BPS },
    timeout: 10000,
  });
  const quote = quoteRes.data;
  if (!quote?.outAmount) throw new Error('No sell quote from Jupiter');

  const swapRes = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: 1000000, priorityLevel: 'veryHigh' }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No sell tx from Jupiter');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Sell confirmed: ${txid}`);
  return { txid, solReceived: parseInt(quote.outAmount) };
}

// ─── HANDLE CA ─────────────────────────────────────────────
async function handleCA(mint) {
  if (positions[mint]) {
    addLog('info', `Already in position: ${mint.slice(0,8)}... — skipping`);
    return;
  }

  addLog('info', `CA found: ${mint} — checking mcap...`);

  // Mcap check first — silent
  const mcap = await getMcap(mint);
  if (mcap !== null && mcap > MAX_MCAP_USD) {
    addLog('warn', `Mcap $${mcap.toLocaleString()} > limit — skipping`);
    await sendTelegram(
      `⚠️ <b>CA Skipped — Mcap Too High</b>\n\n` +
      `<code>${mint}</code>\n` +
      `Mcap: $${mcap.toLocaleString()} (limit: $${MAX_MCAP_USD.toLocaleString()})`
    );
    return;
  }

  // Get 40% of wallet
  const solBalance = await getWalletSOL();
  const buyAmount  = parseFloat((solBalance * BUY_PCT).toFixed(6));

  if (buyAmount < 0.001) {
    await sendTelegram(`⚠️ <b>Wallet too low</b>: ${solBalance.toFixed(4)} SOL — skipping`);
    return;
  }

  const mcapStr = mcap ? `$${mcap.toLocaleString()}` : 'unverified';
  await sendTelegram(
    `🎯 <b>CA Detected from @${HANDLE}</b>\n\n` +
    `<code>${mint}</code>\n\n` +
    `Mcap: ${mcapStr}\n` +
    `💸 Buying <b>${buyAmount} SOL</b> (40% of wallet)\n` +
    `${DEVNET ? '🧪 DEVNET MODE' : '🔴 MAINNET'}`
  );

  try {
    const buyPrice            = await getTokenPrice(mint);
    const { txid, outAmount } = await jupiterBuy(mint, buyAmount);

    positions[mint] = {
      buyPrice : buyPrice || 0.000001,
      amount   : outAmount,
      halfSold : false,
      allSold  : false,
      buyTx    : txid,
      buyTime  : Date.now(),
      solSpent : buyAmount,
    };

    await sendTelegram(
      `✅ <b>Buy Confirmed!</b>\n\n` +
      `CA: <code>${mint}</code>\n` +
      `SOL spent: <b>${buyAmount} SOL</b>\n` +
      `Tokens: ${outAmount.toLocaleString()}\n` +
      `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>\n\n` +
      `🎯 Auto-sell: 50% @ ${SELL_HALF_X}x | 100% @ ${SELL_ALL_X}x`
    );

  } catch (err) {
    addLog('error', `Buy failed: ${err.message}`);
    await sendTelegram(`❌ <b>Buy Failed</b>\n\nCA: <code>${mint}</code>\nError: ${err.message}`);
    delete positions[mint];
  }
}

// ─── PRICE MONITOR ─────────────────────────────────────────
async function monitorPositions() {
  const mints = Object.keys(positions);
  if (!mints.length) return;

  for (const mint of mints) {
    const pos = positions[mint];
    if (pos.allSold) { delete positions[mint]; continue; }

    try {
      const currentPrice = await getTokenPrice(mint);
      if (!currentPrice || !pos.buyPrice) continue;

      const multiplier = currentPrice / pos.buyPrice;
      addLog('info', `${mint.slice(0,8)}...: ${multiplier.toFixed(2)}x`);

      if (multiplier >= SELL_HALF_X && !pos.halfSold) {
        const balance = await getTokenBalance(mint);
        const sellAmt = Math.floor(balance / 2);
        if (sellAmt > 0) {
          const { txid, solReceived } = await jupiterSell(mint, sellAmt);
          pos.halfSold = true;
          await sendTelegram(
            `🎯 <b>${SELL_HALF_X}x Hit — Sold 50%</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>\n` +
            `⏳ Holding rest until ${SELL_ALL_X}x...`
          );
        }
      }

      if (multiplier >= SELL_ALL_X && pos.halfSold && !pos.allSold) {
        const balance = await getTokenBalance(mint);
        if (balance > 0) {
          const { txid, solReceived } = await jupiterSell(mint, balance);
          pos.allSold = true;
          await sendTelegram(
            `🚀 <b>${SELL_ALL_X}x Hit — Sold All!</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `Profit: ~${((solReceived / LAMPORTS_PER_SOL) - pos.solSpent).toFixed(4)} SOL\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>`
          );
          delete positions[mint];
        }
      }
    } catch (err) {
      addLog('error', `Price monitor ${mint.slice(0,8)}...: ${err.message}`);
    }
  }
}

// ─── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: false },
      { timeout: 10000 }
    );
    if (!res.data.ok) addLog('error', `Telegram: ${JSON.stringify(res.data)}`);
    else addLog('success', 'Telegram sent ✅');
  } catch (err) {
    addLog('error', `Telegram: ${err.response?.data?.description || err.message}`);
  }
}

// ─── BUILD MESSAGE ─────────────────────────────────────────
function buildMessage(tweet) {
  const isRT    = tweet.title.startsWith('RT @');
  const isReply = tweet.title.startsWith('@');
  const icon    = isRT ? '🔁' : isReply ? '💬' : '🐦';
  const type    = isRT ? 'Retweeted' : isReply ? 'Replied' : 'New Tweet';
  return (
    `${icon} <b>@${HANDLE} — ${type}</b>\n\n` +
    `${tweet.title}\n\n` +
    `🔗 <a href="${tweet.link}">View on Twitter/X</a>\n` +
    `<i>${tweet.pubDate}</i>`
  );
}

// ─── MAIN POLL ─────────────────────────────────────────────
async function poll() {
  if (isPolling) { addLog('info', 'Poll skipped — still running'); return; }
  isPolling = true;

  try {
    const tweets = await getLatestTweets();
    if (!tweets.length) return;

    const latest = tweets[0];

    // First run with no saved state — set baseline silently
    if (isFirstRun) {
      lastTweetId = latest.guid;
      isFirstRun  = false;
      saveState();
      addLog('info', `✅ Baseline set: ${lastTweetId}`);
      return;
    }

    if (lastTweetId === latest.guid) {
      addLog('info', `No new tweets from @${HANDLE}`);
      return;
    }

    // Collect new tweets
    const newTweets = [];
    for (const tweet of tweets) {
      if (tweet.guid === lastTweetId) break;
      newTweets.push(tweet);
    }

    // Update and persist BEFORE sending (prevent duplicates on crash)
    lastTweetId = latest.guid;
    saveState();

    newTweets.reverse(); // oldest first
    if (newTweets.length > 5) newTweets.splice(0, newTweets.length - 5);

    for (const tweet of newTweets) {
      await sendTelegram(buildMessage(tweet));

      const cas = extractCAs(`${tweet.title} ${tweet.desc || ''}`);
      if (cas.length) {
        addLog('info', `Found ${cas.length} CA(s): ${cas.join(', ')}`);
        for (const ca of cas) await handleCA(ca);
      }

      await new Promise(r => setTimeout(r, 800));
    }

    addLog('success', `Processed ${newTweets.length} tweet(s)`);

  } finally {
    isPolling = false;
  }
}

// ─── SAFE POLL ─────────────────────────────────────────────
async function safePoll() {
  try {
    await poll();
    pollErrors = 0;
  } catch (err) {
    pollErrors++;
    isPolling = false;
    addLog('error', `Poll error #${pollErrors}: ${err.message}`);
    if (pollErrors === 5) {
      await sendTelegram('⚠️ <b>TweetPulse</b>: 5 consecutive errors. Still running.').catch(() => {});
    }
  }
}

// ─── KEEPALIVE ─────────────────────────────────────────────
function startKeepalive() {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 8000 });
      addLog('info', '🏓 Keepalive OK');
    } catch (err) {
      addLog('warn', `Keepalive: ${err.message}`);
    }
  }, 3 * 60 * 1000);
  addLog('info', `🏓 Keepalive → every 3min`);
}

// ─── INTERVALS ─────────────────────────────────────────────
setInterval(safePoll,         15 * 1000); // poll every 15s
setInterval(monitorPositions, 20 * 1000); // price check every 20s

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status        : 'running ✅',
  mode          : DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴',
  watching      : `@${HANDLE}`,
  notifying     : CHAT_ID,
  wallet        : wallet?.publicKey.toBase58() || 'NOT LOADED',
  pollEvery     : '15 seconds',
  maxMcap       : `$${MAX_MCAP_USD.toLocaleString()}`,
  buyPct        : '40% of wallet',
  openPositions : Object.keys(positions).length,
  positions,
  lastTweetId,
  pollErrors,
  uptime        : `${Math.floor(process.uptime() / 60)} min`,
  recentLogs    : logs.slice(0, 15),
}));

app.get('/health',    (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/logs',      (req, res) => res.json(logs));
app.get('/positions', (req, res) => res.json(positions));

app.post('/force-poll', async (req, res) => {
  await safePoll();
  res.json({ ok: true });
});

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog('info', `🚀 TweetPulse v4 on port ${PORT}`);
  addLog('info', `Mode: ${DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴'}`);
  addLog('info', `Wallet: ${wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️'}`);
  addLog('info', `Buy: 40% of wallet | Max mcap: $${MAX_MCAP_USD.toLocaleString()}`);
  setTimeout(safePoll,       5000);
  setTimeout(startKeepalive, 15000);
});

// ─── CRASH GUARD ───────────────────────────────────────────
process.on('unhandledRejection', r => addLog('error', `Unhandled rejection: ${r}`));
process.on('uncaughtException',  e => addLog('error', `Uncaught exception: ${e.message} — continuing`));
