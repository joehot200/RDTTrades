import fs from "fs";
import path from "path";

const ROOT = process.cwd();

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

function sortEventTimeValue(e) {
  return new Date(
    e?.source?.ingested_at ??
    e?.received_at ??
    0
  ).getTime();
}

function readMeta() {
  const fp = path.join(ROOT, "trades", "_meta.json");
  if (!fs.existsSync(fp)) return null;
  return readJson(fp);
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

function mdFromIso(iso) {
  if (!iso) return "?/?";
  const month = String(Number(iso.slice(5, 7)));
  const day = String(Number(iso.slice(8, 10)));
  return `${month}/${day}`;
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
    const exp = mdFromIso(trade.option.expiry);
    const right = trade.option.right;

    if (right === "C") {
      return `Long ${symbol} ${strike} Strike ${money(trade.fill)} ${exp}`;
    }

    if (right === "P") {
      return `Short ${symbol} ${strike} Strike Puts ${money(trade.fill)} ${exp}`;
    }
  }

  return trade.rdt?.text || `Trade ${symbol}`;
}

function baseTradeLine(trade) {
  const completedTrade = findCompletedTradeForExit(trade);

  if (trade.trade_role === "close") {
    return exitLine(trade, completedTrade);
  }

  return entryLine(trade);
}

function composeMessage(trade, coreLine) {
  return coreLine;
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

  const meta = readMeta();
  const targetTradeId = meta?.latest_processed_trade_id ?? null;

  let latest = null;

  if (targetTradeId) {
    latest = cleaned.find(t => t.trade_id === targetTradeId) ?? null;
  }

  if (!latest) {
    cleaned.sort((a, b) => {
      const ta = sortEventTimeValue(a);
      const tb = sortEventTimeValue(b);
      if (ta !== tb) return ta - tb;
      return String(a.trade_id || "").localeCompare(String(b.trade_id || ""));
    });

    latest = cleaned[cleaned.length - 1];
  }

  const coreLine = baseTradeLine(latest);
  const message = composeMessage(latest, coreLine);

  await postToDiscord(webhookUrl, message);
  console.log(`Posted to Discord: ${message}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
