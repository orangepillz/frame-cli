import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  clamp,
  connectRemoteSession,
  discoverSamsungTvs,
  getAppStatus,
  getDefaultConfigPath,
  getInstalledApps,
  getMute,
  getPowerState,
  getTvInfo,
  getVolume,
  holdRemoteKey,
  launchApp,
  mergeConfigWithInfo,
  readConfig,
  sendRemoteKey,
  sendWakeOnLan,
  setMute,
  setVolume,
  waitForPowerState,
  writeConfig
} from "./samsung-tv.js";

const INPUT_KEYS = {
  source: "KEY_SOURCE",
  tv: "KEY_TV",
  hdmi1: "KEY_HDMI1",
  hdmi2: "KEY_HDMI2",
  hdmi3: "KEY_HDMI3",
  hdmi4: "KEY_HDMI4",
  home: "KEY_HOME",
  art: "KEY_AMBIENT"
};

// Well-known Samsung TV app IDs for popular streaming services
const WELL_KNOWN_APPS = {
  netflix: "3201907018807",
  youtube: "111299001912",
  hulu: "3201601007625",
  disney: "3201901017640",
  "disney+": "3201901017640",
  disneyplus: "3201901017640",
  hbo: "3201601007230",
  "hbo max": "3201601007230",
  max: "3201601007230",
  prime: "3201910019365",
  "prime video": "3201910019365",
  "amazon prime": "3201910019365",
  amazon: "3201910019365",
  peacock: "3201909019758",
  paramount: "3201910019354",
  "paramount+": "3201910019354",
  paramountplus: "3201910019354",
  apple: "3201807016597",
  "apple tv": "3201807016597",
  "apple tv+": "3201807016597",
  appletv: "3201807016597",
  spotify: "3201606009684",
  plex: "3201512006963",
  tubi: "3201504001965",
  crunchyroll: "3201908019286",
  twitch: "3201805016608",
  pluto: "3201812011795",
  "pluto tv": "3201812011795",
  vudu: "111012010001",
  browser: "org.tizen.browser",
  web: "org.tizen.browser"
};

function getCommandName() {
  return path.basename(process.argv[1] ?? "tv") || "tv";
}

function printHelp() {
  const commandName = getCommandName();

  const appNames = [...new Set(Object.keys(WELL_KNOWN_APPS).filter((k) => !/[ +]/.test(k) && k.length <= 12))].slice(0, 8);

  console.log(`Samsung TV CLI

Usage:
  ${commandName} discover [--json]
  ${commandName} info
  ${commandName} pair
  ${commandName} power <on|off|art|status>
  ${commandName} art
  ${commandName} volume <get|set|up|down> [value]
  ${commandName} mute <on|off|toggle|status>
  ${commandName} input <${Object.keys(INPUT_KEYS).join("|")}>
  ${commandName} app list [--json]
  ${commandName} app <name|appId> [--json]
  ${commandName} key <KEY_NAME>
  ${commandName} help

Options:
  --host <ip>          Override the TV IP address
  --config <path>      Config file path (default: ${getDefaultConfigPath()})
  --client-name <name> Override the Samsung websocket client name
  --json               Emit JSON where supported

Known Apps:
  ${appNames.join(", ")}, ...

Examples:
  ${commandName} discover
  ${commandName} info
  ${commandName} power off
  ${commandName} art
  ${commandName} volume set 10
  ${commandName} input hdmi1
  ${commandName} app netflix
  ${commandName} app hulu
  ${commandName} app list
`);
}

function parseArgs(argv) {
  const options = {
    configPath: getDefaultConfigPath(),
    json: false
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--host") {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--config") {
      options.configPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--client-name") {
      options.clientName = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    positional.push(arg);
  }

  return { options, positional };
}

async function saveConfig(configPath, currentConfig, info, extras = {}) {
  const nextConfig = mergeConfigWithInfo(currentConfig, info, extras);
  await writeConfig(configPath, nextConfig);
  return nextConfig;
}

function formatDevice(device) {
  return `${device.name} (${device.model ?? "unknown model"}) at ${device.host}`;
}

async function discoverOrResolveDevice(options, config, { requireInfo = false } = {}) {
  if (options.host) {
    const info = requireInfo ? await getTvInfo(options.host) : { host: options.host };
    return { info, config };
  }

  if (config.host) {
    if (!requireInfo) {
      return { info: { host: config.host }, config };
    }

    const info = await getTvInfo(config.host);
    return { info, config };
  }

  const devices = await discoverSamsungTvs();

  if (devices.length === 0) {
    throw new Error("No Samsung TVs were discovered on the local network");
  }

  if (devices.length > 1) {
    throw new Error(
      `Multiple Samsung TVs were discovered. Re-run with --host using one of: ${devices.map((device) => device.host).join(", ")}`
    );
  }

  return { info: requireInfo ? devices[0] : { host: devices[0].host }, config };
}

async function ensureRemoteCredentials(options, config) {
  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: true });
  const host = info.host;
  const clientName = options.clientName ?? config.clientName;
  const token = config.token ?? null;

  try {
    const session = await connectRemoteSession(host, { clientName, token });
    const nextConfig = await saveConfig(options.configPath, config, info, {
      clientName: session.clientName,
      token: session.token
    });
    session.ws.close();
    return { info, config: nextConfig };
  } catch (error) {
    const freshClientName = options.clientName ?? `samsung-tv-cli-${Date.now()}`;
    const session = await connectRemoteSession(host, { clientName: freshClientName });
    const nextConfig = await saveConfig(options.configPath, config, info, {
      clientName: session.clientName,
      token: session.token
    });
    session.ws.close();
    return { info, config: nextConfig, rePaired: true, cause: error };
  }
}

async function resolvePowerTarget(options, config) {
  const host = options.host ?? config.host;

  if (host) {
    try {
      const info = await getTvInfo(host);
      return {
        host,
        info,
        mac: info.mac ?? config.mac ?? null
      };
    } catch {
      return {
        host,
        info: null,
        mac: config.mac ?? null
      };
    }
  }

  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: true });
  return {
    host: info.host,
    info,
    mac: info.mac ?? config.mac ?? null
  };
}

async function handleDiscover(options) {
  const devices = await discoverSamsungTvs();

  if (options.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }

  if (devices.length === 0) {
    console.log("No Samsung TVs discovered");
    return;
  }

  for (const device of devices) {
    console.log(formatDevice(device));
  }
}

async function handleInfo(options, config) {
  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: true });
  const nextConfig = await saveConfig(options.configPath, config, info);

  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`${info.name}`);
  console.log(`Host: ${info.host}`);
  console.log(`Model: ${info.model ?? "unknown"}`);
  console.log(`Power: ${info.powerState ?? "unknown"}`);
  console.log(`MAC: ${info.mac ?? nextConfig.mac ?? "unknown"}`);
}

async function handlePair(options, config) {
  const result = await ensureRemoteCredentials(options, config);

  if (options.json) {
    console.log(JSON.stringify(result.config, null, 2));
    return;
  }

  console.log(`Paired with ${formatDevice(result.info)}`);
  console.log(`Token saved to ${options.configPath}`);
}

async function handlePower(action, options, config) {
  if (action === "status") {
    try {
      const target = await resolvePowerTarget(options, config);
      console.log(target.info?.powerState ?? "off");
    } catch {
      console.log("off");
    }

    return;
  }

  if (action === "on") {
    const target = await resolvePowerTarget(options, config);

    if (!target.host) {
      throw new Error("Power on needs a saved host or an explicit --host value.");
    }

    if (target.info?.powerState === "on") {
      console.log("on");
      return;
    }

    if (target.info?.powerState === "standby") {
      try {
        const remote = await ensureRemoteCredentials(options, config);
        await sendRemoteKey(remote.info.host, "KEY_POWER", {
          clientName: remote.config.clientName,
          token: remote.config.token
        });
        const state = await waitForPowerState(target.host, "on", {
          timeoutMs: 12000,
          intervalMs: 1000
        });
        console.log(state);
        return;
      } catch {
        // Fall back to Wake-on-LAN below.
      }
    }

    if (!target.mac) {
      throw new Error("No MAC address is available for Wake-on-LAN. Run `tv info` once while the TV is on.");
    }

    await sendWakeOnLan(target.mac, target.host);
    const state = await waitForPowerState(target.host, "on", {
      timeoutMs: 30000,
      intervalMs: 1000
    });
    console.log(state);
    return;
  }

  if (action === "off") {
    const remote = await ensureRemoteCredentials(options, config);
    await holdRemoteKey(remote.info.host, "KEY_POWER", {
      clientName: remote.config.clientName,
      token: remote.config.token,
      holdMs: 3000
    });
    const state = await waitForPowerState(remote.info.host, ["standby", "off"], {
      timeoutMs: 15000,
      intervalMs: 1000
    });
    console.log(state);
    return;
  }

  if (action === "art") {
    const remote = await ensureRemoteCredentials(options, config);
    await sendRemoteKey(remote.info.host, "KEY_POWER", {
      clientName: remote.config.clientName,
      token: remote.config.token
    });
    console.log("art");
    return;
  }

  throw new Error(`Unsupported power action: ${action}`);
}

async function handleVolume(action, value, options, config) {
  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: false });

  if (action === "get") {
    console.log(await getVolume(info.host));
    return;
  }

  if (action === "set") {
    if (value == null) {
      throw new Error("volume set requires a numeric value");
    }

    const volume = await setVolume(info.host, Number(value));
    console.log(volume);
    return;
  }

  if (action === "up" || action === "down") {
    const current = await getVolume(info.host);
    const delta = Math.max(1, Number(value ?? 1));
    const next = action === "up" ? current + delta : current - delta;
    const volume = await setVolume(info.host, clamp(next, 0, 100));
    console.log(volume);
    return;
  }

  throw new Error(`Unsupported volume action: ${action}`);
}

async function handleMute(action, options, config) {
  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: false });

  if (action === "status") {
    console.log((await getMute(info.host)) ? "on" : "off");
    return;
  }

  if (action === "toggle") {
    const nextState = !(await getMute(info.host));
    await setMute(info.host, nextState);
    console.log(nextState ? "on" : "off");
    return;
  }

  if (action === "on" || action === "off") {
    await setMute(info.host, action === "on");
    console.log(action);
    return;
  }

  throw new Error(`Unsupported mute action: ${action}`);
}

async function handleInput(source, options, config) {
  const key = INPUT_KEYS[source];

  if (!key) {
    throw new Error(`Unsupported input: ${source}`);
  }

  const remote = await ensureRemoteCredentials(options, config);
  await sendRemoteKey(remote.info.host, key, {
    clientName: remote.config.clientName,
    token: remote.config.token
  });
  console.log(`Sent ${source}`);
}

async function handleApp(args, options, config) {
  const subcommand = args[0];

  if (!subcommand) {
    throw new Error("app requires a subcommand: list, or an app name/id to launch");
  }

  if (subcommand === "list") {
    const { info } = await discoverOrResolveDevice(options, config, { requireInfo: false });

    let apps;
    try {
      apps = await getInstalledApps(info.host);
    } catch {
      // Bulk endpoint not available — probe known apps individually
      const seen = new Set();
      const entries = Object.entries(WELL_KNOWN_APPS).filter(([name, id]) => {
        if (/[ +]/.test(name) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const probed = await Promise.all(
        entries.map(async ([name, appId]) => {
          try {
            const status = await getAppStatus(info.host, appId);
            return {
              appId: status.id ?? appId,
              name: status.name ?? name,
              running: status.running ?? false,
              visible: status.visible ?? false,
              version: status.version ?? null,
              installed: true
            };
          } catch {
            return { appId, name, installed: false };
          }
        })
      );

      apps = probed.filter((a) => a.installed);
    }

    if (options.json) {
      console.log(JSON.stringify(apps, null, 2));
    } else {
      if (apps.length === 0) {
        console.log("No apps found");
        return;
      }
      for (const app of apps) {
        const status = app.running ? " (running)" : "";
        const ver = app.version ? ` v${app.version}` : "";
        console.log(`${(app.name ?? "?").padEnd(22)} ${app.appId}${ver}${status}`);
      }
    }
    return;
  }

  // Resolve the app name — join all args to handle multi-word names like "apple tv"
  const appQuery = args.join(" ").toLowerCase();
  let appId = WELL_KNOWN_APPS[appQuery];

  if (!appId) {
    // Check if it looks like a raw app ID (numeric or dot-separated)
    if (/^[\d.]+$/.test(args[0]) || /^[a-z]+\.[a-z]+/i.test(args[0])) {
      appId = args[0];
    }
  }

  if (!appId) {
    // Fuzzy match: check if query is a substring of any known app name
    const match = Object.entries(WELL_KNOWN_APPS).find(([name]) =>
      name.includes(appQuery) || appQuery.includes(name)
    );
    if (match) {
      appId = match[1];
    }
  }

  if (!appId) {
    const knownNames = [...new Set(Object.keys(WELL_KNOWN_APPS).filter((k) => !/[ +]/.test(k)))];
    throw new Error(
      `Unknown app: "${args.join(" ")}". Use a known name (${knownNames.join(", ")}), or pass a raw app ID.`
    );
  }

  const { info } = await discoverOrResolveDevice(options, config, { requireInfo: true });

  // If the TV is in art/ambient mode, wake it first with KEY_POWER
  const isArtMode = info.powerState === "on";
  let wokenFromArt = false;
  try {
    const appStatus = await getAppStatus(info.host, appId);
    // If the app isn't running but TV says "on", it might be in art mode
    // We detect art mode by checking if the TV responds to info but no app is active
    if (isArtMode && !appStatus.running && !appStatus.visible) {
      // Try launching directly first — the REST POST often wakes from art mode
    }
  } catch {
    // App status check failed, proceed anyway
  }

  const result = await launchApp(info.host, appId);

  if (!result.ok) {
    // If direct launch failed, try waking from art mode first
    const remote = await ensureRemoteCredentials(options, config);
    await sendRemoteKey(remote.info.host, "KEY_POWER", {
      clientName: remote.config.clientName,
      token: remote.config.token
    });
    await delay(3000);
    const retryResult = await launchApp(info.host, appId);
    wokenFromArt = true;
    if (!retryResult.ok) {
      throw new Error(`Failed to launch app ${appId}`);
    }
  }

  // Find the friendly name for display
  const friendlyName = Object.entries(WELL_KNOWN_APPS).find(([, id]) => id === appId)?.[0] ?? appId;

  if (options.json) {
    console.log(JSON.stringify({ launched: true, appId, name: friendlyName, wokenFromArt }));
  } else {
    console.log(`Launched ${friendlyName} (${appId})`);
  }
}

async function handleKey(key, options, config) {
  const remote = await ensureRemoteCredentials(options, config);
  await sendRemoteKey(remote.info.host, key, {
    clientName: remote.config.clientName,
    token: remote.config.token
  });
  console.log(`Sent ${key}`);
}

export async function runCli(argv) {
  const { options, positional } = parseArgs(argv);

  if (options.help || positional.length === 0) {
    printHelp();
    return;
  }

  const config = await readConfig(options.configPath);
  const [command, ...rest] = positional;

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "discover") {
    await handleDiscover(options);
    return;
  }

  if (command === "info") {
    await handleInfo(options, config);
    return;
  }

  if (command === "pair") {
    await handlePair(options, config);
    return;
  }

  if (command === "power") {
    await handlePower(rest[0], options, config);
    return;
  }

  if (command === "art") {
    await handlePower("art", options, config);
    return;
  }

  if (command === "volume") {
    await handleVolume(rest[0], rest[1], options, config);
    return;
  }

  if (command === "mute") {
    await handleMute(rest[0], options, config);
    return;
  }

  if (command === "input") {
    await handleInput(rest[0], options, config);
    return;
  }

  if (command === "app") {
    await handleApp(rest, options, config);
    return;
  }

  if (command === "key") {
    await handleKey(rest[0], options, config);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
