import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const LOCAL_TZ = "Europe/London";

// Quiet output toggles
const INCLUDE_QTY = true;
const INCLUDE_TIME = true;
const INCLUDE_RAW = true;

// If true, same trade gets one of a few subtle stable styles.
// If false, it always uses the same clean style.
const USE_STABLE_VARIANTS = false;

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function walkJsonFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJsonFiles(fp));
    else if (ent.isFile() && ent.name.endsWith(".json")) out.push(fp);
  }

  return out;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$?";
  return `$${n.toFixed(2)}`;
}

function strikeText(v) {
  if (v == null) return "?";
  return String(v).replace(/\.0$/, "");
}

function mmddFromIso(iso) {
  if (!iso) return "??/??";
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

function localTimeText(iso, timeZone = LOCAL_TZ) {
  if (!iso) return null;
  const d = new Date(iso);

  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

function findCompletedTradeForExit(trade) {
  if (trade.trade_role !== "close") return null;

  const completedRoot = path.join(ROOT, "trades", "completed-trades");
  const files = walkJsonFiles(completedRoot);

  for (const fp of files) {
    const t = readJson(fp);
    if (t?.exits?.some(x => x.trade_id === trade.trade_id)) {
      return t;
    }
  }

  return null;
}

function exitLine(trade, completedTrade) {
  const symbol = trade.symbol || "UNKNOWN";
  const pnl = completedTrade?.pnl?.realized;

  if (typeof pnl === "number") {
    if (pnl > 0) return `Took profit ${symbol}`;
    if (pnl < 0) return `Took loss ${symbol}`;
    return `Scratch ${symbol}`;
  }

  // Fallback if completed-trade join does not find a P/L yet
  return `Exit ${symbol}`;
}

function entryLine(trade) {
  const symbol = trade.symbol || "UNKNOWN";

  if (trade.instrument === "stock") {
    const side = trade.pos_side === "short" ? "Short" : "Long";
    return `${side} ${symbol} ${money(trade.fill)}`;
  }

  if (trade.instrument === "option" && trade.option) {
    const strike = strikeText(trade.option.strike);
    const exp = mmddFromIso(trade.option.expiry);
    const right = trade.option.right;

    // Calls
    if (right === "C") {
      return `Long ${symbol} ${strike} Strike, ${money(trade.fill)}, ${exp} Expiration`;
    }

    // Puts
    // I am assuming you want this cleaner version, not the literal duplicated "Short ... Long ..."
    if (right === "P") {
      return `Short ${symbol} ${strike} Strike Puts, ${money(trade.fill)}, ${exp} Expiration`;
    }
  }

  // Fallback
  return trade.rdt?.text || `Trade ${symbol}`;
}

function baseTradeLine(trade) {
  const completedTrade = findCompletedTradeForExit(trade);

  if (trade.trade_role === "close") {
    return exitLine(trade, completedTrade);
  }

  return entryLine(trade);
}

function subtleExtras(trade) {
  const extras = [];

  if (INCLUDE_QTY && trade.qty != null) {
    extras.push(`x${trade.qty}`);
  }

  if (INCLUDE_TIME && trade.received_at) {
    extras.push(localTimeText(trade.received_at));
  }

  return extras;
}

function rawSuffix(trade, coreLine) {
  if (!INCLUDE_RAW) return null;
  if (!trade.raw?.text) return null;
  if (trade.raw.text === coreLine) return null;
  return `[${trade.raw.text}]`;
}

function stableVariantIndex(tradeId) {
  const last = (tradeId || "0").slice(-1);
  const n = parseInt(last, 16);
  return Number.isFinite(n) ? n % 4 : 0;
}

function composeMessage(trade, coreLine) {
  const extras = subtleExtras(trade);
  const raw = rawSuffix(trade, coreLine);

  if (!USE_STABLE_VARIANTS) {
    const tail = [];
    if (extras.length) tail.push(extras.join(", "));
    if (raw) tail.push(raw);

    return tail.length ? `${coreLine} (${tail.join(" | ")})` : coreLine;
  }

  switch (stableVariantIndex(trade.trade_id)) {
    case 0:
      return [
        coreLine,
        extras.length ? `(${extras.join(", ")})` : null,
        raw
      ].filter(Boolean).join(" ");

    case 1:
      return [
        coreLine,
        ...extras,
        raw
      ].filter(Boolean).join(" — ");

    case 2:
      return [
        extras[1] || null, // time first if available
        coreLine,
        extras[0] || null, // qty
        raw
      ].filter(Boolean).join(" | ");

    case 3:
    default:
      return [
        coreLine,
        extras.length ? `[${extras.join(" @ ")}]` : null,
        raw
      ].filter(Boolean).join(" ");
  }
}

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} ${body}`);
  }
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  // Important: skip quietly if the secret is not set yet
  if (!webhookUrl) {
    console.log("No DISCORD_WEBHOOK_URL set; skipping Discord post.");
    return;
  }

  const entriesRoot = path.join(ROOT, "trades", "entries-exits");
  const files = walkJsonFiles(entriesRoot);

  if (!files.length) {
    console.log("No cleaned trades found; skipping Discord post.");
    return;
  }

  const cleaned = files
    .map(readJson)
    .filter(t => t && t.trade_id && t.received_at);

  if (!cleaned.length) {
    console.log("No valid cleaned trades found; skipping Discord post.");
    return;
  }

  cleaned.sort((a, b) => {
    const ta = new Date(a.received_at).getTime();
    const tb = new Date(b.received_at).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.trade_id).localeCompare(String(b.trade_id));
  });

  const latest = cleaned[cleaned.length - 1];
  const coreLine = baseTradeLine(latest);
  const message = composeMessage(latest, coreLine);

  await postToDiscord(webhookUrl, message);
  console.log(`Posted to Discord: ${message}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
