import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const MONTH = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

const ACTION_WORDS = [
  "BOT","SOLD","BTO","STC","STO","BTC",
  "BUY TO OPEN","SELL TO CLOSE","SELL TO OPEN","BUY TO CLOSE"
];

function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }
function pad2(n) { return String(n).padStart(2, "0"); }
function readJson(fp) { return JSON.parse(fs.readFileSync(fp, "utf8")); }

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
  return ["SOLD","STC","SELL TO CLOSE","BTC","BUY TO CLOSE"].includes(a);
}

function classifyOptionAction(actionUpper) {
  const a = actionUpper.toUpperCase();
  // long option
  if (["BOT","BTO","BUY TO OPEN"].includes(a)) return { role: "open", pos_side: "long" };
  if (["SOLD","STC","SELL TO CLOSE"].includes(a)) return { role: "close", pos_side: "long" };
  // short option (premium selling)
  if (["STO","SELL TO OPEN"].includes(a)) return { role: "open", pos_side: "short" };
  if (["BTC","BUY TO CLOSE"].includes(a)) return { role: "close", pos_side: "short" };
  // fallback: treat SOLD as close, BOT as open
  if (a.includes("SELL")) return { role: "close", pos_side: "long" };
  if (a.includes("BUY"))  return { role: "open",  pos_side: "long" };
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
    rdt: { matched: "none", text: text || "Trade alert received (no text found)." },
    computed: { dte: -1, wiki_ok: false },

    // for pairing
    trade_role: "unknown",     // open / close / unknown
    pos_side: "unknown",       // long / short (position side, not RDT bias)
    contract_key: null,        // e.g. OPT|IBM|2026-03-06|260|P
  };

  const actionRe = `(${ACTION_WORDS.map(a => a.replace(/ /g, "\\s+")).join("|")})`;
  const qtyRe = "([+-]?\\d+)";
  const symRe = "([A-Z]{1,6})";
  const dateRe = "(\\d{1,2})\\s+([A-Z]{3})\\s+(\\d{2,4})";
  const strikeRe = "(\\d+(?:\\.\\d+)?)\\s+(CALL|PUT)";
  const fillRe = "(?:@|\\bAT\\b)\\s*(\\d*\\.?\\d+)";

  // OPTION
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
    out.option = { expiry: expiryIso, strike, right };

    const expiryMmdd = expiryIso ? `${expiryIso.slice(5, 7)}/${expiryIso.slice(8, 10)}` : "??/??";

    // RDT BIAS convention you asked for:
    // - Calls = long
    // - Long puts = "short"
    const bias = right === "C" ? "long" : "short";
    const prefix = isExitAction(action) ? "exit " : "";
    const typeWord = right === "C" ? "Call" : "Put";

    out.rdt.matched = "options";
    out.rdt.text = `${prefix}${bias} ${symbol} $${strike} ${typeWord} for ${expiryMmdd} at ${fill}`;

    const dte = computeDte(expiryIso, now);
    out.computed.dte = dte;
    out.computed.wiki_ok = dte >= 8;

    // pairing info
    const cls = classifyOptionAction(action);
    out.trade_role = cls.role;
    out.pos_side = cls.pos_side;
    out.contract_key = `OPT|${symbol}|${expiryIso ?? "UNKNOWN"}|${strike}|${right}`;

    return out;
  }

  // STOCK fallback
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

    // pairing info (long-only for now)
    out.trade_role = isExitAction(action) ? "close" : "open";
    out.pos_side = "long";
    out.contract_key = `STK|${symbol}`;

    return out;
  }

  return out;
}

function buildRoundtrips(events) {
  // Deterministic round-trip joining from events (chronological FIFO per contract+pos_side)
  const openQueues = new Map(); // key => [roundtripId1, roundtripId2,...]
  const trips = new Map();      // roundtrip_id => trip object

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
      // One roundtrip per opening event (can have multiple exits if partials happen)
      const roundtrip_id = e.trade_id;
      const trip = {
        schema_version: 1,
        roundtrip_id,
        status: "open",
        contract_key: e.contract_key,
        instrument: e.instrument,
        pos_side: e.pos_side,         // long/short position side
        bias_text: e.rdt?.text ?? "", // the “long/short” RDT-style line for the entry
        symbol: e.symbol,
        option: e.option ?? null,
        qty_opened: e.qty ?? null,
        qty_closed: 0,
        entry: {
          trade_id: e.trade_id,
          received_at: e.received_at,
          fill: e.fill,
          rdt: e.rdt?.text ?? "",
        },
        exits: [],
        pnl: null,
      };
      trips.set(roundtrip_id, trip);
      enqueue(key, roundtrip_id);
    }

    if (e.trade_role === "close") {
      const openId = dequeue(key);

      // If we can't find an opener (e.g., history missing), keep as orphan close
      if (!openId || !trips.has(openId)) {
        const orphanId = `orphan_${e.trade_id}`;
        trips.set(orphanId, {
          schema_version: 1,
          roundtrip_id: orphanId,
          status: "orphan_close",
          contract_key: e.contract_key,
          instrument: e.instrument,
          pos_side: e.pos_side,
          symbol: e.symbol,
          option: e.option ?? null,
          qty_opened: null,
          qty_closed: e.qty ?? null,
          entry: null,
          exits: [{
            trade_id: e.trade_id,
            received_at: e.received_at,
            fill: e.fill,
            qty: e.qty ?? null,
            rdt: e.rdt?.text ?? "",
          }],
          pnl: null,
        });
        continue;
      }

      const trip = trips.get(openId);
      const exitQty = e.qty ?? 0;

      trip.exits.push({
        trade_id: e.trade_id,
        received_at: e.received_at,
        fill: e.fill,
        qty: exitQty || null,
        rdt: e.rdt?.text ?? "",
      });

      trip.qty_closed += (exitQty || 0);

      // If we know qty_opened and we've closed it all, mark closed; otherwise keep open (supports partials)
      if (trip.qty_opened != null && trip.qty_closed >= trip.qty_opened) {
        trip.status = "closed";
      }

      // Compute PnL if we have fills (simple; assumes same contract, ignores commissions)
      if (trip.entry?.fill != null && trip.exits.length) {
        const entryFill = Number(trip.entry.fill);
        const mult = (trip.instrument === "option") ? 100 : 1;

        let realized = 0;
        for (const x of trip.exits) {
          if (x.fill == null || x.qty == null) continue;
          const q = Number(x.qty);
          const exitFill = Number(x.fill);

          if (trip.pos_side === "long") realized += (exitFill - entryFill) * q * mult;
          if (trip.pos_side === "short") realized += (entryFill - exitFill) * q * mult;
        }

        trip.pnl = {
          realized: Number.isFinite(realized) ? realized : null,
          currency: "USD",
        };
      }
    }
  }

  // Return deterministic list (sort by entry time if present, else by first exit)
  const arr = [...trips.values()];
  arr.sort((a, b) => {
    const ta = a.entry?.received_at ? new Date(a.entry.received_at).getTime() : (a.exits[0]?.received_at ? new Date(a.exits[0].received_at).getTime() : 0);
    const tb = b.entry?.received_at ? new Date(b.entry.received_at).getTime() : (b.exits[0]?.received_at ? new Date(b.exits[0].received_at).getTime() : 0);
    if (ta !== tb) return ta - tb;
    return (a.roundtrip_id || "").localeCompare(b.roundtrip_id || "");
  });
  return arr;
}

function main() {
  const inboxDir = path.join(ROOT, "trades", "inbox");
  const inboxFiles = listFiles(inboxDir);
  if (inboxFiles.length === 0) {
    console.log("No inbox files found.");
    return;
  }

  const now = new Date();

  // inbox → events
  for (const inboxPath of inboxFiles) {
    const inbox = readJson(inboxPath);

    const receivedAtRaw = inbox.received_at || inbox.receivedAt || inbox.date || now.toISOString();
    const received_at = new Date(receivedAtRaw).toISOString();

    const raw = (inbox.raw || inbox.text || "").trim();
    const rawId = path.basename(inboxPath, ".json");

    const trade_id = sha1(`${rawId}|${received_at}|${raw}`).slice(0, 12);

    const month = isoMonth(received_at);
    const year = month.slice(0, 4);

    const eventPath = path.join(ROOT, "trades", "events", year, month, `${trade_id}.json`);

    const parsed = parseRaw(raw, now);

    const event = {
      schema_version: 1,
      trade_id,
      received_at,
      source: {
        system: "zapier_github_inbox",
        inbox_path: path.relative(ROOT, inboxPath).replace(/\\/g, "/"),
        raw_id: rawId,
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
        wiki_ok: parsed.computed.wiki_ok,
      },

      rdt: parsed.rdt,

      // pairing helpers
      trade_role: parsed.trade_role,
      pos_side: parsed.pos_side,
      contract_key: parsed.contract_key,
    };

    writeJson(eventPath, event);
  }

  // events → rollups
  const eventsRoot = path.join(ROOT, "trades", "events");
  let events = walkJsonFiles(eventsRoot).map(readJson);

  // Dedup by trade_id (keep latest received_at)
  const byId = new Map();
  for (const e of events) {
    const prev = byId.get(e.trade_id);
    if (!prev) byId.set(e.trade_id, e);
    else if (new Date(e.received_at) >= new Date(prev.received_at)) byId.set(e.trade_id, e);
  }
  events = [...byId.values()];

  // Deterministic sort
  events.sort((a, b) => {
    const ta = new Date(a.received_at).getTime();
    const tb = new Date(b.received_at).getTime();
    if (ta !== tb) return ta - tb;
    return (a.trade_id || "").localeCompare(b.trade_id || "");
  });

  // month rollups
  const months = [...new Set(events.map(e => e.computed?.month).filter(Boolean))].sort();
  writeJson(path.join(ROOT, "trades", "index.json"), {
    generated_at: new Date().toISOString(),
    months,
  });

  const monthsDir = path.join(ROOT, "trades", "months");
  fs.mkdirSync(monthsDir, { recursive: true });
  for (const m of months) {
    writeJson(path.join(monthsDir, `${m}.json`), events.filter(e => e.computed?.month === m));
  }

  const currentMonth = isoMonth(new Date().toISOString());
  writeJson(
    path.join(ROOT, "trades", "this-month.json"),
    events.filter(e => e.computed?.month === currentMonth)
  );

  // -------- roundtrip joining --------
  const roundtrips = buildRoundtrips(events);

  const rtRoot = path.join(ROOT, "trades", "roundtrips");
  fs.mkdirSync(rtRoot, { recursive: true });

  // write per-trade files, stored under entry month when possible
  for (const t of roundtrips) {
    const anchorIso = t.entry?.received_at || t.exits?.[0]?.received_at || new Date().toISOString();
    const ym = isoMonth(anchorIso);
    const yy = ym.slice(0, 4);
    const fp = path.join(rtRoot, yy, ym, `${t.roundtrip_id}.json`);
    writeJson(fp, t);
  }

  // rollups for roundtrips
  const rtMonths = [...new Set(roundtrips.map(t => {
    const anchorIso = t.entry?.received_at || t.exits?.[0]?.received_at;
    return anchorIso ? isoMonth(anchorIso) : null;
  }).filter(Boolean))].sort();

  writeJson(path.join(rtRoot, "index.json"), {
    generated_at: new Date().toISOString(),
    months: rtMonths,
  });

  const rtMonthsDir = path.join(rtRoot, "months");
  fs.mkdirSync(rtMonthsDir, { recursive: true });
  for (const m of rtMonths) {
    const arr = roundtrips.filter(t => {
      const anchorIso = t.entry?.received_at || t.exits?.[0]?.received_at;
      return anchorIso ? isoMonth(anchorIso) === m : false;
    });
    writeJson(path.join(rtMonthsDir, `${m}.json`), arr);
  }

  writeJson(
    path.join(rtRoot, "this-month.json"),
    roundtrips.filter(t => {
      const anchorIso = t.entry?.received_at || t.exits?.[0]?.received_at;
      return anchorIso ? isoMonth(anchorIso) === currentMonth : false;
    })
  );

  console.log(`Inbox: ${inboxFiles.length}`);
  console.log(`Events: ${events.length}`);
  console.log(`Months: ${months.length}`);
  console.log(`This month (${currentMonth}) events: ${events.filter(e => e.computed?.month === currentMonth).length}`);
  console.log(`Roundtrips: ${roundtrips.length}`);
}

main();
