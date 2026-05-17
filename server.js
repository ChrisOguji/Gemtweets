// TweetPulse + SniperBot — server.js v9
// PRIMARY: Twitter internal GraphQL API (real-time, <30s delay)
// FALLBACK: Parallel Nitter RSS fetch
// Multi-handle, global CA dedup, Jupiter v1 swap, anti-MEV Jito tip

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
const SELF_URL     = process.env.RENDER_EXTERNAL_URL || 'https://gemtweets-ne38.onrender.com';
const STATE_FILE   = '/tmp/tweetpulse_state.json';

// ── ADD OR REMOVE HANDLES HERE ─────────────────────────────
const HANDLES = [
  'GemisAlpha',
  'Macryptia',
];

// ── TWITTER AUTH TOKEN ─────────────────────────────────────
// Get this from your browser:
// 1. Open x.com, open DevTools → Application → Cookies
// 2. Find the cookie named "auth_token" — copy its value
// 3. Add it as TWITTER_AUTH_TOKEN in Render env vars
const TWITTER_AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN || '';

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

// Current Jupiter endpoints (v6 + price v4 deprecated Oct 2025)
const JUPITER_SWAP_API  = 'https://api.jup.ag/swap/v1';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';

// Nitter fallback pool
const NITTER_HOSTS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
  'https://nitter.catsarch.com',
];

// ─── LOGGING ───────────────────────────────────────────────
// Defined first — used by everything below including wallet load
const logs = [];
function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 500) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ─── WALLET ────────────────────────────────────────────────
let wallet = null;
try {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY not set in env');
  wallet = Keypair.fromSecretKey(bs58.decode(raw));
  addLog('info', `Wallet loaded: ${wallet.publicKey.toBase58()}`);
} catch (err) {
  addLog('error', `Wallet load failed: ${err.message}`);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ─── PERSISTENT STATE ──────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw  = fs.readFileSync(STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      addLog('info', `State loaded: ${JSON.stringify(data.handles)}`);
      return data;
    }
  } catch (err) {
    addLog('warn', `State load failed: ${err.message}`);
  }
  return { handles: {} };
}

function saveState() {
  try {
    const data = { handles: {} };
    HANDLES.forEach(h => {
      data.handles[h] = { lastTweetId: handleState[h].lastTweetId };
    });
    // Correct JSON.stringify signature: (value, replacer, space)
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    addLog('warn', `State save failed: ${err.message}`);
  }
}

// ─── PER-HANDLE STATE ──────────────────────────────────────
const handleState = {};
const saved = loadState();

HANDLES.forEach(handle => {
  const s = saved.handles?.[handle];
  handleState[handle] = {
    lastTweetId : s?.lastTweetId || null,
    isFirstRun  : !s?.lastTweetId,
    isPolling   : false,
    pollErrors  : 0,
  };
  addLog('info', s?.lastTweetId
    ? `[${handle}] Resumed: lastTweetId = ${s.lastTweetId}`
    : `[${handle}] First run — baseline on next poll`
  );
});

// ─── GLOBAL CA DEDUP + POSITIONS ───────────────────────────
const attemptedCAs = new Set();
const positions    = {};

// ─── HOST STATS ────────────────────────────────────────────
const hostStats = {};
NITTER_HOSTS.forEach(h => hostStats[h] = { failures: 0, lastMs: 9999 });

// ─── TWITTER GRAPHQL (PRIMARY — real-time) ─────────────────
// Uses Twitter's internal API with your browser auth_token cookie
// Returns tweets within seconds of posting — no cache delay
const twitterHeaders = (ct0) => ({
  'authorization'           : 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  'cookie'                  : `auth_token=${TWITTER_AUTH_TOKEN}; ct0=${ct0}`,
  'x-csrf-token'            : ct0,
  'x-twitter-auth-type'     : 'OAuth2Session',
  'x-twitter-active-user'   : 'yes',
  'x-twitter-client-language': 'en',
  'content-type'            : 'application/json',
  'user-agent'              : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});

// ct0 token cache (extracted from cookie on first request)
let ct0Cache = '';

async function getCt0() {
  // ct0 is a CSRF token set as a cookie — we derive it or use a fixed value
  // For the GraphQL API, we can pass a random 32-char hex as ct0
  if (!ct0Cache) {
    ct0Cache = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }
  return ct0Cache;
}

// Cache Twitter user IDs so we don't look them up on every poll
const userIdCache = {};

async function getTwitterUserId(handle) {
  if (userIdCache[handle]) return userIdCache[handle];

  const ct0 = await getCt0();
  const variables = encodeURIComponent(JSON.stringify({
    screen_name: handle,
    withSafetyModeUserFields: true,
  }));
  const features = encodeURIComponent(JSON.stringify({
    hidden_profile_likes_enabled: true,
    hidden_profile_subscriptions_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  }));

  const url = `https://twitter.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?variables=${variables}&features=${features}`;

  const res = await axios.get(url, {
    headers: twitterHeaders(ct0),
    timeout: 10000,
  });

  const userId = res.data?.data?.user?.result?.rest_id;
  if (!userId) throw new Error(`Could not get user ID for @${handle}`);

  userIdCache[handle] = userId;
  addLog('info', `[${handle}] Twitter user ID: ${userId}`);
  return userId;
}

async function getTwitterTweets(handle) {
  const ct0    = await getCt0();
  const userId = await getTwitterUserId(handle);

  const variables = encodeURIComponent(JSON.stringify({
    userId,
    count                          : 20,
    includePromotedContent         : false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice                      : true,
    withV2Timeline                 : true,
  }));

  const features = encodeURIComponent(JSON.stringify({
    responsive_web_graphql_exclude_directive_enabled            : true,
    verified_phone_label_enabled                                : false,
    creator_subscriptions_tweet_preview_api_enabled             : true,
    responsive_web_graphql_timeline_navigation_enabled          : true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweetypie_unmention_optimization_enabled                    : true,
    responsive_web_edit_tweet_api_enabled                       : true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled  : true,
    view_counts_everywhere_api_enabled                          : true,
    longform_notetweets_consumption_enabled                     : true,
    tweet_awards_web_tipping_enabled                            : false,
    freedom_of_speech_not_reach_fetch_enabled                   : true,
    standardized_nudges_misinfo                                 : true,
    longform_notetweets_rich_text_read_enabled                  : true,
    responsive_web_enhance_cards_enabled                        : false,
  }));

  const url = `https://twitter.com/i/api/graphql/V1ze5q3ijDS1VeLwLY0m7g/UserTweets?variables=${variables}&features=${features}`;

  const res = await axios.get(url, {
    headers: twitterHeaders(ct0),
    timeout: 10000,
  });

  // Navigate the GraphQL response to extract tweet entries
  const instructions = res.data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
  const timelineAdd  = instructions.find(i => i.type === 'TimelineAddEntries');
  const entries      = timelineAdd?.entries || [];

  const tweets = [];
  for (const entry of entries) {
    const tweet = entry?.content?.itemContent?.tweet_results?.result;
    if (!tweet) continue;

    const core    = tweet.core?.user_results?.result?.legacy;
    const legacy  = tweet.legacy;
    if (!legacy) continue;

    const tweetId = legacy.id_str;
    const text    = legacy.full_text || legacy.text || '';
    const date    = legacy.created_at;

    tweets.push({
      guid    : tweetId,
      title   : text,
      pubDate : date,
      link    : `https://x.com/${handle}/status/${tweetId}`,
      desc    : text,
    });
  }

  addLog('info', `[${handle}] Twitter GraphQL: ${tweets.length} tweets`);
  return tweets;
}

// ─── NITTER FALLBACK ───────────────────────────────────────
async function fetchFromHost(host, handle) {
  const start = Date.now();
  const { data } = await axios.get(`${host}/${handle}/rss`, {
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
  addLog('info', `[${handle}] Nitter ${host} → ${items.length} tweets in ${ms}ms`);
  return items;
}

async function getNitterTweets(handle) {
  return new Promise((resolve, reject) => {
    let settled  = false;
    let failures = 0;

    NITTER_HOSTS.forEach(host => {
      fetchFromHost(host, handle)
        .then(items => {
          if (!settled) { settled = true; resolve(items); }
        })
        .catch(err => {
          hostStats[host].failures++;
          addLog('warn', `[${handle}] Nitter ${host}: ${err.message}`);
          failures++;
          if (!settled && failures === NITTER_HOSTS.length) {
            settled = true;
            reject(new Error(`All Nitter hosts failed for @${handle}`));
          }
        });
    });
  });
}

// ─── UNIFIED TWEET FETCHER ─────────────────────────────────
// Twitter GraphQL first (real-time), Nitter as fallback
async function getLatestTweets(handle) {
  // Only use GraphQL if auth token is configured
  if (TWITTER_AUTH_TOKEN) {
    try {
      const tweets = await getTwitterTweets(handle);
      if (tweets.length) return tweets;
      addLog('warn', `[${handle}] GraphQL returned 0 tweets — trying Nitter`);
    } catch (err) {
      addLog('warn', `[${handle}] GraphQL failed: ${err.message} — trying Nitter`);
    }
  } else {
    addLog('warn', `[${handle}] No TWITTER_AUTH_TOKEN set — using Nitter (slower)`);
  }
  return getNitterTweets(handle);
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
    const res   = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8000 }
    );
    const pairs = res.data?.pairs;
    if (!pairs?.length) return null;
    const best  = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best?.fdv || best?.marketCap || null;
  } catch { return null; }
}

// ─── WALLET SOL BALANCE ────────────────────────────────────
async function getWalletSOL() {
  if (!wallet) return 0;
  try {
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

// ─── TOKEN BALANCE ─────────────────────────────────────────
async function getTokenBalance(mint) {
  if (!wallet) return 0;
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
    const bal = await connection.getTokenAccountBalance(ata);
    return parseInt(bal.value.amount);
  } catch { return 0; }
}

// ─── TOKEN PRICE (Jupiter Price v3) ────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`${JUPITER_PRICE_API}/price`, {
      params : { ids: mint },
      timeout: 8000,
    });
    return res.data?.data?.[mint]?.price || 0;
  } catch { return 0; }
}

// ─── JUPITER BUY ───────────────────────────────────────────
async function jupiterBuy(mint, solAmount) {
  if (!wallet) throw new Error('Wallet not loaded');
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  addLog('info', `Jupiter buy: ${solAmount.toFixed(4)} SOL → ${mint.slice(0,8)}...`);

  const { data: quote } = await axios.get(`${JUPITER_SWAP_API}/quote`, {
    params : {
      inputMint  : WSOL,
      outputMint : mint,
      amount     : lamports,
      slippageBps: SLIPPAGE_BPS,
    },
    timeout: 10000,
  });
  if (!quote?.outAmount) throw new Error('No Jupiter quote returned');

  const { data: swapData } = await axios.post(`${JUPITER_SWAP_API}/swap`, {
    quoteResponse           : quote,
    userPublicKey           : wallet.publicKey.toBase58(),
    wrapAndUnwrapSol        : true,
    dynamicComputeUnitLimit : true,
    // Anti-MEV: Jito tip (new format — old priorityLevelWithMaxLamports removed)
    prioritizationFeeLamports: {
      jitoTipLamports: 100000, // 0.0001 SOL
    },
  }, { timeout: 15000 });

  if (!swapData?.swapTransaction) throw new Error('No swap transaction returned');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight       : false,
    preflightCommitment : 'confirmed',
    maxRetries          : 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Buy TX confirmed: ${txid}`);
  return { txid, outAmount: parseInt(quote.outAmount) };
}

// ─── JUPITER SELL ──────────────────────────────────────────
async function jupiterSell(mint, amountTokens) {
  if (!wallet) throw new Error('Wallet not loaded');
  addLog('info', `Jupiter sell: ${amountTokens} tokens of ${mint.slice(0,8)}...`);

  const { data: quote } = await axios.get(`${JUPITER_SWAP_API}/quote`, {
    params : {
      inputMint  : mint,
      outputMint : WSOL,
      amount     : amountTokens,
      slippageBps: SLIPPAGE_BPS,
    },
    timeout: 10000,
  });
  if (!quote?.outAmount) throw new Error('No sell quote returned');

  const { data: swapData } = await axios.post(`${JUPITER_SWAP_API}/swap`, {
    quoteResponse           : quote,
    userPublicKey           : wallet.publicKey.toBase58(),
    wrapAndUnwrapSol        : true,
    dynamicComputeUnitLimit : true,
    prioritizationFeeLamports: {
      jitoTipLamports: 100000,
    },
  }, { timeout: 15000 });

  if (!swapData?.swapTransaction) throw new Error('No sell transaction returned');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight       : false,
    preflightCommitment : 'confirmed',
    maxRetries          : 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  addLog('success', `Sell TX confirmed: ${txid}`);
  return { txid, solReceived: parseInt(quote.outAmount) };
}

// ─── HANDLE CA ─────────────────────────────────────────────
async function handleCA(mint, fromHandle) {
  // Global dedup — block parallel handles from double-buying same CA
  if (attemptedCAs.has(mint)) {
    addLog('info', `[${fromHandle}] CA ${mint.slice(0,8)}... already attempted — skipping`);
    return;
  }
  if (positions[mint]) {
    addLog('info', `[${fromHandle}] Already in position: ${mint.slice(0,8)}... — skipping`);
    return;
  }

  // Add to set immediately before any async work
  attemptedCAs.add(mint);
  addLog('info', `[${fromHandle}] CA: ${mint} — checking mcap...`);

  // Mcap check silently first
  const mcap = await getMcap(mint);
  if (mcap !== null && mcap > MAX_MCAP_USD) {
    addLog('warn', `[${fromHandle}] Mcap $${mcap.toLocaleString()} > $${MAX_MCAP_USD.toLocaleString()} — skipping`);
    await sendTelegram(
      `⚠️ <b>CA Skipped — Mcap Too High</b>\n\n` +
      `<code>${mint}</code>\n` +
      `From: @${fromHandle}\n` +
      `Mcap: $${mcap.toLocaleString()} (max $${MAX_MCAP_USD.toLocaleString()})`
    );
    return;
  }

  // Get 40% of current wallet balance
  const solBalance = await getWalletSOL();
  const buyAmount  = parseFloat((solBalance * BUY_PCT).toFixed(6));

  if (buyAmount < 0.001) {
    addLog('warn', `Wallet too low: ${solBalance} SOL`);
    await sendTelegram(`⚠️ <b>Wallet too low</b>: ${solBalance.toFixed(4)} SOL — skipping`);
    return;
  }

  const mcapStr = mcap ? `$${mcap.toLocaleString()}` : 'unverified';
  await sendTelegram(
    `🎯 <b>CA Detected from @${fromHandle}</b>\n\n` +
    `<code>${mint}</code>\n\n` +
    `Mcap: ${mcapStr}\n` +
    `💸 Buying <b>${buyAmount} SOL</b> (40% of wallet)\n` +
    `${DEVNET ? '🧪 DEVNET MODE' : '🔴 MAINNET'}`
  );

  try {
    const buyPrice            = await getTokenPrice(mint);
    const { txid, outAmount } = await jupiterBuy(mint, buyAmount);

    // Only set position after confirmed buy
    positions[mint] = {
      buyPrice  : buyPrice || 0.000001,
      amount    : outAmount,
      halfSold  : false,
      allSold   : false,
      buyTx     : txid,
      buyTime   : Date.now(),
      solSpent  : buyAmount,
      fromHandle,
    };

    await sendTelegram(
      `✅ <b>Buy Confirmed!</b>\n\n` +
      `CA: <code>${mint}</code>\n` +
      `From: @${fromHandle}\n` +
      `SOL spent: <b>${buyAmount}</b> | Tokens: ${outAmount.toLocaleString()}\n` +
      `🔗 <a href="https://solscan.io/tx/${txid}${DEVNET ? '?cluster=devnet' : ''}">Solscan</a>\n\n` +
      `🎯 Auto-sell: 50% @ ${SELL_HALF_X}x | All @ ${SELL_ALL_X}x`
    );

  } catch (err) {
    addLog('error', `Buy failed for ${mint.slice(0,8)}...: ${err.message}`);
    await sendTelegram(
      `❌ <b>Buy Failed</b>\n\n` +
      `CA: <code>${mint}</code>\n` +
      `From: @${fromHandle}\n` +
      `Error: ${err.message}`
    );
    // Remove from set so it can retry if error was transient
    attemptedCAs.delete(mint);
  }
}

// ─── PRICE MONITOR ─────────────────────────────────────────
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

      // 8x — sell all remaining (only after half sold)
      if (x >= SELL_ALL_X && pos.halfSold && !pos.allSold) {
        addLog('info', `🚀 ${SELL_ALL_X}x hit on ${mint.slice(0,8)}...`);
        const bal = await getTokenBalance(mint);
        if (bal > 0) {
          const { txid, solReceived } = await jupiterSell(mint, bal);
          pos.allSold = true; // deletion happens on next cycle — Telegram sends first
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
function buildMessage(tweet, handle) {
  const isRT    = tweet.title.startsWith('RT @');
  const isReply = tweet.title.startsWith('@');
  const icon    = isRT ? '🔁' : isReply ? '💬' : '🐦';
  const type    = isRT ? 'Retweeted' : isReply ? 'Replied' : 'New Tweet';
  return (
    `${icon} <b>@${handle} — ${type}</b>\n\n` +
    `${tweet.title}\n\n` +
    `🔗 <a href="${tweet.link}">View on X</a>\n` +
    `<i>${tweet.pubDate}</i>`
  );
}

// ─── POLL ONE HANDLE ───────────────────────────────────────
async function pollHandle(handle) {
  const state = handleState[handle];
  if (state.isPolling) {
    addLog('info', `[${handle}] Poll skipped — still running`);
    return;
  }
  state.isPolling = true;

  try {
    const tweets = await getLatestTweets(handle);
    if (!tweets.length) return;

    const latest = tweets[0];

    // First run — set baseline silently, never notify old tweets
    if (state.isFirstRun) {
      state.lastTweetId = latest.guid;
      state.isFirstRun  = false;
      saveState();
      addLog('info', `[${handle}] ✅ Baseline set: ${latest.guid}`);
      return;
    }

    // Nothing new
    if (state.lastTweetId === latest.guid) {
      addLog('info', `[${handle}] No new tweets`);
      return;
    }

    // Collect all tweets newer than lastTweetId
    const newTweets = [];
    for (const t of tweets) {
      if (t.guid === state.lastTweetId) break;
      newTweets.push(t);
    }

    // Save BEFORE sending — crash-safe, prevents re-processing on restart
    state.lastTweetId = latest.guid;
    saveState();

    newTweets.reverse(); // send oldest first (chronological)
    // Cap at 5 to avoid spam if bot was offline a while
    if (newTweets.length > 5) newTweets.splice(0, newTweets.length - 5);

    for (const tweet of newTweets) {
      await sendTelegram(buildMessage(tweet, handle));

      const cas = extractCAs(`${tweet.title} ${tweet.desc || ''}`);
      if (cas.length) {
        addLog('info', `[${handle}] Found ${cas.length} CA(s): ${cas.join(', ')}`);
        for (const ca of cas) await handleCA(ca, handle);
      }

      await new Promise(r => setTimeout(r, 800));
    }

    // Reset error counter on successful poll
    state.pollErrors = 0;
    addLog('success', `[${handle}] Processed ${newTweets.length} tweet(s)`);

  } catch (err) {
    state.pollErrors++;
    addLog('error', `[${handle}] Poll error #${state.pollErrors}: ${err.message}`);
    if (state.pollErrors === 5) {
      await sendTelegram(`⚠️ <b>@${handle}</b>: 5 consecutive poll errors. Still watching.`).catch(() => {});
    }
  } finally {
    // Always release lock — even on error
    state.isPolling = false;
  }
}

// ─── POLL ALL HANDLES ──────────────────────────────────────
async function pollAll() {
  // allSettled — one handle failing never blocks the other
  await Promise.allSettled(HANDLES.map(h => pollHandle(h)));
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
  addLog('info', '🏓 Keepalive every 3min');
}

// ─── INTERVALS ─────────────────────────────────────────────
setInterval(pollAll,          15 * 1000); // all handles every 15s
setInterval(monitorPositions, 20 * 1000); // price check every 20s

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status         : 'running ✅',
  mode           : DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴',
  watching       : HANDLES.map(h => `@${h}`),
  notifying      : CHAT_ID,
  wallet         : wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️',
  twitterSource  : TWITTER_AUTH_TOKEN ? 'GraphQL API (real-time) ✅' : 'Nitter RSS (slow) ⚠️ — set TWITTER_AUTH_TOKEN',
  pollEvery      : '15s per handle',
  priceMonitor   : '20s',
  keepalive      : '3min',
  maxMcap        : `$${MAX_MCAP_USD.toLocaleString()}`,
  buyPct         : '40% of wallet',
  jupiterSwap    : JUPITER_SWAP_API,
  jupiterPrice   : JUPITER_PRICE_API,
  handleState    : Object.fromEntries(
    HANDLES.map(h => [h, {
      lastTweetId : handleState[h].lastTweetId,
      isFirstRun  : handleState[h].isFirstRun,
      pollErrors  : handleState[h].pollErrors,
    }])
  ),
  openPositions  : Object.keys(positions).length,
  positions,
  attemptedCAs   : [...attemptedCAs],
  hostStats,
  uptime         : `${Math.floor(process.uptime() / 60)} min`,
  recentLogs     : logs.slice(0, 20),
}));

app.get('/health',    (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/logs',      (req, res) => res.json(logs));
app.get('/positions', (req, res) => res.json(positions));
app.post('/force-poll', async (req, res) => {
  await pollAll();
  res.json({ ok: true });
});

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog('info', `🚀 TweetPulse v9 on port ${PORT}`);
  addLog('info', `Mode: ${DEVNET ? 'DEVNET 🧪' : 'MAINNET 🔴'}`);
  addLog('info', `Wallet: ${wallet?.publicKey.toBase58() || 'NOT LOADED ⚠️'}`);
  addLog('info', `Watching: ${HANDLES.map(h => '@' + h).join(', ')}`);
  addLog('info', `Twitter source: ${TWITTER_AUTH_TOKEN ? 'GraphQL (real-time)' : 'Nitter RSS (set TWITTER_AUTH_TOKEN for speed)'}`);
  setTimeout(pollAll,        5000);
  setTimeout(startKeepalive, 15000);
});

// ─── CRASH GUARD ───────────────────────────────────────────
process.on('unhandledRejection', r => addLog('error', `Unhandled rejection: ${r}`));
process.on('uncaughtException',  e => addLog('error', `Uncaught exception: ${e.message} — continuing`));
