# Samsung Frame TV CLI

This project provides a small local-network CLI for a Samsung Frame TV. It uses the same endpoints exposed by the TV on your LAN:

- `http://<tv>:8001/api/v2/` for device info
- `wss://<tv>:8002/api/v2/channels/samsung.remote.control` for remote key commands
- `http://<tv>:9197/upnp/control/RenderingControl1` for direct volume and mute control

## Install

```bash
npm install
npm link
```

## Usage

```bash
tv help
tv discover
tv info --host 192.168.1.162
tv pair --host 192.168.1.162
tv art
tv volume get
tv volume set 8
tv mute toggle
tv input hdmi1
tv key KEY_HOME
tv power off
tv power on
```

## Notes

- The CLI stores its config in `~/.config/samsung-tv-cli/config.json` by default.
- `pair` may trigger an authorization prompt on the TV. If a client name was denied before, the CLI automatically retries with a fresh client name.
- `power off` uses a long press of `KEY_POWER`, which matches the Frame remote's standby behavior.
- `art` uses a single press of `KEY_POWER`, which matches the Frame image mode behavior.
- `power on` waits for the TV to report `on` after trying local wake.
- Direct source selection is implemented through Samsung remote keys like `KEY_HDMI1` and `KEY_SOURCE`.
