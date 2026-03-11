import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const LOCAL_TZ = "Europe/London";

// Turn this off if you want fully consistent wording.
const USE_MICRO_VARIATIONS = true;

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function sortTradesForPosting(a, b) {
  const ta = new Date(a?.received_at ?? 0).getTime();
  const tb = new Date(b?.received_at ?? 0).getTime();

  if (ta !== tb) return ta - tb;

  const ra = a?.trade_role === "open" ? 0 : a?.trade_role === "close" ? 1 : 2;
  const rb = b?.trade_role === "open" ? 0 : b?.trade_role === "close" ? 1 : 2;

  if (ra !== rb) return ra - rb;

  return String(a?.trade_id || "").localeCompare(String(b?.trade_id || ""));
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
  return trade.instrument === "option" ? 0.05 : 0.02;
}

function exitUnitPnl(trade, completedTrade) {
  if (!completedTrade?.entry || trade.fill == null) return null;

  const entryFill = Number(completedTrade.entry.fill);
  const exitFill = Number(trade.fill);

  if (!Number.isFinite(entryFill) || !Number.isFinite(exitFill)) return null;

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

function tradeRoleRank(trade) {
  if (trade?.trade_role === "open") return 0;
  if (trade?.trade_role === "close") return 1;
  return 2;
}

function sortTradesForPosting(a, b) {
  const ta = new Date(a?.received_at ?? 0).getTime();
  const tb = new Date(b?.received_at ?? 0).getTime();

  if (ta !== tb) return ta - tb;

  const ra = tradeRoleRank(a);
  const rb = tradeRoleRank(b);

  if (ra !== rb) return ra - rb;

  return String(a?.trade_id || "").localeCompare(String(b?.trade_id || ""));
}

function readAllCompletedTrades() {
  const completedRoot = path.join(ROOT, "trades", "completed-trades");
  const files = walkJsonFiles(completedRoot);
  return files.map(readJson);
}

function buildCompletedTradeIndexes(completedTrades) {
  const byEntryTradeId = new Map();
  const byExitTradeId = new Map();

  for (const t of completedTrades) {
    const entryId = t?.entry?.trade_id;
    if (entryId) {
      byEntryTradeId.set(entryId, t);
    }

    for (const x of t?.exits || []) {
      if (x?.trade_id) {
        byExitTradeId.set(x.trade_id, t);
      }
    }
  }

  return { byEntryTradeId, byExitTradeId };
}

function findCompletedTradeForTrade(trade, indexes) {
  if (!trade) return null;

  if (trade.trade_role === "open") {
    return indexes.byEntryTradeId.get(trade.trade_id) ?? null;
  }

  if (trade.trade_role === "close") {
    return indexes.byExitTradeId.get(trade.trade_id) ?? null;
  }

  return null;
}

function roundTripMinutes(completedTrade) {
  if (!completedTrade?.entry?.received_at || !completedTrade?.exits?.length) return null;

  const entryMs = new Date(completedTrade.entry.received_at).getTime();
  const firstExitMs = Math.min(
    ...completedTrade.exits
      .map(x => new Date(x.received_at).getTime())
      .filter(Number.isFinite)
  );

  if (!Number.isFinite(entryMs) || !Number.isFinite(firstExitMs)) return null;

  return (firstExitMs - entryMs) / 60000;
}

function isSuppressedQuickRoundTrip(trade, completedTrade, filters) {
  const minutesLimit = Number(filters?.suppress_round_trips_under_minutes ?? 0);
  if (!Number.isFinite(minutesLimit) || minutesLimit <= 0) return false;
  if (!completedTrade) return false;

  const mins = roundTripMinutes(completedTrade);
  if (!Number.isFinite(mins)) return false;

  return mins <= minutesLimit;
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

  if (isSuppressedQuickRoundTrip(trade, completedTrade, filters)) {
    return { ok: false, reason: "suppressed_quick_round_trip" };
  }

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

  const cleanedById = new Map(cleaned.map(t => [t.trade_id, t]));

  const meta = readMeta();
  const processedIds = Array.isArray(meta?.processed_trade_ids_this_run)
    ? meta.processed_trade_ids_this_run
    : (meta?.latest_processed_trade_id ? [meta.latest_processed_trade_id] : []);

  if (!processedIds.length) {
    console.log("No processed_trade_ids_this_run in _meta; skipping Discord post.");
    return;
  }

  const tradesThisRun = processedIds
    .map(id => cleanedById.get(id))
    .filter(Boolean)
    .sort(sortTradesForPosting);

  if (!tradesThisRun.length) {
    console.log("No matching cleaned trades found for processed_trade_ids_this_run.");
    return;
  }

  const completedTrades = readAllCompletedTrades();
  const completedIndexes = buildCompletedTradeIndexes(completedTrades);

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
    let stateChanged = false;

    for (const trade of tradesThisRun) {
      const completedTrade = findCompletedTradeForTrade(trade, completedIndexes);
      const decision = shouldPostTradeToDestination(trade, completedTrade, destination, state);

      if (!decision.ok) {
        console.log(`[${destinationName}] skipped ${trade.trade_id}: ${decision.reason}`);
        continue;
      }

      const coreLine = baseTradeLine(trade, completedTrade);
      const message = composeMessage(trade, coreLine);

      await postToDiscord(webhookUrl, message);
      updateStateAfterSuccessfulPost(state, trade);
      stateChanged = true;

      console.log(`[${destinationName}] posted ${trade.trade_id}: ${message}`);
    }

    if (stateChanged) {
      writePostingState(destinationName, state);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
