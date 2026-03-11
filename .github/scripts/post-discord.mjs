import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const LOCAL_TZ = "Europe/London";

// Turn this off if you want fully consistent wording.
const USE_MICRO_VARIATIONS = true;

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readPostingConfig() {
  const fp = path.join(ROOT, "trade-posting.config.json");
  if (!fs.existsSync(fp)) {
    throw new Error("Missing trade-posting.config.json");
  }
  return readJson(fp);
}

function readMeta() {
  const fp = path.join(ROOT, "trades", "_meta.json");
  if (!fs.existsSync(fp)) return null;
  return readJson(fp);
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

function absNumberText(v) {
  const n = Math.abs(Number(v));
  if (!Number.isFinite(n)) return "?";
  return n.toFixed(2);
}

function scratchThresholdForTrade(trade) {
  // For options this is per-contract price difference, not x100.
  return trade.instrument === "option" ? 0.05 : 0.02;
}

function exitUnitPnl(trade, completedTrade) {
  if (!completedTrade?.entry || trade.fill == null) return null;

  const entryFill = Number(completedTrade.entry.fill);
  const exitFill = Number(trade.fill);

  if (!Number.isFinite(entryFill) || !Number.isFinite(exitFill)) return null;

  // Your current use case is long stock / long calls / long puts.
  // RDT may display long puts as "Short", but the actual trade is still a bought option.
  return exitFill - entryFill;
}

function exitOutcome(trade, completedTrade) {
  const unit = exitUnitPnl(trade, completedTrade);
  if (unit == null) return { kind: "unknown", unit: null };

  const scratchThreshold = scratchThresholdForTrade(trade);

  if (unit > scratchThreshold) return { kind: "profit", unit };
  if (unit < -scratchThreshold) return { kind: "loss", unit };
  return { kind: "scratch", unit };
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
  const s = String(tradeId || "");
  let hash = 0;

  for (let i = 0; i < s.length; i++) {
    hash = ((hash * 33) + s.charCodeAt(i)) >>> 0;
  }

  return hash % 6;
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
        return `Long $${symbol} $${strike} Call ${exp} for ${priceCompact(trade.fill)}`;
      }

      switch (v) {
        case 1:
          return `long $${symbol} $${strike} Call ${exp} for ${priceCompact(trade.fill)}`;
        case 2:
          return `Long $${symbol} $${strike} Call for ${priceCompact(trade.fill)} ${exp}`;
        case 3:
          return `Long ${symbol} $${strike} Call ${exp} for ${priceCompact(trade.fill)}`;
        default:
          return `Long $${symbol} $${strike} Call ${exp} for ${priceCompact(trade.fill)}`;
      }
    }

    if (right === "p") {
      if (!USE_MICRO_VARIATIONS) {
        return `Short $${symbol} $${strike} Put ${exp} for ${priceCompact(trade.fill)}`;
      }

      switch (v) {
        case 1:
          return `short $${symbol} $${strike} Put ${exp} for ${priceCompact(trade.fill)}`;
        case 2:
          return `Short $${symbol} $${strike} Put for ${priceCompact(trade.fill)} ${exp}`;
        case 3:
          return `Short ${symbol} $${strike} Put ${exp} for ${priceCompact(trade.fill)}`;
        default:
          return `Short $${symbol} $${strike} Put ${exp} for ${priceCompact(trade.fill)}`;
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

  const outcome = exitOutcome(trade, completedTrade);
  const unit = outcome.unit;
  const amt = unit == null ? null : absNumberText(unit);

  const isOption = trade.instrument === "option";
  const unitLabel = isOption ? "per contract" : "per share";

  // No completed-trade / no P&L -> generic exit wording only
  if (typeof pnl !== "number") {
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
      case 4:
        return `Exited $${symbol} at ${fill}`;
      case 5:
        return `Exit ${symbol} @${fill}`;
      default:
        return `Exit $${symbol} at ${fill}`;
    }
  }

  // Use your preferred TOTAL P/L thresholds:
  // > +5 = profit
  // < -5 = loss
  // otherwise scratch
  if (!USE_MICRO_VARIATIONS) {
    if (pnl > 5) return `Took profit $${symbol} at ${fill}`;
    if (pnl < -5) return `Took loss $${symbol} at ${fill}`;
    return `Exit $${symbol} for a scratch at ${fill}`;
  }

  if (pnl > 5) {
    switch (v) {
      case 1:
        return `Took profit ${symbol} at ${fill}`;
      case 2:
        return `TP $${symbol} @${fill}`;
      case 3:
        return amt ? `Exit $${symbol} @${fill} for ${amt} gain` : `Exit $${symbol} @${fill}`;
      case 4:
        return amt ? `Exit $${symbol} ${fill} with $${amt} profit ${unitLabel}` : `Exit $${symbol} at ${fill}`;
      case 5:
        return `Exit $${symbol} at ${fill}`;
      default:
        return `Took profit $${symbol} at ${fill}`;
    }
  }

  if (pnl < -5) {
    switch (v) {
      case 1:
        return `Took loss ${symbol} at ${fill}`;
      case 2:
        return `Exit $${symbol} for loss @${fill}`;
      case 3:
        return `Exited $${symbol} for a loss @${fill}`;
      case 4:
        return amt ? `Exit $${symbol} with $${amt} loss ${unitLabel}` : `Exit $${symbol} at ${fill}`;
      case 5:
        return `Exit $${symbol} at ${fill}`;
      default:
        return `Took loss $${symbol} at ${fill}`;
    }
  }

  // Scratch bucket
  switch (v) {
    case 1:
      return `Exit ${symbol} for a scratch at ${fill}`;
    case 2:
      return `Scratched $${symbol} @${fill}`;
    case 3:
      return `Exit $${symbol} scratch @${fill}`;
    case 4:
      return `Exit $${symbol} at ${fill}`;
    case 5:
      return `Scratch $${symbol} at ${fill}`;
    default:
      return `Exit $${symbol} for a scratch at ${fill}`;
  }
}

function baseTradeLine(trade, completedTrade) {
  if (trade.trade_role === "close") {
    return exitLine(trade, completedTrade);
  }

  return entryLine(trade);
}

function composeMessage(trade, coreLine) {
  return coreLine;
}

function statePathForDestination(name) {
  return path.join(ROOT, "trades", "posting-state", `${name}.json`);
}

function readPostingState(name) {
  const fp = statePathForDestination(name);
  if (!fs.existsSync(fp)) {
    return {
      posted_trade_ids: [],
      posted_entry_trade_ids: [],
      posted_entry_dates: {}
    };
  }
  return readJson(fp);
}

function writePostingState(name, state) {
  writeJson(statePathForDestination(name), state);
}

function ymdInLocalTz(iso, timeZone = LOCAL_TZ) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(d)
      .filter(p => p.type !== "literal")
      .map(p => [p.type, p.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function countPostedEntriesForDay(state, ymd) {
  return Array.isArray(state.posted_entry_dates?.[ymd])
    ? state.posted_entry_dates[ymd].length
    : 0;
}

function markEntryPosted(state, trade, ymd) {
  if (!state.posted_trade_ids.includes(trade.trade_id)) {
    state.posted_trade_ids.push(trade.trade_id);
  }

  if (!state.posted_entry_trade_ids.includes(trade.trade_id)) {
    state.posted_entry_trade_ids.push(trade.trade_id);
  }

  if (!state.posted_entry_dates[ymd]) {
    state.posted_entry_dates[ymd] = [];
  }

  if (!state.posted_entry_dates[ymd].includes(trade.trade_id)) {
    state.posted_entry_dates[ymd].push(trade.trade_id);
  }
}

function markExitPosted(state, trade) {
  if (!state.posted_trade_ids.includes(trade.trade_id)) {
    state.posted_trade_ids.push(trade.trade_id);
  }
}

function alreadyPostedToDestination(state, trade) {
  return Array.isArray(state.posted_trade_ids) && state.posted_trade_ids.includes(trade.trade_id);
}

function shouldPostEntryToDestination(trade, filters, state) {
  if (filters.post_all_entries) {
    return { ok: true, reason: "post_all_entries" };
  }

  if (trade.instrument === "stock") {
    const minStockPrice = Number(filters.min_stock_price ?? 0);
    if (trade.fill == null || Number(trade.fill) < minStockPrice) {
      return { ok: false, reason: "stock_under_min_price" };
    }
  }

  if (trade.instrument === "option") {
    const minOptionDte = Number(filters.min_option_dte ?? 0);
    const dte = Number(trade.computed?.dte ?? -1);
    if (!Number.isFinite(dte) || dte < minOptionDte) {
      return { ok: false, reason: "option_dte_too_short" };
    }

    const minContractCost = Number(filters.min_option_contract_cost ?? 0);
    const contractCost = Number(trade.fill) * 100;
    if (!Number.isFinite(contractCost) || contractCost < minContractCost) {
      return { ok: false, reason: "option_contract_cost_too_low" };
    }
  }

  const maxNewEntriesPerDay = Number(filters.max_new_entries_per_day ?? Infinity);
  const ymd = ymdInLocalTz(trade.received_at);
  const postedToday = countPostedEntriesForDay(state, ymd);

  if (Number.isFinite(maxNewEntriesPerDay) && postedToday >= maxNewEntriesPerDay) {
    return { ok: false, reason: "daily_entry_limit_reached" };
  }

  return { ok: true, reason: "entry_ok" };
}

function shouldPostExitToDestination(trade, completedTrade, filters, state) {
  if (filters.post_all_exits) {
    return { ok: true, reason: "post_all_exits" };
  }

  if (!filters.require_posted_entry_for_exit) {
    return { ok: true, reason: "exit_ok_no_entry_requirement" };
  }

  const entryTradeId = completedTrade?.entry?.trade_id ?? null;
  if (!entryTradeId) {
    return { ok: false, reason: "no_entry_trade_id" };
  }

  const postedEntries = new Set(state.posted_entry_trade_ids || []);
  if (!postedEntries.has(entryTradeId)) {
    return { ok: false, reason: "entry_not_previously_posted" };
  }

  return { ok: true, reason: "exit_ok_entry_was_posted" };
}

function shouldPostTradeToDestination(trade, completedTrade, destination, state) {
  if (alreadyPostedToDestination(state, trade)) {
    return { ok: false, reason: "already_posted" };
  }

  const filters = destination.filters || {};

  if (trade.trade_role === "close") {
    return shouldPostExitToDestination(trade, completedTrade, filters, state);
  }

  return shouldPostEntryToDestination(trade, filters, state);
}

function updateStateAfterSuccessfulPost(state, trade) {
  if (trade.trade_role === "close") {
    markExitPosted(state, trade);
    return;
  }

  const ymd = ymdInLocalTz(trade.received_at);
  markEntryPosted(state, trade, ymd);
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
  const config = readPostingConfig();

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

  const completedTrade = latest.trade_role === "close"
    ? findCompletedTradeForExit(latest)
    : null;

  const coreLine = baseTradeLine(latest, completedTrade);
  const message = composeMessage(latest, coreLine);

  const destinations = config?.destinations || {};
  const destinationEntries = Object.entries(destinations);

  if (!destinationEntries.length) {
    console.log("No destinations configured; skipping Discord post.");
    return;
  }

  for (const [destinationName, destination] of destinationEntries) {
    if (!destination?.enabled) {
      console.log(`[${destinationName}] disabled; skipping.`);
      continue;
    }

    const secretEnv = destination.secret_env;
    const webhookUrl = secretEnv ? process.env[secretEnv] : null;

    if (!webhookUrl) {
      console.log(`[${destinationName}] missing webhook env ${secretEnv}; skipping.`);
      continue;
    }

    const state = readPostingState(destinationName);
    const decision = shouldPostTradeToDestination(latest, completedTrade, destination, state);

    if (!decision.ok) {
      console.log(`[${destinationName}] skipped: ${decision.reason}`);
      continue;
    }

    await postToDiscord(webhookUrl, message);
    updateStateAfterSuccessfulPost(state, latest);
    writePostingState(destinationName, state);

    console.log(`[${destinationName}] posted: ${message}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
