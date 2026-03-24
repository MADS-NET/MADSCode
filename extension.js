'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

class ControlItem extends vscode.TreeItem {
  constructor(file_path, is_running, ini_locked) {
    const file_name = path.basename(file_path);
    super(file_name, vscode.TreeItemCollapsibleState.None);
    const extension_name = path.extname(file_name);
    const is_ini = extension_name === '.ini';

    this.file_path = file_path;
    this.contextValue = is_running
      ? 'controlFileRunning'
      : (is_ini && ini_locked ? 'controlIniFileLocked' : 'controlFileStopped');
    this.description = is_running ? 'running' : path.extname(file_name).slice(1);
    this.tooltip = file_path;
    if (is_running && is_ini) {
      this.label = {
        label: file_name,
        highlights: [[0, file_name.length]]
      };
    }
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(file_path)]
    };
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label, command_name) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: command_name,
      title: label
    };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label, value) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.tooltip = `${label}: ${value}`;
  }
}

class PluginItem extends vscode.TreeItem {
  constructor(label, description) {
    super(`• ${label}`, vscode.TreeItemCollapsibleState.None);
    this.description = description || '';
    this.tooltip = description ? `${label}: ${description}` : label;
  }
}

class PluginsGroupItem extends vscode.TreeItem {
  constructor(plugins) {
    super('Available plugins', vscode.TreeItemCollapsibleState.Expanded);
    this.plugins = plugins;
    this.contextValue = 'pluginsGroup';
  }
}

class PluginsDirectoryItem extends vscode.TreeItem {
  constructor(label) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = label;
  }
}

class ControlProvider {
  constructor(process_manager) {
    this._process_manager = process_manager;
    this._on_did_change_tree_data = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._on_did_change_tree_data.event;
  }

  refresh() {
    this._on_did_change_tree_data.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren() {
    const workspace_path = get_workspace_path();
    if (!workspace_path) {
      return [
        new vscode.TreeItem('Open a workspace to list .ini and .toml files.')
      ];
    }

    let entries;
    try {
      entries = await fs.promises.readdir(workspace_path, { withFileTypes: true });
    } catch (error) {
      return [
        new vscode.TreeItem(`Failed to read ${workspace_path}: ${error.message}`)
      ];
    }

    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name !== 'imgui.ini')
      .filter((name) => name.endsWith('.ini') || name.endsWith('.toml'))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => path.join(workspace_path, name));

    if (files.length === 0) {
      return [
        new vscode.TreeItem('No .ini or .toml files found in the workspace root.')
      ];
    }

    const running_ini_path = this._process_manager.get_running_ini_path();

    return files.map((file_path) => new ControlItem(
      file_path,
      this._process_manager.is_running(file_path),
      Boolean(running_ini_path && running_ini_path !== file_path && path.extname(file_path) === '.ini')
    ));
  }
}

class MadsInfoProvider {
  constructor() {
    this._on_did_change_tree_data = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._on_did_change_tree_data.event;
  }

  refresh() {
    this._on_did_change_tree_data.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren() {
    try {
      const [version, prefix] = await Promise.all([
        capture_mads_output(['-v'], { require_workspace: false }),
        capture_mads_output(['-p'], { require_workspace: false })
      ]);

      return [
        new InfoItem('Version', version || 'Unavailable'),
        new InfoItem('Prefix', prefix || 'Unavailable')
      ];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [
          new InfoItem('Version', 'MADS is not installed'),
          new InfoItem('Prefix', 'Install the MADS framework from https://git.new/mads')
        ];
      }

      return [
        new vscode.TreeItem(`Failed to query MADS: ${error.message}`)
      ];
    }
  }
}

class ConfigurationsProvider {
  getTreeItem(element) {
    return element;
  }

  getChildren() {
    return [
      new ActionItem('Generate INI file', 'mads.generateIniFile'),
      new ActionItem('Generate director file', 'mads.generateDirectorFile')
    ];
  }
}

class PluginsProvider {
  constructor() {
    this._on_did_change_tree_data = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._on_did_change_tree_data.event;
  }

  refresh() {
    this._on_did_change_tree_data.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element instanceof PluginsGroupItem) {
      return element.plugins;
    }

    const workspace_path = get_workspace_path();
    if (!workspace_path) {
      return [
        new vscode.TreeItem('Open a workspace to query plugins.')
      ];
    }

    const items = [new ActionItem('Create a new one', 'mads.createPlugin')];

    try {
      const output = await capture_mads_output(['--plugins']);
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trimEnd());

      const directory_line = lines[0]?.trim();
      if (directory_line) {
        items.push(new PluginsDirectoryItem(directory_line));
      }

      const plugins = lines
        .slice(2)
        .map((line) => line.trim())
        .filter(Boolean);

      if (plugins.length === 0) {
        items.push(new vscode.TreeItem('No plugins reported by mads --plugins.'));
        return items;
      }

      items.push(new PluginsGroupItem(plugins.map((plugin) => parse_plugin_line(plugin))));
      return items;
    } catch (error) {
      items.push(new vscode.TreeItem(`Failed to query plugins: ${error.message}`));
      return items;
    }
  }
}

class ProcessManager {
  constructor(output_channel, on_change) {
    this._output_channel = output_channel;
    this._on_change = on_change;
    this._processes = new Map();
  }

  is_running(file_path) {
    return this._processes.has(file_path);
  }

  get_running_ini_path() {
    for (const file_path of this._processes.keys()) {
      if (path.extname(file_path) === '.ini') {
        return file_path;
      }
    }
    return null;
  }

  start(file_path) {
    if (this._processes.has(file_path)) {
      vscode.window.showInformationMessage(`${path.basename(file_path)} is already running.`);
      return;
    }

    const workspace_path = get_workspace_path();
    if (!workspace_path) {
      vscode.window.showErrorMessage('Open a workspace before starting MADS commands.');
      return;
    }

    const extension_name = path.extname(file_path);
    const running_ini_path = this.get_running_ini_path();
    if (extension_name === '.ini' && running_ini_path && running_ini_path !== file_path) {
      vscode.window.showInformationMessage(
        `${path.basename(running_ini_path)} is already running. Stop it before starting another .ini file.`
      );
      return;
    }

    const args = extension_name === '.ini'
      ? ['broker', '-s', file_path, '-d']
      : ['director', file_path];
    const should_capture_output = extension_name === '.ini';

    const child = spawn('mads', args, {
      cwd: workspace_path,
      env: process.env,
      stdio: should_capture_output ? ['ignore', 'pipe', 'pipe'] : 'ignore'
    });

    this._processes.set(file_path, child);
    this._on_change();

    if (should_capture_output) {
      this._output_channel.show(true);
      this._output_channel.appendLine(`$ mads ${args.join(' ')}`);
      child.stdout.on('data', (chunk) => {
        this._output_channel.append(chunk.toString());
      });
      child.stderr.on('data', (chunk) => {
        this._output_channel.append(chunk.toString());
      });
    }

    child.on('error', (error) => {
      this._processes.delete(file_path);
      this._on_change();
      vscode.window.showErrorMessage(`Failed to start mads for ${path.basename(file_path)}: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      const had_process = this._processes.delete(file_path);
      if (had_process) {
        this._on_change();
      }

      if (should_capture_output) {
        this._output_channel.appendLine(
          `\n[${path.basename(file_path)} exited with ${signal || `code ${code ?? 0}`}]`
        );
      }
    });
  }

  stop(file_path) {
    const child = this._processes.get(file_path);
    if (!child) {
      vscode.window.showInformationMessage(`${path.basename(file_path)} is not running.`);
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop ${path.basename(file_path)}: ${error.message}`);
    }
  }

  dispose() {
    for (const child of this._processes.values()) {
      try {
        child.kill('SIGTERM');
      } catch (error) {
        // Ignore shutdown errors while disposing the extension.
      }
    }
    this._processes.clear();
  }
}

function get_workspace_path() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function capture_mads_output(args, options = {}) {
  const workspace_path = get_workspace_path();
  if (options.require_workspace !== false && !workspace_path) {
    return Promise.reject(new Error('Open a workspace before running MADS commands.'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn('mads', args, {
      cwd: workspace_path,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `mads exited with code ${code ?? 0}.`));
    });
  });
}

function parse_plugin_line(line) {
  const separators = [' - ', ': ', '\t'];
  for (const separator of separators) {
    const index = line.indexOf(separator);
    if (index > 0) {
      return new PluginItem(
        line.slice(0, index).trim(),
        line.slice(index + separator.length).trim()
      );
    }
  }

  return new PluginItem(line, '');
}

async function prompt_for_filename(options) {
  const file_name = await vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.place_holder,
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return 'A filename is required.';
      }
      if (path.basename(value.trim()) !== value.trim()) {
        return 'Use a filename relative to the workspace root.';
      }
      if (!value.endsWith(options.extension)) {
        return `Filename must end with ${options.extension}.`;
      }
      return null;
    }
  });

  return file_name?.trim();
}

async function prompt_for_plugin_type() {
  const choice = await vscode.window.showQuickPick([
    {
      label: 'source',
      description: 'Create a source plugin'
    },
    {
      label: 'filter',
      description: 'Create a filter plugin'
    },
    {
      label: 'sink',
      description: 'Create a sink plugin'
    }
  ], {
    placeHolder: 'Select the plugin type'
  });

  return choice?.label;
}

async function prompt_for_plugin_name() {
  return vscode.window.showInputBox({
    prompt: 'Plugin name',
    placeHolder: 'my_plugin',
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return 'A plugin name is required.';
      }
      if (/\s/.test(value.trim())) {
        return 'Use a plugin name without whitespace.';
      }
      return null;
    }
  });
}

function open_file(file_path) {
  return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file_path));
}

function run_simple_command(command, args, success_message, on_success) {
  const workspace_path = get_workspace_path();
  if (!workspace_path) {
    vscode.window.showErrorMessage('Open a workspace before running MADS commands.');
    return;
  }

  const child = spawn(command, args, {
    cwd: workspace_path,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error) => {
    vscode.window.showErrorMessage(`Failed to run ${command}: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (code === 0) {
      vscode.window.showInformationMessage(success_message);
      on_success?.();
      return;
    }

    vscode.window.showErrorMessage(stderr.trim() || `${command} exited with code ${code ?? 0}.`);
  });
}

function run_director_generation(target_path, on_success) {
  const workspace_path = get_workspace_path();
  if (!workspace_path) {
    vscode.window.showErrorMessage('Open a workspace before running MADS commands.');
    return;
  }

  const output = fs.createWriteStream(target_path);
  const child = spawn('mads', ['director'], {
    cwd: workspace_path,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.pipe(output);

  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error) => {
    output.destroy();
    vscode.window.showErrorMessage(`Failed to run mads director: ${error.message}`);
  });

  child.on('exit', (code) => {
    output.end();
    if (code === 0) {
      vscode.window.showInformationMessage(`Generated ${path.basename(target_path)}.`);
      on_success?.();
      return;
    }

    vscode.window.showErrorMessage(
      stderr.trim() || `mads director exited with code ${code ?? 0}.`
    );
  });
}

function register_workspace_watchers(context, refresh) {
  const workspace_path = get_workspace_path();
  if (!workspace_path) {
    return;
  }

  const ini_watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace_path, '*.ini')
  );
  const toml_watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace_path, '*.toml')
  );

  const subscriptions = [ini_watcher, toml_watcher];
  for (const watcher of subscriptions) {
    watcher.onDidCreate(refresh, null, context.subscriptions);
    watcher.onDidChange(refresh, null, context.subscriptions);
    watcher.onDidDelete(refresh, null, context.subscriptions);
    context.subscriptions.push(watcher);
  }
}

function activate(context) {
  const output_channel = vscode.window.createOutputChannel('MADS Broker');
  const info_provider = new MadsInfoProvider();
  const process_manager = new ProcessManager(output_channel, refresh_all);
  const control_provider = new ControlProvider(process_manager);
  const configurations_provider = new ConfigurationsProvider();
  const plugins_provider = new PluginsProvider();

  function refresh_all() {
    info_provider.refresh();
    control_provider.refresh();
    plugins_provider.refresh();
  }

  context.subscriptions.push(
    output_channel,
    process_manager,
    vscode.window.registerTreeDataProvider('mads.info', info_provider),
    vscode.window.registerTreeDataProvider('mads.control', control_provider),
    vscode.window.registerTreeDataProvider('mads.configurations', configurations_provider),
    vscode.window.registerTreeDataProvider('mads.plugins', plugins_provider),
    vscode.commands.registerCommand('mads.refreshInfo', () => {
      info_provider.refresh();
    }),
    vscode.commands.registerCommand('mads.refreshFiles', () => {
      control_provider.refresh();
    }),
    vscode.commands.registerCommand('mads.refreshPlugins', () => {
      plugins_provider.refresh();
    }),
    vscode.commands.registerCommand('mads.startFile', (item) => {
      if (!item?.file_path) {
        return;
      }
      process_manager.start(item.file_path);
    }),
    vscode.commands.registerCommand('mads.stopFile', (item) => {
      if (!item?.file_path) {
        return;
      }
      process_manager.stop(item.file_path);
    }),
    vscode.commands.registerCommand('mads.generateIniFile', async () => {
      const workspace_path = get_workspace_path();
      if (!workspace_path) {
        vscode.window.showErrorMessage('Open a workspace before generating configuration files.');
        return;
      }

      const file_name = await prompt_for_filename({
        prompt: 'INI filename',
        place_holder: 'config.ini',
        extension: '.ini'
      });
      if (!file_name) {
        return;
      }

      run_simple_command(
        'mads',
        ['ini', '-o', file_name],
        `Generated ${file_name}.`,
        () => {
          refresh_all();
          void open_file(path.join(workspace_path, file_name));
        }
      );
    }),
    vscode.commands.registerCommand('mads.generateDirectorFile', async () => {
      const workspace_path = get_workspace_path();
      if (!workspace_path) {
        vscode.window.showErrorMessage('Open a workspace before generating configuration files.');
        return;
      }

      const file_name = await prompt_for_filename({
        prompt: 'Director TOML filename',
        place_holder: 'director.toml',
        extension: '.toml'
      });
      if (!file_name) {
        return;
      }

      run_director_generation(path.join(workspace_path, file_name), () => {
        refresh_all();
        void open_file(path.join(workspace_path, file_name));
      });
    }),
    vscode.commands.registerCommand('mads.createPlugin', async () => {
      const workspace_path = get_workspace_path();
      if (!workspace_path) {
        vscode.window.showErrorMessage('Open a workspace before creating plugins.');
        return;
      }

      const plugin_type = await prompt_for_plugin_type();
      if (!plugin_type) {
        return;
      }

      const plugin_name = (await prompt_for_plugin_name())?.trim();
      if (!plugin_name) {
        return;
      }

      run_simple_command(
        'mads',
        ['plugin', '-type', plugin_type, '--dir', '.', plugin_name],
        `Created plugin ${plugin_name}.`,
        () => {
          plugins_provider.refresh();
          refresh_all();
        }
      );
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refresh_all();
    })
  );

  register_workspace_watchers(context, refresh_all);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
