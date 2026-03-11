import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// Turn this off if you want fully consistent wording.
const USE_MICRO_VARIATIONS = true;

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

function priceNoDollar(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  return n.toFixed(2);
}

function priceCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  const s = n.toFixed(2);
  return s.startsWith("0") ? s.slice(1) : s;
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

function stableVariantIndex(tradeId) {
  const last = (tradeId || "0").slice(-1);
  const n = parseInt(last, 16);
  return Number.isFinite(n) ? n % 4 : 0;
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

function entryLine(trade) {
  const symbol = trade.symbol || "UNKNOWN";
  const v = stableVariantIndex(trade.trade_id);

  if (trade.instrument === "stock") {
    const side = trade.pos_side === "short" ? "Short" : "Long";

    if (!USE_MICRO_VARIATIONS) {
      return `${side} $${symbol} @${priceNoDollar(trade.fill)}`;
    }

    switch (v) {
      case 1:
        return `${side.toLowerCase()} $${symbol} @${priceNoDollar(trade.fill)}`;
      case 2:
        return `${side} $${symbol} ${money(trade.fill)}`;
      case 3:
        return `${side} ${symbol} ${money(trade.fill)}`;
      default:
        return `${side} $${symbol} @${priceNoDollar(trade.fill)}`;
    }
  }

  if (trade.instrument === "option" && trade.option) {
    const strike = strikeText(trade.option.strike);
    const exp = mdFromIso(trade.option.expiry);
    const right = (trade.option.right || "").toLowerCase();

    // Your use case:
    // Long calls => Long
    // Long puts  => Short (RDT directional convention)
    if (right === "c") {
      if (!USE_MICRO_VARIATIONS) {
        return `Long $${symbol} $${strike} Calls ${exp} for ${priceCompact(trade.fill)}`;
      }

      switch (v) {
        case 1:
          return `long $${symbol} $${strike} Calls ${exp} for ${priceCompact(trade.fill)}`;
        case 2:
          return `Long $${symbol} $${strike} Calls for ${priceCompact(trade.fill)} ${exp}`;
        case 3:
          return `Long ${symbol} $${strike} Calls ${exp} for ${priceCompact(trade.fill)}`;
        default:
          return `Long $${symbol} $${strike} Calls ${exp} for ${priceCompact(trade.fill)}`;
      }
    }

    if (right === "p") {
      if (!USE_MICRO_VARIATIONS) {
        return `Short $${symbol} $${strike} Puts ${exp} for ${priceCompact(trade.fill)}`;
      }

      switch (v) {
        case 1:
          return `short $${symbol} $${strike} Puts ${exp} for ${priceCompact(trade.fill)}`;
        case 2:
          return `Short $${symbol} $${strike} Puts for ${priceCompact(trade.fill)} ${exp}`;
        case 3:
          return `Short ${symbol} $${strike} Puts ${exp} for ${priceCompact(trade.fill)}`;
        default:
          return `Short $${symbol} $${strike} Puts ${exp} for ${priceCompact(trade.fill)}`;
      }
    }
  }

  return trade.rdt?.text || `Trade ${symbol}`;
}

function exitLine(trade, completedTrade) {
  const symbol = trade.symbol || "UNKNOWN";
  const fill = priceCompact(trade.fill);
  const pnl = completedTrade?.pnl?.realized;
  const v = stableVariantIndex(trade.trade_id);

  if (typeof pnl === "number") {
    if (!USE_MICRO_VARIATIONS) {
      if (pnl > 5) return `Took profit $${symbol} at ${fill}`;
      if (pnl < -5) return `Took loss $${symbol} at ${fill}`;
      return `Exit $${symbol} for a scratch at ${fill}`;
    }

    if (pnl > 0) {
      switch (v) {
        case 1:
          return `Took profit ${symbol} at ${fill}`;
        case 2:
          return `Took profits $${symbol} @${fill}`;
        case 3:
          return `TP $${symbol} @${fill}`;
        default:
          return `Took profit $${symbol} at ${fill}`;
      }
    }

    if (pnl < 0) {
      switch (v) {
        case 1:
          return `Took loss ${symbol} at ${fill}`;
        case 2:
          return `Exit $${symbol} for loss @${fill}`;
        case 3:
          return `Exited $${symbol} for a loss @${fill}`;
        default:
          return `Took loss $${symbol} at ${fill}`;
      }
    }

    switch (v) {
      case 1:
        return `Exit ${symbol} for a scratch at ${fill}`;
      case 2:
        return `Scratched $${symbol} @${fill}`;
      case 3:
        return `Exit $${symbol} scratch @${fill}`;
      default:
        return `Exit $${symbol} for a scratch at ${fill}`;
    }
  }

  if (!USE_MICRO_VARIATIONS) {
    return `Exit $${symbol} at ${fill}`;
  }

  switch (v) {
    case 1:
      return `Exit ${symbol} at ${fill}`;
    case 2:
      return `Exit $${symbol} @${fill}`;
    case 3:
      return `Out $${symbol} at ${fill}`;
    default:
      return `Exit $${symbol} at ${fill}`;
  }
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

  if (!targetTradeId) {
    console.log("No latest_processed_trade_id for this run; skipping Discord post.");
    return;
  }

  const latest = cleaned.find(t => t.trade_id === targetTradeId) ?? null;

  if (!latest) {
    console.log(`Trade ${targetTradeId} not found in cleaned logs; skipping Discord post.`);
    return;
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
