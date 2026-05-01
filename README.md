# MADSCode

[![MADSCode](https://vsmarketplacebadges.dev/version-short/MADS-Net.madscode.svg)](https://marketplace.visualstudio.com/items?itemName=MADS-Net.madscode)

Visual Studio Code extension scaffold for the MADS framework.

## What is MADS

MADS is a [Multi-Agent Distributed System](https://mads-net.github.io/presentations/intro.html): a multi-platform framework of tools and libraries to coordinate a bunch of agents that exchange information through ZeroMQ protocol. MADS is **plugin-base**, and also has a Python interface.

This extension helps in the development of MADS plugins. Look at the [Guides](https://mads-net.github.io/guides) for HOW-TOs.

## Features

- Activity bar entry with `MADS Info`, `Control`, `Configurations`, and `Plugins` side views
- Shows `mads -v` and `mads -p`
- Lists `.ini` files with `[agents]` and `.toml` files with `[director]` from the workspace
- Opens files in the editor when selected
- Starts and stops `mads broker` / `mads director`
- Generates `.ini`, `.toml`, and FSM `.dot` template files
- Lists `mads --plugins` output and creates new plugins

## Settings

MADSCode contributes the following settings:

- [`madscode.roomsTimeoutMs`](vscode://settings/madscode.roomsTimeoutMs): timeout in milliseconds used by the `MADS Info` > `Rooms` discovery command. The default is `5000`.

You can also configure it in `settings.json`:

```json
{
  "madscode.roomsTimeoutMs": 5000
}
```

## Installing

MADSCode is on Visual Studio Code marketplace [here](https://marketplace.visualstudio.com/items?itemName=MADS-Net.madscode).

MADSCode is also distributed via Open VSX, you can install it by downloading it from <https://open-vsx.org/extension/MADS-Net/madscode> and then `code --install-extension MADS-Net.madscode-<version>.vsix`

## Running locally

1. Open this folder in Visual Studio Code.
2. Press `F5` to launch the Extension Development Host.
3. In the new window, open a workspace containing MADS configuration files.

## Packaging

1. Run `npm install`.
2. Run `npm run package`.
3. Install the generated `.vsix` from the VS Code Extensions panel with `Install from VSIX...`.
