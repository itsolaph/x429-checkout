// A small busy API behind x429, with Express. Configuration from env (see ../README.md).
import express from "express";
import { x429 } from "x429";
import { x429Express } from "x429/express";

const env = (name, fallback) => {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`set ${name} (see examples/README.md)`);
  return v;
};
const port = Number(env("PORT", "3000"));

/** The API itself: a made-up forecast. `admission` is set when a ticket from the line is served. */
function forecast(city, admission) {
  const name = typeof city === "string" && city ? city.slice(0, 40) : "Lisbon";
  return { city: name, summary: `${name}: 14 to 19 °C, dry`, via: admission ? `x429 ticket #${admission.ticketId}` : "direct" };
}

const lane = await x429({
  contract: env("X429_CONTRACT"),
  queueId: Number(env("X429_QUEUE_ID", "1")),
  rpcUrl: env("X429_RPC_URL"),
  chainId: Number(env("X429_CHAIN_ID", "8453")),
  operatorKeyFile: env("X429_OPERATOR_KEY_FILE"),
  publicUrl: env("X429_PUBLIC_URL", `http://127.0.0.1:${port}`),
  capacity: { perIntervalMs: Number(env("X429_PER_INTERVAL_MS", "15000")) },
  deployBlock: env("X429_DEPLOY_BLOCK", "0"),
  // answers a ticket inside its paid skip (and on /x429/use), so one paid call returns the forecast
  serve: (admission, params) => forecast(params.city, admission),
  logger: (entry) => console.log(JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
});

const app = express();
app.disable("x-powered-by");
app.use("/x429", x429Express(lane)); // join, skip, use, ticket, quote, queue, feed
app.get("/forecast", x429Express(lane), (req, res) => {
  res.json(forecast(req.query.city, req.x429.admission));
});

const server = app.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ evt: "listening", url: `http://127.0.0.1:${port}`, operator: lane.operator })));
const stop = () => {
  lane.stop();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
