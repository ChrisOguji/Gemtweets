// TweetPulse + SniperBot — server.js v3
// @GemisAlpha monitor → Telegram + Solana auto-buy (40% wallet) + auto-sell 5x/8x
// Real-time Twitter syndication API (no Nitter delay), $56k mcap filter, anti-MEV

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
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
const BOT_TOKEN      = '8725848636:AAF9rTW6KtsecwpsWEoeZeM5zTya8j1Saps';
const CHAT_ID        = '@gemtweets';
const HANDLE         = 'GemisAlpha';
const TWITTER_ID     = '';  // fetched automatically on start
const SELF_URL       = process.env.RENDER_EXTERNAL_URL || 'https://gemtweets-ne38.onrender.com';

const DEVNET         = true; // ← set false for mainnet
const RPC_URL        = DEVNET
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';

const BUY_PCT        = 0.40;   // buy with 40% of SOL balance
const SLIPPAGE_BPS   = 1500;   // 15%
const SELL_HALF_X    = 5;      // sell 50% at 5x
const SELL_ALL_X     = 8;      // sell 100% at 8x
const MAX_MCAP_USD   = 56000;  // skip if mcap > $56k
const WSOL           = 'So11111111111111111111111111111111111111112';
const JUPITER_API    = 'https://quote-api.jup.ag/v6';

// ─── WALLET ────────────────────────────────────────────────
let wallet = null;
try {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY not set in env');
  // bs58 v4 compatible decode
  wallet = Keypair.fromSecretKey(bs58.decode(raw));
  console.log(`[INFO] Wallet: ${wallet.publicKey.toBase58()}`);
} catch (err) {
  console.error(`[ERROR] Wallet load failed: ${err.message}`);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ─── STATE ─────────────────────────────────────────────────
let lastTweetId  = null;
let isFirstRun   = true;
let pollErrors   = 0;
let isPolling    = false;
const positions  = {}; // { [mint]: { buyPrice, amount, halfSold, allSold, buyTx } }
const logs       = [];

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ─── TWITTER SYNDICATION API (real-time, no Nitter lag) ────
// This endpoint is what Twitter uses internally for embeds — no auth, near-instant
async function getLatestTweets() {
  try {
    // Fetch timeline via syndication (fastest public method, ~10s delay vs Nitter's 5-10min)
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${HANDLE}?t=${Date.now()}`;
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
        'Referer': 'https://twitter.com/',
      }
    });

    // Parse the JSON embedded in the HTML response
    const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Could not find __NEXT_DATA__ in syndication response');

    const json     = JSON.parse(match[1]);
    const timeline = json?.props?.pageProps?.timeline?.entries || [];

    const tweets = timeline
      .filter(e => e?.content?.tweet)
      .map(e => {
        const t = e.content.tweet;
        return {
          guid    : t.id_str,
          title   : t.full_text || t.text || '',
          pubDate : t.created_at,
          link    : `https://x.com/${HANDLE}/status/${t.id_str}`,
          desc    : t.full_text || t.text || '',
        };
      });

    addLog('info', `Syndication: fetched ${tweets.length} tweets`);
    return tweets;

  } catch (synErr) {
    addLog('warn', `Syndication failed: ${synErr.message} — falling back to Nitter`);
    return getNitterTweets();
  }
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
      const url = `${host}/${HANDLE}/rss`;
      addLog('info', `Nitter fallback: trying ${host}...`);
      const { data } = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/rss+xml, text/xml, */*',
        }
      });

      if (!data || !data.includes('<item>')) continue;

      const $     = cheerio.load(data, { xmlMode: true });
      const items = [];
      $('item').each((_, el) => {
        items.push({
          title  : $(el).find('title').text().trim(),
          link   : $(el).find('link').text().trim().replace(/https?:\/\/nitter\.[^/]+\//, 'https://x.com/'),
          guid   : $(el).find('guid').text().trim(),
          pubDate: $(el).find('pubDate').text().trim(),
          desc   : $(el).find('description').text().trim(),
        });
      });

      if (items.length) {
        addLog('info', `Nitter: fetched ${items.length} tweets via ${host}`);
        return items;
      }
    } catch (err) {
      addLog('warn', `Nitter ${host} failed: ${err.message}`);
    }
  }
  addLog('error', 'All sources failed');
  return [];
}

// ─── CA DETECTOR ───────────────────────────────────────────
function extractCAs(text) {
  const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return matches.filter(m => {
    try {
      new PublicKey(m); // throws if invalid
      return true;
    } catch {
      return false;
    }
  });
}

// ─── DEXSCREENER MCAP CHECK ────────────────────────────────
async function getMcap(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeout: 8000
    });
    const pairs = res.data?.pairs;
    if (!pairs || !pairs.length) return null;
    // Get highest liquidity pair
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best?.fdv || best?.marketCap || null;
  } catch {
    return null;
  }
}

// ─── GET WALLET SOL BALANCE ────────────────────────────────
async function getWalletSOL() {
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    return bal / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

// ─── GET TOKEN BALANCE ─────────────────────────────────────
async function getTokenBalance(mint) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
    const bal = await connection.getTokenAccountBalance(ata);
    return parseInt(bal.value.amount);
  } catch {
    return 0;
  }
}

// ─── GET TOKEN PRICE ───────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    // Jupiter price API v4 (current working endpoint)
    const res = await axios.get(`https://price.jup.ag/v4/price?ids=${mint}`, { timeout: 8000 });
    return res.data?.data?.[mint]?.price || 0;
  } catch {
    return 0;
  }
}

// ─── JUPITER BUY ───────────────────────────────────────────
async function jupiterBuy(mint, solAmount) {
  if (!wallet) throw new Error('Wallet not loaded');

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  addLog('info', `Jupiter buy: ${solAmount.toFixed(4)} SOL → ${mint}`);

  const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
    params: {
      inputMint:   WSOL,
      outputMint:  mint,
      amount:      lamports,
      slippageBps: SLIPPAGE_BPS,
    },
    timeout: 10000,
  });

  const quote = quoteRes.data;
  if (!quote?.outAmount) throw new Error('No quote returned from Jupiter');

  const swapRes = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    // Anti-MEV: priority fees
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports:   1000000,
        priorityLevel: 'veryHigh',
      }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No swap transaction from Jupiter');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Buy confirmed: ${txid}`);
  return { txid, outAmount: parseInt(quote.outAmount) };
}

// ─── JUPITER SELL ───────────────────────────────────────────
async function jupiterSell(mint, amountTokens) {
  if (!wallet) throw new Error('Wallet not loaded');

  addLog('info', `Jupiter sell: ${amountTokens} tokens of ${mint.slice(0,8)}...`);

  const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
    params: {
      inputMint:   mint,
      outputMint:  WSOL,
      amount:      amountTokens,
      slippageBps: SLIPPAGE_BPS,
    },
    timeout: 10000,
  });

  const quote = quoteRes.data;
  if (!quote?.outAmount) throw new Error('No sell quote from Jupiter');

  const swapRes = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports:   1000000,
        priorityLevel: 'veryHigh',
      }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No sell transaction from Jupiter');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
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

  // 1. Mcap check FIRST (silent — no Telegram noise before we decide)
  const mcap = await getMcap(mint);
  if (mcap !== null && mcap > MAX_MCAP_USD) {
    addLog('warn', `Mcap $${mcap.toLocaleString()} > $${MAX_MCAP_USD.toLocaleString()} — skipping`);
    await sendTelegram(
      `⚠️ <b>CA Skipped — Mcap Too High</b>\n\n` +
      `<code>${mint}</code>\n` +
      `Mcap: $${mcap.toLocaleString()} (limit $${MAX_MCAP_USD.toLocaleString()})`
    );
    return;
  }

  // 2. Get 40% of wallet balance
  const solBalance = await getWalletSOL();
  const buyAmount  = parseFloat((solBalance * BUY_PCT).toFixed(6));

  if (buyAmount < 0.001) {
    addLog('warn', `Wallet too low: ${solBalance} SOL — skipping buy`);
    await sendTelegram(`⚠️ <b>Wallet balance too low</b>: ${solBalance.toFixed(4)} SOL`);
    return;
  }

  const mcapStr = mcap ? `$${mcap.toLocaleString()}` : 'unknown';
  addLog('info', `Buying ${buyAmount} SOL (40% of ${solBalance.toFixed(4)}) | Mcap: ${mcapStr}`);

  await sendTelegram(
    `🎯 <b>CA Detected from @${HANDLE}</b>\n\n` +
    `<code>${mint}</code>\n\n` +
    `Mcap: ${mcapStr}\n` +
    `💸 Buying <b>${buyAmount} SOL</b> (40% of wallet)\n` +
    `${DEVNET ? '🧪 DEVNET MODE' : '🔴 MAINNET'}`
  );

  try {
    const buyPrice           = await getTokenPrice(mint);
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
      `Tokens received: ${outAmount.toLocaleString()}\n` +
      `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>\n\n` +
      `🎯 Auto-sell: 50% @ ${SELL_HALF_X}x | 100% @ ${SELL_ALL_X}x`
    );

  } catch (err) {
    addLog('error', `Buy failed: ${err.message}`);
    await sendTelegram(
      `❌ <b>Buy Failed</b>\n\n` +
      `CA: <code>${mint}</code>\n` +
      `Error: ${err.message}`
    );
    // Remove failed position so we can retry
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
      addLog('info', `Position ${mint.slice(0,8)}...: ${multiplier.toFixed(2)}x`);

      // 5x — sell half
      if (multiplier >= SELL_HALF_X && !pos.halfSold) {
        addLog('info', `🎯 ${SELL_HALF_X}x hit! Selling 50% of ${mint.slice(0,8)}...`);
        const balance = await getTokenBalance(mint);
        const sellAmt = Math.floor(balance / 2);

        if (sellAmt > 0) {
          const { txid, solReceived } = await jupiterSell(mint, sellAmt);
          pos.halfSold = true;
          await sendTelegram(
            `🎯 <b>${SELL_HALF_X}x Hit — Sold 50%</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>\n\n` +
            `⏳ Holding rest until ${SELL_ALL_X}x...`
          );
        }
      }

      // 8x — sell all
      if (multiplier >= SELL_ALL_X && pos.halfSold && !pos.allSold) {
        addLog('info', `🚀 ${SELL_ALL_X}x hit! Selling all of ${mint.slice(0,8)}...`);
        const balance = await getTokenBalance(mint);

        if (balance > 0) {
          const { txid, solReceived } = await jupiterSell(mint, balance);
          pos.allSold = true;
          await sendTelegram(
            `🚀 <b>${SELL_ALL_X}x Hit — Sold All!</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `Total profit: ~${((solReceived / LAMPORTS_PER_SOL) - pos.solSpent).toFixed(4)} SOL\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">View TX</a>`
          );
          delete positions[mint];
        }
      }

    } catch (err) {
      addLog('error', `Price monitor error ${mint.slice(0,8)}...: ${err.message}`);
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
    if (!res.data.ok) addLog('error', `Telegram error: ${JSON.stringify(res.data)}`);
    else addLog('success', 'Telegram sent ✅');
  } catch (err) {
    addLog('error', `Telegram failed: ${err.response?.data?.description || err.message}`);
  }
}

// ─── BUILD TWEET MESSAGE ───────────────────────────────────
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

    if (isFirstRun) {
      lastTweetId = latest.guid;
      isFirstRun  = false;
      addLog('info', `✅ Baseline set — watching @${HANDLE}`);
      return;
    }

    if (lastTweetId === latest.guid) {
      addLog('info', `No new tweets from @${HANDLE}`);
      return;
    }

    // Collect all new tweets
    const newTweets = [];
    for (const tweet of tweets) {
      if (tweet.guid === lastTweetId) break;
      newTweets.push(tweet);
    }

    lastTweetId = latest.guid;
    newTweets.reverse(); // oldest first
    if (newTweets.length > 5) newTweets.splice(0, newTweets.length - 5);

    for (const tweet of newTweets) {
      // Send notification immediately
      await sendTelegram(buildMessage(tweet));

      // Scan for CAs
      const fullText = `${tweet.title} ${tweet.desc || ''}`;
      const cas      = extractCAs(fullText);

      if (cas.length) {
        addLog('info', `Found ${cas.length} CA(s): ${cas.join(', ')}`);
        for (const ca of cas) {
          await handleCA(ca); // mcap check + buy inside
        }
      }

      await new Promise(r => setTimeout(r, 800));
    }

    addLog('success', `Processed ${newTweets.length} new tweet(s)`);

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

// ─── KEEPALIVE (every 3 min) ───────────────────────────────
function startKeepalive() {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 8000 });
      addLog('info', '🏓 Keepalive OK');
    } catch (err) {
      addLog('warn', `Keepalive failed: ${err.message}`);
    }
  }, 3 * 60 * 1000);
  addLog('info', `🏓 Keepalive → ${SELF_URL}/health every 3min`);
}

// ─── INTERVALS ─────────────────────────────────────────────
// Poll every 15s (faster than before, syndication API handles it)
setInterval(safePoll,         15 * 1000);
// Price monitor every 20s
setInterval(monitorPositions, 20 * 1000);
addLog('info', '⏱ Tweet poll: 15s | Price monitor: 20s');

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status        : 'running ✅',
  mode          : DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴',
  watching      : `@${HANDLE}`,
  notifying     : CHAT_ID,
  wallet        : wallet?.publicKey.toBase58() || 'NOT LOADED',
  pollEvery     : '15 seconds',
  priceMonitor  : '20 seconds',
  keepalive     : '3 minutes',
  maxMcap       : `$${MAX_MCAP_USD.toLocaleString()}`,
  buyPct        : `${BUY_PCT * 100}% of wallet`,
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
  addLog('info', `🚀 TweetPulse + SniperBot v3 on port ${PORT}`);
  addLog('info', `Mode: ${DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴'}`);
  addLog('info', `Wallet: ${wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️'}`);
  addLog('info', `Buy: 40% of wallet | Max mcap: $${MAX_MCAP_USD.toLocaleString()}`);
  setTimeout(safePoll,       5000);
  setTimeout(startKeepalive, 15000);
});

// ─── CRASH GUARD ───────────────────────────────────────────
process.on('unhandledRejection', r  => addLog('error', `Unhandled rejection: ${r}`));
process.on('uncaughtException',  e  => addLog('error', `Uncaught exception: ${e.message} — continuing`));
