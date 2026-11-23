import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { SteamWorld } from "./world.ts";

export async function startSteamNode(): Promise<{ node: MSPNode; world: SteamWorld }> {
  const node = new MSPNode(process.env.STEAM_NODE_ID || "steam", mspOptionsFromEnv("STEAM"));
  const world = new SteamWorld({
    steamDir: process.env.STEAM_DIR || undefined,
    steamId: process.env.STEAM_ID || "",
    apiKey: process.env.STEAM_API_KEY || "",
    cc: process.env.STEAM_CC || "cn",
  });
  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[steam] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startSteamNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
