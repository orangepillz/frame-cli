import dgram from "node:dgram";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const DEFAULT_TIMEOUT_MS = 2500;
const SOAP_RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const REMOTE_PATH = "/api/v2/channels/samsung.remote.control";

export function getDefaultConfigPath() {
  return path.join(os.homedir(), ".config", "samsung-tv-cli", "config.json");
}

export async function readConfig(configPath = getDefaultConfigPath()) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writeConfig(configPath, config) {
  const fullPath = path.resolve(configPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function normalizeMacAddress(mac) {
  const cleaned = String(mac ?? "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();

  if (cleaned.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }

  return cleaned.match(/.{2}/g).join(":");
}

export function clientNameToBase64(clientName) {
  return Buffer.from(clientName, "utf8").toString("base64");
}

function parseXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
  return match ? match[1] : null;
}

function buildRemoteUrl(host, clientName, token) {
  const name = encodeURIComponent(clientNameToBase64(clientName));
  const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : "";
  return `wss://${host}:8002${REMOTE_PATH}?name=${name}${tokenSuffix}`;
}

function unique(items) {
  return [...new Set(items)];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response;
}

function parseApiInfo(payload, hostHint) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const device = parsed.device ?? {};
  const host = hostHint ?? device.ip ?? null;

  return {
    host,
    name: parsed.name ?? device.name ?? "Samsung TV",
    model: device.modelName ?? device.model ?? null,
    powerState: device.PowerState ?? null,
    mac: device.wifiMac ?? null,
    networkType: device.networkType ?? null,
    frameSupport: device.FrameTVSupport === "true",
    tokenAuthSupport: device.TokenAuthSupport === "true",
    raw: parsed
  };
}

export async function getTvInfo(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`http://${host}:8001/api/v2/`, {}, timeoutMs);
  const json = await response.json();
  return parseApiInfo(json, host);
}

export async function getPowerState(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const info = await getTvInfo(host, timeoutMs);
  return info.powerState ?? "unknown";
}

function parseSsdpHeaders(message) {
  const lines = message.split(/\r?\n/);
  const headers = {};

  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");

    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }

  return headers;
}

async function collectSsdpResponses(searchTarget, timeoutMs) {
  const socket = dgram.createSocket("udp4");
  const responses = [];

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (message) => {
      responses.push(parseSsdpHeaders(message.toString("utf8")));
    });

    socket.bind(0, () => {
      const request = [
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        'MAN: "ssdp:discover"',
        "MX: 1",
        `ST: ${searchTarget}`,
        "",
        ""
      ].join("\r\n");

      socket.send(Buffer.from(request, "utf8"), 1900, "239.255.255.250", (error) => {
        if (error) {
          reject(error);
          return;
        }

        setTimeout(resolve, timeoutMs);
      });
    });
  }).finally(() => {
    socket.close();
  });

  return responses;
}

function getPrivateIpv4Bases() {
  const interfaces = os.networkInterfaces();
  const bases = [];

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      const octets = address.address.split(".");

      if (octets.length !== 4) {
        continue;
      }

      const [a, b, c] = octets;
      const privateRange =
        a === "10" ||
        (a === "172" && Number(b) >= 16 && Number(b) <= 31) ||
        (a === "192" && b === "168");

      if (privateRange) {
        bases.push(`${a}.${b}.${c}`);
      }
    }
  }

  return unique(bases);
}

async function mapLimit(items, limit, task) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await task(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function discoverViaSubnetScan(timeoutMs = 800) {
  const bases = getPrivateIpv4Bases();
  const hosts = [];

  for (const base of bases) {
    for (let suffix = 1; suffix <= 254; suffix += 1) {
      hosts.push(`${base}.${suffix}`);
    }
  }

  const found = await mapLimit(hosts, 32, async (host) => {
    try {
      return await getTvInfo(host, timeoutMs);
    } catch {
      return null;
    }
  });

  return found.filter(Boolean);
}

export async function discoverSamsungTvs({ timeoutMs = 1500 } = {}) {
  const searchTargets = [
    "urn:schemas-upnp-org:device:MediaRenderer:1",
    "urn:samsung.com:device:RemoteControlReceiver:1",
    "ssdp:all"
  ];
  const ssdpResponses = await Promise.all(searchTargets.map((target) => collectSsdpResponses(target, timeoutMs).catch(() => [])));
  const hostsFromSsdp = unique(
    ssdpResponses
      .flat()
      .map((headers) => headers.location ?? "")
      .filter(Boolean)
      .map((location) => {
        try {
          return new URL(location).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const ssdpDevices = await Promise.all(
    hostsFromSsdp.map((host) =>
      getTvInfo(host, timeoutMs + 1000).catch(() => null)
    )
  );
  const directDevices = ssdpDevices.filter(Boolean);

  if (directDevices.length > 0) {
    return directDevices;
  }

  return discoverViaSubnetScan();
}

function buildSoapEnvelope(action, innerXml, service = SOAP_RENDERING_CONTROL) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">${innerXml}</u:${action}></s:Body></s:Envelope>`
  );
}

export async function callRenderingControl(host, action, innerXml, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = buildSoapEnvelope(action, innerXml);
  const response = await fetchWithTimeout(
    `http://${host}:9197/upnp/control/RenderingControl1`,
    {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPAction: `"${SOAP_RENDERING_CONTROL}#${action}"`
      },
      body
    },
    timeoutMs
  );

  return response.text();
}

export async function getVolume(host) {
  const xml = await callRenderingControl(
    host,
    "GetVolume",
    "<InstanceID>0</InstanceID><Channel>Master</Channel>"
  );
  const volume = parseXmlTag(xml, "CurrentVolume");

  if (volume == null) {
    throw new Error("TV did not return a volume value");
  }

  return Number(volume);
}

export async function setVolume(host, value) {
  const desiredVolume = clamp(Number(value), 0, 100);
  await callRenderingControl(
    host,
    "SetVolume",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${desiredVolume}</DesiredVolume>`
  );
  return desiredVolume;
}

export async function getMute(host) {
  const xml = await callRenderingControl(
    host,
    "GetMute",
    "<InstanceID>0</InstanceID><Channel>Master</Channel>"
  );
  const mute = parseXmlTag(xml, "CurrentMute");

  if (mute == null) {
    throw new Error("TV did not return a mute state");
  }

  return mute === "1";
}

export async function setMute(host, desiredMute) {
  await callRenderingControl(
    host,
    "SetMute",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${desiredMute ? 1 : 0}</DesiredMute>`
  );
  return desiredMute;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createClientName() {
  return `samsung-tv-cli-${Math.random().toString(36).slice(2, 10)}`;
}

function waitForRemoteConnect(host, clientName, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildRemoteUrl(host, clientName, token), {
      rejectUnauthorized: false,
      handshakeTimeout: 10000
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for Samsung TV authorization"));
    }, 12000);

    let settled = false;

    function finish(handler, value) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      handler(value);
    }

    ws.on("message", (payload) => {
      let message;

      try {
        message = JSON.parse(payload.toString());
      } catch {
        return;
      }

      if (message.event === "ms.channel.connect") {
        finish(resolve, {
          clientName,
          host,
          ws,
          token: String(message.data?.token ?? token ?? ""),
          message
        });
        return;
      }

      const authError =
        message.event === "ms.channel.unauthorized" ||
        (message.event === "ms.error" && /authorized/i.test(String(message.data?.message ?? "")));

      if (authError) {
        ws.close();
        finish(reject, new Error("Samsung TV rejected the websocket session. Approve the client on the TV and retry."));
      }
    });

    ws.on("error", (error) => {
      finish(reject, error);
    });

    ws.on("close", () => {
      if (!settled) {
        finish(reject, new Error("Samsung TV closed the websocket before authorization completed"));
      }
    });
  });
}

async function sendRemotePayload(ws, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 400);

    function onMessage(raw) {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.event === "ms.error") {
        cleanup();
        reject(new Error(`Samsung TV returned an error: ${message.data?.message ?? "unknown error"}`));
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }

    ws.on("message", onMessage);
    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });

    setTimeout(cleanup, 450);
  });
}

export async function connectRemoteSession(host, options = {}) {
  const clientName = options.clientName ?? createClientName();
  const token = options.token ?? null;
  return waitForRemoteConnect(host, clientName, token);
}

export async function sendRemoteCommand(host, key, options = {}) {
  const session = await connectRemoteSession(host, options);
  const command = options.command ?? "Click";

  try {
    await sendRemotePayload(session.ws, {
      method: "ms.remote.control",
      params: {
        Cmd: command,
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey"
      }
    });
  } finally {
    session.ws.close();
  }

  return session;
}

export async function sendRemoteKey(host, key, options = {}) {
  return sendRemoteCommand(host, key, { ...options, command: "Click" });
}

export async function holdRemoteKey(host, key, options = {}) {
  const session = await connectRemoteSession(host, options);
  const holdMs = Math.max(250, Number(options.holdMs ?? 2500));

  try {
    await sendRemotePayload(session.ws, {
      method: "ms.remote.control",
      params: {
        Cmd: "Press",
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey"
      }
    });
    await delay(holdMs);
    await sendRemotePayload(session.ws, {
      method: "ms.remote.control",
      params: {
        Cmd: "Release",
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey"
      }
    });
  } finally {
    session.ws.close();
  }

  return session;
}

export async function waitForPowerState(host, expectedStates, options = {}) {
  const desiredStates = new Set(
    (Array.isArray(expectedStates) ? expectedStates : [expectedStates]).map((state) => String(state))
  );
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 20000));
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000));
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";

  while (Date.now() <= deadline) {
    try {
      const state = await getPowerState(host, Math.min(DEFAULT_TIMEOUT_MS, intervalMs));
      lastState = state;

      if (desiredStates.has(state)) {
        return state;
      }
    } catch {
      lastState = "off";

      if (desiredStates.has("off")) {
        return "off";
      }
    }

    await delay(intervalMs);
  }

  throw new Error(
    `Timed out waiting for TV power state ${Array.from(desiredStates).join(" or ")}; last observed state was ${lastState}`
  );
}

function getDirectedBroadcast(host) {
  const octets = host.split(".");

  if (octets.length !== 4) {
    return "255.255.255.255";
  }

  return `${octets[0]}.${octets[1]}.${octets[2]}.255`;
}

export async function sendWakeOnLan(mac, hostHint) {
  const normalized = normalizeMacAddress(mac);
  const bytes = Buffer.from(normalized.replace(/:/g, ""), "hex");
  const packet = Buffer.alloc(6 + bytes.length * 16, 0xff);

  for (let offset = 6; offset < packet.length; offset += bytes.length) {
    bytes.copy(packet, offset);
  }

  const socket = dgram.createSocket("udp4");
  const targets = unique([hostHint ? getDirectedBroadcast(hostHint) : null, "255.255.255.255"].filter(Boolean));
  const ports = [9, 7];

  await new Promise((resolve, reject) => {
    socket.bind(0, () => {
      socket.setBroadcast(true);
      resolve();
    });
    socket.once("error", reject);
  });

  try {
    let delivered = 0;

    for (const address of targets) {
      for (const port of ports) {
        await new Promise((resolve, reject) => {
          socket.send(packet, port, address, (error) => {
            if (error) {
              reject(error);
              return;
            }

            delivered += 1;
            resolve();
          });
        }).catch((error) => {
          if (error && typeof error === "object" && error.code === "EADDRNOTAVAIL") {
            return;
          }

          throw error;
        });
      }
    }

    if (delivered === 0) {
      throw new Error("Wake-on-LAN packet could not be delivered on this network interface");
    }
  } finally {
    socket.close();
  }

  await delay(200);
}

export function mergeConfigWithInfo(config, info, extras = {}) {
  return {
    ...config,
    host: info.host ?? config.host ?? null,
    mac: info.mac ?? config.mac ?? null,
    name: info.name ?? config.name ?? null,
    model: info.model ?? config.model ?? null,
    clientName: extras.clientName ?? config.clientName ?? null,
    token: extras.token ?? config.token ?? null,
    updatedAt: new Date().toISOString()
  };
}
