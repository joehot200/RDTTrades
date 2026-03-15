import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const LOCAL_TZ = "Europe/London";

const MONTH = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

const ACTION_WORDS = [
  "BOT", "SOLD", "BTO", "STC", "STO", "BTC",
  "BUY TO OPEN", "SELL TO CLOSE", "SELL TO OPEN", "BUY TO CLOSE"
];

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(dir, f))
    .sort();
}

function archiveInboxFile(inboxPath, received_at) {
  const month = isoMonth(received_at);
  const processedDir = path.join(ROOT, "inbox", "processed", month);

  fs.mkdirSync(processedDir, { recursive: true });

  const parsed = path.parse(path.basename(inboxPath));
  let dest = path.join(processedDir, `${parsed.name}${parsed.ext}`);

  if (fs.existsSync(dest)) {
    dest = path.join(
      processedDir,
      `${parsed.name}__${Date.now()}${parsed.ext}`
    );
  }

  fs.renameSync(inboxPath, dest);

  return path.relative(ROOT, dest).replace(/\\/g, "/");
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

function isoMonth(iso) {
  return new Date(iso).toISOString().slice(0, 7);
}

function toIsoDateFromDmy(day, mon3, yearNum) {
  const mm = MONTH[mon3];
  if (!mm) return null;
  const yyyy = yearNum < 100 ? 2000 + yearNum : yearNum;
  return `${yyyy}-${mm}-${pad2(day)}`;
}

function computeDte(expiryIso, now = new Date()) {
  if (!expiryIso) return -1;
  const expiry = new Date(expiryIso + "T00:00:00Z");
  return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
}

function normalize(raw) {
  const t = (raw ?? "").trim();
  const u = t.toUpperCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: t, upper: u };
}

function tryParseDateToIso(raw) {
  if (!raw) return null;

  const s = String(raw).trim();
  const candidates = [
    s,
    s.replace(/\s+\([A-Z]{2,5}\)\s*$/, ""),
  ];

  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

function parseDateToIso(raw) {
  return tryParseDateToIso(raw) ?? new Date().toISOString();
}

function isExitAction(actionUpper) {
  const a = actionUpper.toUpperCase();
  return ["SOLD", "STC", "SELL TO CLOSE", "BTC", "BUY TO CLOSE"].includes(a);
}

function classifyOptionAction(actionUpper) {
  const a = actionUpper.toUpperCase();

  if (["BOT", "BTO", "BUY TO OPEN"].includes(a)) return { role: "open", pos_side: "long" };
  if (["SOLD", "STC", "SELL TO CLOSE"].includes(a)) return { role: "close", pos_side: "long" };

  if (["STO", "SELL TO OPEN"].includes(a)) return { role: "open", pos_side: "short" };
  if (["BTC", "BUY TO CLOSE"].includes(a)) return { role: "close", pos_side: "short" };

  if (a.includes("SELL")) return { role: "close", pos_side: "long" };
  if (a.includes("BUY")) return { role: "open", pos_side: "long" };

  return { role: "unknown", pos_side: "unknown" };
}

function getDatePartsInTimeZone(dateInput, timeZone = LOCAL_TZ) {
  const d = new Date(dateInput);
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

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    ymd: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function ymdToUtcDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function subtractDaysFromYmd(ymd, days) {
  const d = ymdToUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function mondayOfWeekYmd(dateInput, timeZone = LOCAL_TZ) {
  const { ymd } = getDatePartsInTimeZone(dateInput, timeZone);
  const d = ymdToUtcDate(ymd);
  const dow = d.getUTCDay();
  const offset = (dow + 6) % 7;
  return subtractDaysFromYmd(ymd, offset);
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

function parseRaw(raw, now = new Date()) {
  const { text, upper } = normalize(raw);

  const out = {
    instrument: "unknown",
    paper: /\bPAPERMONEY\b/.test(upper),
    action: null,
    symbol: null,
    qty: null,
    fill: null,
    option: null,
    rdt: {
      matched: "none",
      text: text || "Trade alert received (no text found)."
    },
    computed: {
      dte: -1,
      wiki_ok: false
    },
    trade_role: "unknown",
    pos_side: "unknown",
    contract_key: null
  };

  const actionRe = `(${ACTION_WORDS.map(a => a.replace(/ /g, "\\s+")).join("|")})`;
  const qtyRe = "([+-]?\\d+)";
  const symRe = "([A-Z]{1,6})";
  const dateRe = "(\\d{1,2})\\s+([A-Z]{3})\\s+(\\d{2,4})";
  const strikeRe = "(\\d+(?:\\.\\d+)?)\\s+(CALL|PUT)";
  const fillRe = "(?:@|\\bAT\\b)\\s*(\\d*\\.?\\d+)";

  let m = upper.match(new RegExp(
    `\\b${actionRe}\\b[\\s\\S]*?\\b${qtyRe}\\b[\\s\\S]*?\\b${symRe}\\b[\\s\\S]*?\\b${dateRe}\\b[\\s\\S]*?\\b${strikeRe}\\b[\\s\\S]*?${fillRe}`,
    "i"
  ));

  if (m) {
    const action = m[1].toUpperCase().replace(/\s+/g, " ");
    const qty = Math.abs(parseInt(m[2], 10));
    const symbol = m[3].toUpperCase();
    const day = parseInt(m[4], 10);
    const mon3 = m[5].toUpperCase();
    const yearNum = parseInt(m[6], 10);
    const strike = Number(m[7]);
    const rightWord = m[8].toUpperCase();
    const fill = Number(m[9]);

    const right = rightWord === "CALL" ? "C" : "P";
    const expiryIso = toIsoDateFromDmy(day, mon3, yearNum);

    out.instrument = "option";
    out.action = action;
    out.symbol = symbol;
    out.qty = Number.isFinite(qty) ? qty : null;
    out.fill = Number.isFinite(fill) ? fill : null;
    out.option = {
      expiry: expiryIso,
      strike,
      right
    };

    const expiryMmdd = expiryIso
      ? `${expiryIso.slice(5, 7)}/${expiryIso.slice(8, 10)}`
      : "??/??";

    const bias = right === "C" ? "long" : "short";
    const prefix = isExitAction(action) ? "exit " : "";
    const typeWord = right === "C" ? "Call" : "Put";

    out.rdt.matched = "options";
    out.rdt.text = `${prefix}${bias} ${symbol} $${strike} ${typeWord} for ${expiryMmdd} at ${fill}`;

    const dte = computeDte(expiryIso, now);
    out.computed.dte = dte;
    out.computed.wiki_ok = dte >= 8;

    const cls = classifyOptionAction(action);
    out.trade_role = cls.role;
    out.pos_side = cls.pos_side;
    out.contract_key = `OPT|${symbol}|${expiryIso ?? "UNKNOWN"}|${strike}|${right}`;

    return out;
  }

  m = upper.match(new RegExp(
    `\\b${actionRe}\\b[\\s\\S]*?\\b${qtyRe}\\b[\\s\\S]*?\\b${symRe}\\b[\\s\\S]*?${fillRe}`,
    "i"
  ));

  if (m) {
    const action = m[1].toUpperCase().replace(/\s+/g, " ");
    const qty = Math.abs(parseInt(m[2], 10));
    const symbol = m[3].toUpperCase();
    const fill = Number(m[4]);

    out.instrument = "stock";
    out.action = action;
    out.symbol = symbol;
    out.qty = Number.isFinite(qty) ? qty : null;
    out.fill = Number.isFinite(fill) ? fill : null;

    const prefix = isExitAction(action) ? "exit long " : "long ";
    out.rdt.matched = "stock";
    out.rdt.text = `${prefix}${symbol} at ${fill}`;

    out.trade_role = isExitAction(action) ? "close" : "open";
    out.pos_side = "long";
    out.contract_key = `STK|${symbol}`;

    return out;
  }

  return out;
}

function makeEntryExitFilename(parsed, received_at, trade_id) {
  const datePart = new Date(received_at).toISOString().slice(0, 10);
  const symbol = (parsed.symbol || "unknown").toLowerCase();

  let sideText = "unknown";
  const txt = String(parsed.rdt?.text || "").toLowerCase();

  if (txt.startsWith("exit long ")) sideText = "exit-long";
  else if (txt.startsWith("exit short ")) sideText = "exit-short";
  else if (txt.startsWith("long ")) sideText = "long";
  else if (txt.startsWith("short ")) sideText = "short";

  let contractText = "";
  if (parsed.instrument === "option" && parsed.option) {
    const strike = String(parsed.option.strike ?? "").replace(/\.0$/, "");
    const right = String(parsed.option.right ?? "").toLowerCase();
    contractText = `_${strike}${right}`;
  }

  return `${datePart}_${symbol}_${sideText}${contractText}_${trade_id}.json`;
}

function makeCompletedTradeFilename(t) {
  const datePart = new Date(t.entry.received_at).toISOString().slice(0, 10);
  const symbol = (t.symbol || "unknown").toLowerCase();
  const side = (t.pos_side || "unknown").toLowerCase();

  let contractText = "";
  if (t.instrument === "option" && t.option) {
    const strike = String(t.option.strike ?? "").replace(/\.0$/, "");
    const right = String(t.option.right ?? "").toLowerCase();
    contractText = `_${strike}${right}`;
  }

  return `${datePart}_${symbol}_${side}${contractText}_${t.completed_trade_id}.json`;
}

function buildCompletedTrades(cleanedLogs) {
  const openQueues = new Map();
  const trades = new Map();

  function qKey(e) {
    return `${e.contract_key}|${e.pos_side}`;
  }

  function enqueue(key, id) {
    if (!openQueues.has(key)) openQueues.set(key, []);
    openQueues.get(key).push(id);
  }

  function dequeue(key) {
    const q = openQueues.get(key) || [];
    return q.length ? q.shift() : null;
  }

  for (const e of cleanedLogs) {
    if (!e.contract_key || !e.trade_role || !e.pos_side) continue;
    if (e.trade_role === "unknown" || e.pos_side === "unknown") continue;

    const key = qKey(e);

    if (e.trade_role === "open") {
      const completed_trade_id = e.trade_id;

      trades.set(completed_trade_id, {
        schema_version: 1,
        completed_trade_id,
        status: "open",
        contract_key: e.contract_key,
        instrument: e.instrument,
        pos_side: e.pos_side,
        symbol: e.symbol,
        option: e.option ?? null,
        qty_opened: e.qty ?? null,
        qty_closed: 0,
        entry: {
          trade_id: e.trade_id,
          received_at: e.received_at,
          fill: e.fill,
          rdt: e.rdt?.text ?? ""
        },
        exits: [],
        pnl: null
      });

      enqueue(key, completed_trade_id);
    }

    if (e.trade_role === "close") {
      const openId = dequeue(key);
      if (!openId || !trades.has(openId)) {
        continue;
      }

      const t = trades.get(openId);
      const exitQty = e.qty ?? 0;

      t.exits.push({
        trade_id: e.trade_id,
        received_at: e.received_at,
        fill: e.fill,
        qty: exitQty || null,
        rdt: e.rdt?.text ?? ""
      });

      t.qty_closed += (exitQty || 0);

      if (t.qty_opened != null && t.qty_closed >= t.qty_opened) {
        t.status = "closed";
      }

      if (t.entry?.fill != null && t.exits.length) {
        const entryFill = Number(t.entry.fill);
        const mult = t.instrument === "option" ? 100 : 1;

        let realized = 0;
        for (const x of t.exits) {
          if (x.fill == null || x.qty == null) continue;
          const q = Number(x.qty);
          const exitFill = Number(x.fill);

          if (t.pos_side === "long") realized += (exitFill - entryFill) * q * mult;
          if (t.pos_side === "short") realized += (entryFill - exitFill) * q * mult;
        }

        t.pnl = {
          realized: Number.isFinite(realized) ? realized : null,
          currency: "USD"
        };
      }
    }
  }

  return [...trades.values()]
    .filter(t => t.status === "closed")
    .sort((a, b) => {
      const ta = new Date(a.entry?.received_at ?? 0).getTime();
      const tb = new Date(b.entry?.received_at ?? 0).getTime();
      if (ta !== tb) return ta - tb;
      return (a.completed_trade_id || "").localeCompare(b.completed_trade_id || "");
    });
}

function main() {
  const inboxDir = path.join(ROOT, "inbox");
  const inboxFiles = listFiles(inboxDir);

  if (inboxFiles.length === 0) {
    console.log("No inbox files found in inbox/. Rebuilding outputs from existing cleaned logs only.");
  }

  const processedThisRun = [];

  for (const inboxPath of inboxFiles) {
    const inbox = readJson(inboxPath);

    const raw = String(
      inbox.Trade ??
      inbox.trade ??
      inbox.raw ??
      inbox.text ??
      ""
    ).trim();

    const tradeTimestampRaw =
      inbox.Timestamp ??
      inbox.timestamp ??
      inbox["Time Received UTC (Github)"] ??
      inbox["Time Received EST (Github)"] ??
      inbox.received_at ??
      inbox.receivedAt ??
      inbox.date ??
      null;

    const received_at = parseDateToIso(tradeTimestampRaw);

    const ingested_at = tryParseDateToIso(
      inbox["Time Received UTC (Github)"] ??
      inbox["Time Received EST (Github)"] ??
      null
    );

    const rawId = String(
      inbox["ID:"] ??
      inbox.ID ??
      inbox.id ??
      path.basename(inboxPath, ".json")
    );

    const trade_id = sha1(`${rawId}|${received_at}|${raw}`).slice(0, 12);

    const month = isoMonth(received_at);
    const year = month.slice(0, 4);

    const parsed = parseRaw(raw, new Date(received_at));
    const entryExitFilename = makeEntryExitFilename(parsed, received_at, trade_id);

    const entryExitPath = path.join(
      ROOT,
      "trades",
      "entries-exits",
      year,
      month,
      entryExitFilename
    );

    const cleaned = {
      schema_version: 1,
      trade_id,
      received_at,
      source: {
        system: "zapier_github_inbox",
        inbox_path: path.relative(ROOT, inboxPath).replace(/\\/g, "/"),
        archived_path: null,
        raw_id: rawId,
        ingested_at
      },
      raw: { text: raw },

      instrument: parsed.instrument,
      paper: parsed.paper,
      action: parsed.action,
      symbol: parsed.symbol,
      qty: parsed.qty,
      fill: parsed.fill,
      option: parsed.option,

      computed: {
        month,
        dte: parsed.computed.dte,
        wiki_ok: parsed.computed.wiki_ok
      },

      rdt: parsed.rdt,
      trade_role: parsed.trade_role,
      pos_side: parsed.pos_side,
      contract_key: parsed.contract_key
    };

    writeJson(entryExitPath, cleaned);

    const archivedPath = archiveInboxFile(inboxPath, received_at);
    cleaned.source.archived_path = archivedPath;

    writeJson(entryExitPath, cleaned);
    processedThisRun.push(cleaned);
  }

  const entriesExitsRoot = path.join(ROOT, "trades", "entries-exits");
  let cleanedLogs = walkJsonFiles(entriesExitsRoot).map(readJson);

  const byId = new Map();
  for (const e of cleanedLogs) {
    const prev = byId.get(e.trade_id);
    if (!prev) byId.set(e.trade_id, e);
    else if (new Date(e.received_at) >= new Date(prev.received_at)) byId.set(e.trade_id, e);
  }
  cleanedLogs = [...byId.values()];

  cleanedLogs.sort(sortTradesForPosting);

  const months = [...new Set(cleanedLogs.map(e => e.computed?.month).filter(Boolean))].sort();

  writeJson(path.join(ROOT, "trades", "index-of-months.json"), {
    generated_at: new Date().toISOString(),
    months
  });

  const monthlyEntryExitLogsDir = path.join(ROOT, "trades", "monthly-entryexit-logs");
  fs.mkdirSync(monthlyEntryExitLogsDir, { recursive: true });

  for (const m of months) {
    writeJson(
      path.join(monthlyEntryExitLogsDir, `${m}.json`),
      cleanedLogs.filter(e => e.computed?.month === m)
    );
  }

  const currentMonth = isoMonth(new Date().toISOString());

  writeJson(
    path.join(ROOT, "month-to-date.json"),
    cleanedLogs.filter(e => e.computed?.month === currentMonth)
  );

  const londonTodayYmd = getDatePartsInTimeZone(new Date(), LOCAL_TZ).ymd;
  const londonWeekStartYmd = mondayOfWeekYmd(new Date(), LOCAL_TZ);

  writeJson(
    path.join(ROOT, "week-to-date.json"),
    cleanedLogs.filter(e => {
      const eventYmd = getDatePartsInTimeZone(e.received_at, LOCAL_TZ).ymd;
      return eventYmd >= londonWeekStartYmd && eventYmd <= londonTodayYmd;
    })
  );

  const completedTrades = buildCompletedTrades(cleanedLogs);
  const completedRoot = path.join(ROOT, "trades", "completed-trades");
  fs.mkdirSync(completedRoot, { recursive: true });

  for (const t of completedTrades) {
    const ym = isoMonth(t.entry.received_at);
    const yy = ym.slice(0, 4);
    const completedFilename = makeCompletedTradeFilename(t);
    const fp = path.join(completedRoot, yy, ym, completedFilename);
    writeJson(fp, t);
  }

  const completedMonths = [...new Set(
    completedTrades.map(t => isoMonth(t.entry.received_at))
  )].sort();

  const completedTradesMonthlyLogDir = path.join(ROOT, "trades", "completed-trades-monthlylog");
  fs.mkdirSync(completedTradesMonthlyLogDir, { recursive: true });

  for (const m of completedMonths) {
    writeJson(
      path.join(completedTradesMonthlyLogDir, `${m}.json`),
      completedTrades.filter(t => isoMonth(t.entry.received_at) === m)
    );
  }

  const latestHistoricalTrade = cleanedLogs.length ? cleanedLogs[cleanedLogs.length - 1] : null;

  const processedById = new Map();
  for (const t of processedThisRun) {
    const prev = processedById.get(t.trade_id);
    if (!prev) processedById.set(t.trade_id, t);
    else if (new Date(t.received_at) >= new Date(prev.received_at)) processedById.set(t.trade_id, t);
  }

  const processedThisRunOrdered = [...processedById.values()].sort(sortTradesForPosting);
  const latestProcessedTrade = processedThisRunOrdered.length
    ? processedThisRunOrdered[processedThisRunOrdered.length - 1]
    : null;

  let commitMessage = "build: parse inbox trades";
  if (latestProcessedTrade?.rdt?.text) {
    commitMessage = latestProcessedTrade.rdt.text;
  } else if (latestHistoricalTrade?.rdt?.text) {
    commitMessage = latestHistoricalTrade.rdt.text;
  }

  writeJson(path.join(ROOT, "trades", "_meta.json"), {
    generated_at: new Date().toISOString(),
    latest_commit_message: commitMessage,
    latest_processed_trade_id: latestProcessedTrade?.trade_id ?? null,
    processed_trade_ids_this_run: processedThisRunOrdered.map(t => t.trade_id)
  });

  console.log(`Inbox files: ${inboxFiles.length}`);
  console.log(`Cleaned entry/exit logs: ${cleanedLogs.length}`);
  console.log(`Months: ${months.length}`);
  console.log(`Completed trades: ${completedTrades.length}`);
  console.log(`Processed this run: ${processedThisRunOrdered.length}`);
  console.log(`Week start (${LOCAL_TZ}): ${londonWeekStartYmd}`);
}

main();
