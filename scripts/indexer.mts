// Scrip action indexer: walks Base mainnet in 9.5k-block windows collecting the
// RARE B20 corporate-action events only: UIMultiplierUpdated (dividends and
// splits) and Announcement (issuer notices). Transfer churn never enters the
// store; statement trades come from the Blockscout public API at render time.
// All 13 registry tokens ride in one getLogs call per event kind per window.
import { decodeEventLog, type Abi } from "viem";
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";

const RPCS = process.env.SCRIP_RPC_URL
  ? [process.env.SCRIP_RPC_URL]
  : [
      "https://base.drpc.org", // free plan: up to 10k-block getLogs ranges, serves history
      "https://mainnet.base.org", // official; 9.5k ranges but rate-caps shared egress IPs
    ]; // publicnode is archive-gated and 1rpc caps ranges at 50 blocks - both useless here
const MAX_RANGE = 9_500n; // the public gateway's hard eth_getLogs range limit
const MAX_WINDOWS_PER_RUN = 12; // stay under the gateway's request cap per tick
const START_BLOCKS_BACK = process.env.SCRIP_START_BACK
  ? BigInt(process.env.SCRIP_START_BACK)
  : 8_000_000n; // about six months; Coinbase stock tokens launched mid-2026

const TOKENS = [
  "0xb200000000000000000000C2e324d24d7eEcd1fb", // AAPLc
  "0xb2000000000000000000001e800a7f5189430cD0", // TSLAc
  "0xb20000000000000000000078ee7ce2fE4908108C", // NVDAc
  "0xb200000000000000000000c85a31389D71F3ecfb", // COINc
  "0xb2000000000000000000002D0BA3164cc74f58B7", // GOOGLc
  "0xB200000000000000000000Ab99cFa739E253872B", // MSFTc
  "0xb2000000000000000000008bC8786B856E61707C", // METAc
  "0xb200000000000000000000d9192b6B456483C2E8", // AMZNc
  "0xb2000000000000000000004884b426556b92883d", // MSTRc
  "0xB20000000000000000000019f6E7C675b73C2e4D", // CRCLc
  "0xB2000000000000000000004AFF16039bA04bdFBc", // INTCc
  "0xb200000000000000000000397293Cb8cda9a10c5", // SNDKc
  "0xb2000000000000000000007b9fcbd005511aCBd5", // SPCXc
];

const TOPICS = {
  mult: "0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055",
  ann: "0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7",
};

const EVENT_ABIS: Record<string, Abi> = {
  mult: [
    {
      type: "event",
      name: "UIMultiplierUpdated",
      inputs: [
        { name: "oldMultiplier", type: "uint256", indexed: false },
        { name: "newMultiplier", type: "uint256", indexed: false },
        { name: "effectiveAtTimestamp", type: "uint256", indexed: false },
      ],
    },
  ],
  ann: [
    {
      type: "event",
      name: "Announcement",
      inputs: [
        { name: "caller", type: "address", indexed: true },
        { name: "id", type: "string", indexed: false },
        { name: "description", type: "string", indexed: false },
        { name: "uri", type: "string", indexed: false },
      ],
    },
  ],
};

const SYMBOL_MAP: Record<string, string> = {
  "0xb200000000000000000000c2e324d24d7eececd1fb": "AAPLc",
  "0xb2000000000000000000001e800a7f5189430cd0": "TSLAc",
  "0xb20000000000000000000078ee7ce2fe4908108c": "NVDAc",
  "0xb200000000000000000000c85a31389d71f3ecfb": "COINc",
  "0xb2000000000000000000002d0ba3164cc74f58b7": "GOOGLc",
  "0xb200000000000000000000ab99cfa739e253872b": "MSFTc",
  "0xb2000000000000000000008bc8786b856e61707c": "METAc",
  "0xb200000000000000000000d9192b6b456483c2e8": "AMZNc",
  "0xb2000000000000000000004884b426556b92883d": "MSTRc",
  "0xb20000000000000000000019f6e7c675b73c2e4d": "CRCLc",
  "0xb2000000000000000000004aff16039ba04bdfbc": "INTCc",
  "0xb200000000000000000000397293cb8cda9a10c5": "SNDKc",
  "0xb2000000000000000000007b9fcbd005511acbd5": "SPCXc",
};

function symbolFor(addr: string): string {
  return SYMBOL_MAP[addr.toLowerCase()] ?? addr.slice(0, 12);
}

let rpcId = 1;
let rpcIdx = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = RPCS[rpcIdx++ % RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const json: any = await res.json();
      if (json.error) {
        throw new Error(json.error.message ?? JSON.stringify(json.error).slice(0, 140));
      }
      return json.result;
    } catch (e: any) {
      // the gateway flaps under load ("no backend is currently healthy") and
      // rate-caps shared egress IPs; rotate providers and back off
      if (attempt === 7) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function getLogsSafe(fromB: bigint, toB: bigint, topics: string[]): Promise<any[]> {
  try {
    return await rpc("eth_getLogs", [
      {
        address: TOKENS,
        topics: [topics],
        fromBlock: "0x" + fromB.toString(16),
        toBlock: "0x" + toB.toString(16),
      },
    ]);
  } catch (e) {
    // bisection is for RANGE rejections only; rate limits must bubble up
    // immediately or every split multiplies the requests that just got capped
    if (/limit|rate/i.test((e as Error).message)) throw e;
    const span = toB - fromB;
    if (span <= 300n) throw e;
    const mid = fromB + span / 2n;
    const upper = await getLogsSafe(mid + 1n, toB, topics);
    const lower = await getLogsSafe(fromB, mid, topics);
    return [...lower, ...upper];
  }
}

async function blockTimestamps(blocks: bigint[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(blocks.map((b) => b.toString()))].map((s) => BigInt(s));
  const CHUNK = 8;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const results = await Promise.all(
      batch.map(async (b) => {
        const blk = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
        return [b.toString(), blk ? parseInt(blk.timestamp, 16) : 0] as const;
      }),
    );
    for (const [b, t] of results) map.set(b, t);
  }
  return map;
}

async function decodeAll(kind: "mult" | "ann", logs: any[]): Promise<string[]> {
  const out: string[] = [];
  const blocks = logs.map((l) => BigInt(l.blockNumber));
  const times = await blockTimestamps(blocks);
  for (const log of logs) {
    try {
      const { args, address } = decodeEventLog({
        abi: EVENT_ABIS[kind],
        data: log.data,
        topics: log.topics,
      });
      const b = parseInt(log.blockNumber, 16);
      const base = {
        sym: symbolFor(address as string),
        b,
        tx: log.transactionHash,
        t: times.get(String(b)) ?? 0,
      };
      if (kind === "mult") {
        const a = args as unknown as {
          oldMultiplier: bigint;
          newMultiplier: bigint;
          effectiveAtTimestamp: bigint;
        };
        out.push(
          JSON.stringify({
            k: "m",
            ...base,
            o: a.oldMultiplier.toString(),
            n: a.newMultiplier.toString(),
            e: a.effectiveAtTimestamp.toString(),
          }),
        );
      } else {
        const a = args as unknown as { id: string; description: string };
        out.push(JSON.stringify({ k: "a", ...base, i: a.id, d: a.description.slice(0, 300) }));
      }
    } catch {
      // undecodable log; skip
    }
  }
  return out;
}

async function main() {
  mkdirSync("data", { recursive: true });
  const outPath = "data/actions.jsonl";
  const cursorPath = "data/cursor.json";

  const head = BigInt(await rpc("eth_blockNumber", []));
  console.log("head:", head.toString());

  let cursor: bigint;
  if (existsSync(cursorPath)) {
    cursor = BigInt(JSON.parse(readFileSync(cursorPath, "utf8")).block);
    console.log("resuming from", cursor.toString());
  } else {
    cursor = head > START_BLOCKS_BACK ? head - START_BLOCKS_BACK : 1n;
    console.log("bootstrapping from", cursor.toString());
  }

  let last = cursor;
  let wrote = 0;
  let windows = 0;
  try {
    while (last < head && windows < MAX_WINDOWS_PER_RUN) {
      const to = last + MAX_RANGE > head ? head : last + MAX_RANGE;
      for (const [kind, topic] of Object.entries(TOPICS) as ["mult" | "ann", string][]) {
        const logs = await getLogsSafe(last + 1n, to, [topic]);
        const lines = await decodeAll(kind, logs);
        if (lines.length > 0) {
          appendFileSync(outPath, lines.join("\n") + "\n");
          wrote += lines.length;
        }
      }
      last = to;
      windows++;
      // stay polite to the shared gateway between windows
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    // gateway rate limits are expected and self-heal: persist the cursor and
    // let the next scheduled tick resume instead of failing the run
    console.error("stopping early at", last.toString(), "-", (e as Error).message);
  }

  writeFileSync(
    cursorPath,
    JSON.stringify({ block: last.toString(), updated: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log("done; events this run:", wrote, "at", last.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
