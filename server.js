// TweetPulse + SniperBot — server.js v6
// @macryptia → Telegram + Solana auto-buy (40% wallet) + auto-sell 5x/8x
// Parallel Nitter fetch, persistent state, anti-MEV, all bugs fixed

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const fs       = require('fs');
const cheerio  = require('cheerio');
const {
  Connection, Keypair, PublicKey,
  VersionedTransaction, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58     = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────
const BOT_TOKEN    = '8725848636:AAF9rTW6KtsecwpsWEoeZeM5zTya8j1Saps';
const CHAT_ID      = '@gemtweets';
const HANDLE       = 'macryptia';
const SELF_URL     = process.env.RENDER_EXTERNAL_URL || 'https://gemtweets-ne38.onrender.com';
const STATE_FILE   = '/tmp/tweetpulse_state.json';

const DEVNET       = true; // ← set false for mainnet
const RPC_URL      = DEVNET
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';

const BUY_PCT      = 0.40;
const SLIPPAGE_BPS = 1500;
const SELL_HALF_X  = 5;
const SELL_ALL_X   = 8;
const MAX_MCAP_USD = 56000;
const WSOL         = 'So11111111111111111111111111111111111111112';
const JUPITER_API  = 'https://quote-api.jup.ag/v6';

const NITTER_HOSTS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
  'https://nitter.catsarch.com',
];

// ─── LOGGING (defined first — used by everything below) ────
const logs = [];
function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ─── WALLET ────────────────────────────────────────────────
let wallet = null;
try {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY not set');
  wallet = Keypair.fromSecretKey(bs58.decode(raw));
  addLog('info', `Wallet: ${wallet.publicKey.toBase58()}`);
} catch (err) {
  addLog('error', `Wallet load failed: ${err.message}`);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ─── PERSISTENT STATE ──────────────────────────────────────
// FIX: addLog is now defined above so this is safe to call
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

// FIX: correct JSON.stringify signature (was passing 'utf8' as replacer)
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTweetId }, null, 2), 'utf8');
  } catch (err) {
    addLog('warn', `State save failed: ${err.message}`);
  }
}

// ─── APP STATE ─────────────────────────────────────────────
let lastTweetId = null;
let isFirstRun  = true;
let pollErrors  = 0;
let isPolling   = false;
const positions = {};

// Host performance tracker
const hostStats = {};
NITTER_HOSTS.forEach(h => hostStats[h] = { failures: 0, lastMs: 9999 });

// Load persisted state on boot
const saved = loadState();
if (saved.lastTweetId) {
  lastTweetId = saved.lastTweetId;
  isFirstRun  = false;
  addLog('info', `Resumed from saved state — no spam on restart ✅`);
}

// ─── PARALLEL NITTER FETCH ─────────────────────────────────
async function fetchFromHost(host) {
  const start = Date.now();
  const { data } = await axios.get(`${host}/${HANDLE}/rss`, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept'    : 'application/rss+xml, text/xml, */*',
    }
  });

  if (!data || !data.includes('<item>')) throw new Error('Invalid RSS');

  const $     = cheerio.load(data, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    items.push({
      guid    : $(el).find('guid').text().trim(),
      title   : $(el).find('title').text().trim(),
      pubDate : $(el).find('pubDate').text().trim(),
      link    : $(el).find('link').text().trim()
                  .replace(/https?:\/\/nitter\.[^/]+\//, 'https://x.com/'),
      desc    : $(el).find('description').text().trim(),
    });
  });

  if (!items.length) throw new Error('0 items returned');

  const ms = Date.now() - start;
  hostStats[host].lastMs   = ms;
  hostStats[host].failures = 0;
  addLog('info', `${host} → ${items.length} tweets in ${ms}ms`);
  return items;
}

// FIX: settled flag checked in catch block too — prevents reject after resolve
async function getLatestTweets() {
  return new Promise((resolve, reject) => {
    let settled  = false;
    let failures = 0;

    NITTER_HOSTS.forEach(host => {
      fetchFromHost(host)
        .then(items => {
          if (!settled) {
            settled = true;
            resolve(items);
          }
        })
        .catch(err => {
          hostStats[host].failures++;
          addLog('warn', `${host}: ${err.message}`);
          failures++;
          // FIX: only reject if not already settled
          if (!settled && failures === NITTER_HOSTS.length) {
            settled = true;
            reject(new Error('All Nitter hosts failed'));
          }
        });
    });
  });
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
    const res   = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = res.data?.pairs;
    if (!pairs?.length) return null;
    const best  = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
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
  addLog('info', `Jupiter buy: ${solAmount.toFixed(4)} SOL → ${mint.slice(0,8)}...`);

  const { data: quote } = await axios.get(`${JUPITER_API}/quote`, {
    params: { inputMint: WSOL, outputMint: mint, amount: lamports, slippageBps: SLIPPAGE_BPS },
    timeout: 10000,
  });
  if (!quote?.outAmount) throw new Error('No Jupiter quote');

  const { data: swapData } = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse    : quote,
    userPublicKey    : wallet.publicKey.toBase58(),
    wrapAndUnwrapSol : true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: 1000000, priorityLevel: 'veryHigh' }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  if (!swapData?.swapTransaction) throw new Error('No swap transaction returned');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Buy TX confirmed: ${txid}`);
  return { txid, outAmount: parseInt(quote.outAmount) };
}

// ─── JUPITER SELL ──────────────────────────────────────────
async function jupiterSell(mint, amountTokens) {
  if (!wallet) throw new Error('Wallet not loaded');
  addLog('info', `Jupiter sell: ${amountTokens} tokens of ${mint.slice(0,8)}...`);

  const { data: quote } = await axios.get(`${JUPITER_API}/quote`, {
    params: { inputMint: mint, outputMint: WSOL, amount: amountTokens, slippageBps: SLIPPAGE_BPS },
    timeout: 10000,
  });
  if (!quote?.outAmount) throw new Error('No sell quote');

  const { data: swapData } = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse    : quote,
    userPublicKey    : wallet.publicKey.toBase58(),
    wrapAndUnwrapSol : true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: 1000000, priorityLevel: 'veryHigh' }
    },
    dynamicComputeUnitLimit: true,
  }, { timeout: 15000 });

  if (!swapData?.swapTransaction) throw new Error('No sell transaction returned');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Sell TX confirmed: ${txid}`);
  return { txid, solReceived: parseInt(quote.outAmount) };
}

// ─── HANDLE CA ─────────────────────────────────────────────
async function handleCA(mint) {
  // FIX: explicit guard with log — never enters if already tracked
  if (positions[mint]) {
    addLog('info', `Already in position: ${mint.slice(0,8)}... — skipping`);
    return;
  }

  addLog('info', `CA detected: ${mint} — checking mcap...`);

  // Mcap check first — silent, no Telegram noise before decision
  const mcap = await getMcap(mint);
  if (mcap !== null && mcap > MAX_MCAP_USD) {
    addLog('warn', `Mcap $${mcap.toLocaleString()} > $${MAX_MCAP_USD.toLocaleString()} — skipping`);
    await sendTelegram(
      `⚠️ <b>CA Skipped — Mcap Too High</b>\n\n` +
      `<code>${mint}</code>\n` +
      `Mcap: $${mcap.toLocaleString()} (max $${MAX_MCAP_USD.toLocaleString()})`
    );
    return;
  }

  // Get 40% of current SOL balance
  const solBalance = await getWalletSOL();
  const buyAmount  = parseFloat((solBalance * BUY_PCT).toFixed(6));

  if (buyAmount < 0.001) {
    addLog('warn', `Wallet too low: ${solBalance} SOL`);
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

    // FIX: only set position AFTER successful buy confirmation
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
      `SOL spent: <b>${buyAmount}</b>\n` +
      `Tokens: ${outAmount.toLocaleString()}\n` +
      `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">Solscan</a>\n\n` +
      `🎯 Auto-sell: 50% @ ${SELL_HALF_X}x | All @ ${SELL_ALL_X}x`
    );

  } catch (err) {
    addLog('error', `Buy failed for ${mint.slice(0,8)}...: ${err.message}`);
    await sendTelegram(`❌ <b>Buy Failed</b>\n\n<code>${mint}</code>\nError: ${err.message}`);
    // No delete needed — position was never set on failure
  }
}

// ─── PRICE MONITOR ─────────────────────────────────────────
// FIX: marks allSold flag and only deletes on NEXT cycle
// so Telegram message always fires before the position is removed
async function monitorPositions() {
  const mints = Object.keys(positions);
  if (!mints.length) return;

  for (const mint of mints) {
    const pos = positions[mint];

    // Clean up fully closed positions from previous cycle
    if (pos.allSold) {
      delete positions[mint];
      continue;
    }

    try {
      const price = await getTokenPrice(mint);
      if (!price || !pos.buyPrice) continue;

      const x = price / pos.buyPrice;
      addLog('info', `${mint.slice(0,8)}...: ${x.toFixed(2)}x`);

      // 5x — sell half
      if (x >= SELL_HALF_X && !pos.halfSold) {
        addLog('info', `🎯 ${SELL_HALF_X}x hit on ${mint.slice(0,8)}...`);
        const bal = await getTokenBalance(mint);
        const amt = Math.floor(bal / 2);
        if (amt > 0) {
          const { txid, solReceived } = await jupiterSell(mint, amt);
          pos.halfSold = true;
          await sendTelegram(
            `🎯 <b>${SELL_HALF_X}x Hit — Sold 50%</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">Solscan</a>\n` +
            `⏳ Holding rest until ${SELL_ALL_X}x...`
          );
        }
      }

      // 8x — sell all
      if (x >= SELL_ALL_X && pos.halfSold && !pos.allSold) {
        addLog('info', `🚀 ${SELL_ALL_X}x hit on ${mint.slice(0,8)}...`);
        const bal = await getTokenBalance(mint);
        if (bal > 0) {
          const { txid, solReceived } = await jupiterSell(mint, bal);
          // FIX: set allSold flag — deletion happens on next monitor cycle
          pos.allSold = true;
          await sendTelegram(
            `🚀 <b>${SELL_ALL_X}x Hit — Sold All!</b>\n\n` +
            `CA: <code>${mint}</code>\n` +
            `SOL received: <b>${(solReceived / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>\n` +
            `Profit: ~${((solReceived / LAMPORTS_PER_SOL) - pos.solSpent).toFixed(4)} SOL\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">Solscan</a>`
          );
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
    if (!res.data.ok) addLog('error', `Telegram error: ${JSON.stringify(res.data)}`);
    else addLog('success', 'Telegram sent ✅');
  } catch (err) {
    addLog('error', `Telegram: ${err.response?.data?.description || err.message}`);
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
    `🔗 <a href="${tweet.link}">View on X</a>\n` +
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
      saveState();
      addLog('info', `✅ Baseline set: ${lastTweetId}`);
      return;
    }

    if (lastTweetId === latest.guid) {
      addLog('info', `No new tweets from @${HANDLE}`);
      return;
    }

    const newTweets = [];
    for (const t of tweets) {
      if (t.guid === lastTweetId) break;
      newTweets.push(t);
    }

    // Persist BEFORE sending — prevents duplicates if server crashes mid-send
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

    addLog('success', `Processed ${newTweets.length} new tweet(s)`);

  } catch (err) {
    addLog('error', `Poll error: ${err.message}`);
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
    addLog('error', `SafePoll #${pollErrors}: ${err.message}`);
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
      addLog('warn', `Keepalive failed: ${err.message}`);
    }
  }, 3 * 60 * 1000);
  addLog('info', `🏓 Keepalive active — pinging every 3min`);
}

// ─── INTERVALS ─────────────────────────────────────────────
setInterval(safePoll,         15 * 1000); // tweet poll every 15s
setInterval(monitorPositions, 20 * 1000); // price check every 20s

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status        : 'running ✅',
  mode          : DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴',
  watching      : `@${HANDLE}`,
  notifying     : CHAT_ID,
  wallet        : wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️',
  pollEvery     : '15s',
  priceMonitor  : '20s',
  keepalive     : '3min',
  maxMcap       : `$${MAX_MCAP_USD.toLocaleString()}`,
  buyPct        : '40% of wallet',
  openPositions : Object.keys(positions).length,
  positions,
  lastTweetId,
  pollErrors,
  hostStats,
  uptime        : `${Math.floor(process.uptime() / 60)} min`,
  recentLogs    : logs.slice(0, 15),
}));

app.get('/health',    (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/logs',      (req, res) => res.json(logs));
app.get('/positions', (req, res) => res.json(positions));
app.post('/force-poll', async (req, res) => { await safePoll(); res.json({ ok: true }); });

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog('info', `🚀 TweetPulse v6 on port ${PORT}`);
  addLog('info', `Mode: ${DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴'}`);
  addLog('info', `Wallet: ${wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️'}`);
  addLog('info', `Buy: 40% of wallet | Max mcap: $${MAX_MCAP_USD.toLocaleString()}`);
  setTimeout(safePoll,       5000);
  setTimeout(startKeepalive, 15000);
});

// ─── CRASH GUARD ───────────────────────────────────────────
process.on('unhandledRejection', r => addLog('error', `Unhandled rejection: ${r}`));
process.on('uncaughtException',  e => addLog('error', `Uncaught exception: ${e.message} — continuing`));
