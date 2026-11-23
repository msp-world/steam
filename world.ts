/**
 * Steam 平台感知 MSP World（移植自 cortico-world-steam）：
 * - 本地只读解析 Steam 安装目录（libraryfolders.vdf / appmanifest_*.acf / loginusers.vdf）
 * - 可选结合 Steam Web API 与 Store API 查询在线状态、时长、成就与价格
 * - 工具：steam_now, steam_profile, steam_library, steam_playtime, steam_price
 * - 信号：steam.game_started, steam.game_stopped
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MSPNode } from "../shared/msp.ts";
import { parseVdf, type VdfObject } from "./vdf.ts";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface SteamConfig {
  steamDir?: string;
  steamId?: string;
  apiKey?: string;
  cc?: string;
  pollIntervalMs?: number;
}

export interface InstalledApp {
  appid: string;
  name: string;
  sizeOnDiskBytes: number;
  lastUpdated?: number;
}

function defaultSteamDir(): string {
  if (process.platform === "win32") return "C:\\Program Files (x86)\\Steam";
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/Steam");
  return path.join(os.homedir(), ".local/share/Steam");
}

export class SteamWorld {
  private readonly cfg: Required<SteamConfig>;
  private readonly fetchImpl: FetchImpl;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentApp: { appid: string; name: string } | null = null;

  constructor(config: SteamConfig = {}, fetchImpl?: FetchImpl) {
    this.cfg = {
      steamDir: config.steamDir ?? defaultSteamDir(),
      steamId: config.steamId ?? "",
      apiKey: config.apiKey ?? "",
      cc: config.cc ?? "cn",
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
    };
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("steam.game_started", "检测到开始运行 Steam 游戏");
    node.declareSignal("steam.game_stopped", "检测到退出 Steam 游戏");

    node.tool(
      "steam_profile",
      "读取本机登录的 Steam 账号信息（离线可读昵称与 SteamID64，有 API Key 时补充在线状态）",
      async () => this.getProfile(),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "steam_now",
      "查看当前正在玩的 Steam 游戏（需要 Steam Web API Key）",
      async () => this.getNowPlaying(),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "steam_library",
      "读取本机已安装的 Steam 游戏库（解析 libraryfolders.vdf 与 appmanifest_*.acf）",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 200) : 25;
        const apps = this.readInstalledApps();
        return { total: apps.length, returned: Math.min(apps.length, limit), apps: apps.slice(0, limit) };
      },
      { type: "object", properties: { limit: { type: "integer", default: 25 } } },
    );

    node.tool(
      "steam_playtime",
      "查询 Steam 游戏游玩时长排行或按名称筛选（需要 Steam Web API Key）",
      async (args) => this.getPlaytime(args),
      {
        type: "object",
        properties: {
          query: { type: "string" },
          top: { type: "integer", default: 10 },
        },
      },
    );

    node.tool(
      "steam_price",
      "通过 Steam Store 公开接口查询指定 appid 的当前价格与折扣",
      async (args) => this.getPrice(String(args.appid ?? "")),
      { type: "object", required: ["appid"], properties: { appid: { type: ["string", "integer"] } } },
    );
  }

  start(): void {
    if (this.timer || !this.cfg.apiKey) return;
    void this.pollNow();
    if (this.cfg.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollNow(), this.cfg.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  readLocalUsers(): Array<{ steamId64: string; accountName: string; personaName: string; mostRecent: boolean }> {
    const file = path.join(this.cfg.steamDir, "config/loginusers.vdf");
    if (!fs.existsSync(file)) return [];
    const parsed = parseVdf(fs.readFileSync(file, "utf8"));
    const users = (parsed.users ?? parsed.Users ?? {}) as VdfObject;
    const out: Array<{ steamId64: string; accountName: string; personaName: string; mostRecent: boolean }> = [];
    for (const [id, val] of Object.entries(users)) {
      if (typeof val !== "object") continue;
      out.push({
        steamId64: id,
        accountName: String(val.AccountName ?? ""),
        personaName: String(val.PersonaName ?? ""),
        mostRecent: String(val.MostRecent ?? "0") === "1",
      });
    }
    return out;
  }

  readInstalledApps(): InstalledApp[] {
    const libs: string[] = [];
    const vdfPath = path.join(this.cfg.steamDir, "steamapps/libraryfolders.vdf");
    if (fs.existsSync(vdfPath)) {
      const parsed = parseVdf(fs.readFileSync(vdfPath, "utf8"));
      const root = (parsed.libraryfolders ?? parsed.LibraryFolders ?? {}) as VdfObject;
      for (const entry of Object.values(root)) {
        if (typeof entry === "object" && typeof entry.path === "string") {
          libs.push(entry.path);
        }
      }
    }
    if (libs.length === 0 && fs.existsSync(path.join(this.cfg.steamDir, "steamapps"))) {
      libs.push(this.cfg.steamDir);
    }

    const apps: InstalledApp[] = [];
    for (const lib of libs) {
      const steamapps = path.join(lib, "steamapps");
      if (!fs.existsSync(steamapps)) continue;
      for (const f of fs.readdirSync(steamapps)) {
        if (!f.startsWith("appmanifest_") || !f.endsWith(".acf")) continue;
        const acf = parseVdf(fs.readFileSync(path.join(steamapps, f), "utf8"));
        const state = (acf.AppState ?? {}) as VdfObject;
        if (typeof state.appid === "string" && typeof state.name === "string") {
          apps.push({
            appid: state.appid,
            name: state.name,
            sizeOnDiskBytes: Number(state.SizeOnDisk ?? 0) || 0,
            ...(state.LastUpdated ? { lastUpdated: Number(state.LastUpdated) } : {}),
          });
        }
      }
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveSteamId(): string {
    if (this.cfg.steamId) return this.cfg.steamId;
    const users = this.readLocalUsers();
    const recent = users.find((u) => u.mostRecent) ?? users[0];
    return recent?.steamId64 ?? "";
  }

  private async getProfile(): Promise<Record<string, unknown>> {
    const localUsers = this.readLocalUsers();
    const steamId = this.resolveSteamId();
    const local = localUsers.find((u) => u.steamId64 === steamId) ?? localUsers[0] ?? null;
    if (!this.cfg.apiKey || !steamId) {
      return { source: "local", steamId: steamId || null, local };
    }
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(this.cfg.apiKey)}&steamids=${encodeURIComponent(steamId)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const player = json?.response?.players?.[0] ?? null;
    return { source: "web_api", steamId, local, player };
  }

  private async getNowPlaying(): Promise<Record<string, unknown>> {
    const prof = await this.getProfile();
    const player = prof.player as any;
    if (!player) {
      return { playing: false, note: this.cfg.apiKey ? "未获取到玩家在线信息" : "未配置 STEAM_API_KEY" };
    }
    if (!player.gameid) return { playing: false };
    return {
      playing: true,
      appid: String(player.gameid),
      game: String(player.gameextrainfo ?? player.gameid),
    };
  }

  private async pollNow(): Promise<void> {
    try {
      const now = await this.getNowPlaying();
      if (now.playing && typeof now.appid === "string") {
        if (!this.currentApp || this.currentApp.appid !== now.appid) {
          this.currentApp = { appid: now.appid, name: String(now.game ?? now.appid) };
          this.node?.publish("steam.game_started", this.currentApp);
        }
      } else if (this.currentApp) {
        const prev = this.currentApp;
        this.currentApp = null;
        this.node?.publish("steam.game_stopped", prev);
      }
    } catch {
      /* ignore */
    }
  }

  private async getPlaytime(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const steamId = this.resolveSteamId();
    if (!this.cfg.apiKey || !steamId) throw new Error("查询游玩时长需要配置 STEAM_API_KEY 与 STEAM_ID");
    const url =
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
      `?key=${encodeURIComponent(this.cfg.apiKey)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=true&include_played_free_games=true`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
    const json = (await res.json()) as any;
    let games = (json?.response?.games ?? []) as Array<{ appid: number; name: string; playtime_forever: number }>;
    const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    if (q) {
      games = games.filter((g) => g.name.toLowerCase().includes(q) || String(g.appid) === q);
    }
    games.sort((a, b) => b.playtime_forever - a.playtime_forever);
    const top = typeof args.top === "number" ? Math.min(Math.max(1, args.top), 50) : 10;
    return {
      total: games.length,
      games: games.slice(0, top).map((g) => ({
        appid: g.appid,
        name: g.name,
        hours: Number((g.playtime_forever / 60).toFixed(1)),
      })),
    };
  }

  private async getPrice(appid: string): Promise<Record<string, unknown>> {
    if (!/^\d+$/.test(appid)) throw new Error("appid 必须是纯数字");
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${encodeURIComponent(this.cfg.cc)}&l=schinese`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Steam Store HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const entry = json?.[appid];
    if (!entry?.success) throw new Error(`Steam Store 未找到 appid=${appid}`);
    const d = entry.data;
    return {
      appid,
      name: d.name,
      is_free: Boolean(d.is_free),
      price: d.price_overview ?? null,
    };
  }
}
