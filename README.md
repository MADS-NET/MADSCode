# MADSCode

Visual Studio Code extension scaffold for the MADS framework.

## Features

- Activity bar entry with `MADS Info`, `Control`, `Configurations`, and `Plugins` side views
- Shows `mads -v` and `mads -p`
- Lists `.ini` and `.toml` files from the workspace root
- Opens files in the editor when selected
- Starts and stops `mads broker` / `mads director`
- Generates `.ini` and `.toml` configuration files
- Lists `mads --plugins` output and creates new plugins

## Running locally

1. Open this folder in Visual Studio Code.
2. Press `F5` to launch the Extension Development Host.
3. In the new window, open a workspace containing MADS configuration files.

## Packaging

1. Run `npm install`.
2. Run `npm run package`.
3. Install the generated `.vsix` from the VS Code Extensions panel with `Install from VSIX...`.
