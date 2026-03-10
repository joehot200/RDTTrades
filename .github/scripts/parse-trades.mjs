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

function formatDiscordMessage(trade) {
  const parts = [];

  parts.push("**Trade Alert**");

  if (trade.paper) {
    parts.push("🧪 PaperMoney");
  }

  // Main RDT-style line from your parser
  parts.push("`" + (trade.rdt?.text ?? "Trade alert") + "`");

  if (trade.qty != null) {
    parts.push(`Qty: ${trade.qty}`);
  }

  if (trade.received_at) {
    parts.push(`Time: ${trade.received_at}`);
  }

  if (trade.raw?.text && trade.raw.text !== trade.rdt?.text) {
    parts.push(`Raw: ${trade.raw.text}`);
  }

  return parts.join("\n");
}

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} ${body}`);
  }
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Missing DISCORD_WEBHOOK_URL secret");
  }

  const entriesExitsRoot = path.join(ROOT, "trades", "entries-exits");
  const files = walkJsonFiles(entriesExitsRoot);

  if (files.length === 0) {
    console.log("No cleaned trade files found; skipping Discord post.");
    return;
  }

  const cleanedLogs = files.map(readJson).filter(x =>
    x &&
    x.trade_id &&
    x.received_at &&
    x.rdt &&
    typeof x.rdt.text === "string"
  );

  if (cleanedLogs.length === 0) {
    console.log("No valid cleaned logs found; skipping Discord post.");
    return;
  }

  cleanedLogs.sort((a, b) => {
    const ta = new Date(a.received_at).getTime();
    const tb = new Date(b.received_at).getTime();
    if (ta !== tb) return ta - tb;
    return (a.trade_id || "").localeCompare(b.trade_id || "");
  });

  const latest = cleanedLogs[cleanedLogs.length - 1];
  const message = formatDiscordMessage(latest);

  await postToDiscord(webhookUrl, message);

  console.log(`Posted latest trade to Discord: ${latest.rdt?.text ?? latest.trade_id}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
