import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

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
  return new Date(iso).toISOString().slice(0, 7); // YYYY-MM
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

    // joining helpers
    trade_role: "unknown", // open / close / unknown
    pos_side: "unknown",   // actual position side
    contract_key: null
  };

  const actionRe = `(${ACTION_WORDS.map(a => a.replace(/ /g, "\\s+")).join("|")})`;
  const qtyRe = "([+-]?\\d+)";
  const symRe = "([A-Z]{1,6})";
  const dateRe = "(\\d{1,2})\\s+([A-Z]{3})\\s+(\\d{2,4})";
  const strikeRe = "(\\d+(?:\\.\\d+)?)\\s+(CALL|PUT)";
  const fillRe = "(?:@|\\bAT\\b)\\s*(\\d*\\.?\\d+)";

  // OPTION TRADE
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

    // RDT-style bias text:
    // Calls = long
    // Long puts = short
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

  // STOCK TRADE
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

    // long-only stock pairing for now
    out.trade_role = isExitAction(action) ? "close" : "open";
    out.pos_side = "long";
    out.contract_key = `STK|${symbol}`;

    return out;
  }

  return out;
}

function buildCompletedTrades(events) {
  const openQueues = new Map(); // key => [trade_id, ...]
  const trades = new Map();     // trade_id => completed-trade object

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

  for (const e of events) {
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
    console.log("No inbox files found.");
    return;
  }

  const now = new Date();

  // inbox -> entries-exits
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

    const received_at = tradeTimestampRaw
      ? new Date(tradeTimestampRaw).toISOString()
      : new Date().toISOString();

    const ingested_at =
      inbox["Time Received UTC (Github)"] ??
      inbox["Time Received EST (Github)"] ??
      null;

    const rawId = String(
      inbox["ID:"] ??
      inbox.ID ??
      inbox.id ??
      path.basename(inboxPath, ".json")
    );

    const trade_id = sha1(`${rawId}|${received_at}|${raw}`).slice(0, 12);

    const month = isoMonth(received_at);
    const year = month.slice(0, 4);

    const entryExitPath = path.join(
      ROOT,
      "trades",
      "entries-exits",
      year,
      month,
      `${trade_id}.json`
    );

    const parsed = parseRaw(raw, now);

    const cleaned = {
      schema_version: 1,
      trade_id,
      received_at,
      source: {
        system: "zapier_github_inbox",
        inbox_path: path.relative(ROOT, inboxPath).replace(/\\/g, "/"),
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
  }

  // rebuild all cleaned entry-exit logs
  const entriesExitsRoot = path.join(ROOT, "trades", "entries-exits");
  let cleanedLogs = walkJsonFiles(entriesExitsRoot).map(readJson);

  // dedupe by trade_id
  const byId = new Map();
  for (const e of cleanedLogs) {
    const prev = byId.get(e.trade_id);
    if (!prev) byId.set(e.trade_id, e);
    else if (new Date(e.received_at) >= new Date(prev.received_at)) byId.set(e.trade_id, e);
  }
  cleanedLogs = [...byId.values()];

  cleanedLogs.sort((a, b) => {
    const ta = new Date(a.received_at).getTime();
    const tb = new Date(b.received_at).getTime();
    if (ta !== tb) return ta - tb;
    return (a.trade_id || "").localeCompare(b.trade_id || "");
  });

  const months = [...new Set(cleanedLogs.map(e => e.computed?.month).filter(Boolean))].sort();

  writeJson(path.join(ROOT, "trades", "index-of-months.json"), {
    generated_at: new Date().toISOString(),
    months
  });

  const monthlyLogsDir = path.join(ROOT, "trades", "monthly-logs");
  fs.mkdirSync(monthlyLogsDir, { recursive: true });

  for (const m of months) {
    writeJson(
      path.join(monthlyLogsDir, `${m}.json`),
      cleanedLogs.filter(e => e.computed?.month === m)
    );
  }

  const currentMonth = isoMonth(new Date().toISOString());

  writeJson(
    path.join(ROOT, "trades", "month-to-date.json"),
    cleanedLogs.filter(e => e.computed?.month === currentMonth)
  );

  // completed trades
  const completedTrades = buildCompletedTrades(cleanedLogs);

  const completedRoot = path.join(ROOT, "trades", "completed-trades");
  fs.mkdirSync(completedRoot, { recursive: true });

  for (const t of completedTrades) {
    const ym = isoMonth(t.entry.received_at);
    const yy = ym.slice(0, 4);
    const fp = path.join(completedRoot, yy, ym, `${t.completed_trade_id}.json`);
    writeJson(fp, t);
  }

  const completedMonths = [...new Set(
    completedTrades.map(t => isoMonth(t.entry.received_at))
  )].sort();

  writeJson(path.join(ROOT, "trades", "completed-index-of-months.json"), {
    generated_at: new Date().toISOString(),
    months: completedMonths
  });

  const completedMonthlyLogsDir = path.join(ROOT, "trades", "completed-monthly-logs");
  fs.mkdirSync(completedMonthlyLogsDir, { recursive: true });

  for (const m of completedMonths) {
    writeJson(
      path.join(completedMonthlyLogsDir, `${m}.json`),
      completedTrades.filter(t => isoMonth(t.entry.received_at) === m)
    );
  }

  writeJson(
    path.join(ROOT, "trades", "completed-month-to-date.json"),
    completedTrades.filter(t => isoMonth(t.entry.received_at) === currentMonth)
  );

  console.log(`Inbox files: ${inboxFiles.length}`);
  console.log(`Cleaned entry/exit logs: ${cleanedLogs.length}`);
  console.log(`Months: ${months.length}`);
  console.log(`Completed trades: ${completedTrades.length}`);
}

main();
