'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

class ControlItem extends vscode.TreeItem {
  constructor(file_path, is_running, ini_locked, display_name) {
    const file_name = path.basename(file_path);
    const item_label = display_name || file_name;
    super(item_label, vscode.TreeItemCollapsibleState.None);
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
        label: item_label,
        highlights: [[0, item_label.length]]
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
  constructor(label, command_name, context_value) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = context_value;
    this.command = {
      command: command_name,
      title: label
    };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label, value, command, context_value) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.tooltip = `${label}: ${value}`;
    this.contextValue = context_value;
    if (command) {
      this.command = command;
    }
  }
}

class PluginItem extends vscode.TreeItem {
  constructor(label, description, options = {}) {
    super(
      options.inspectable ? label : `• ${label}`,
      options.inspectable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.plugin_path = options.plugin_path;
    this.description = description || '';
    this.tooltip = options.inspectable
      ? [options.plugin_path, description].filter(Boolean).join('\n')
      : (description ? `${label}: ${description}` : label);
    this.contextValue = options.inspectable ? 'plugin' : undefined;
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
  constructor(label, command, context_value) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = label;
    this.contextValue = context_value;
    if (command) {
      this.command = command;
    }
  }
}

class JsonTreeItem extends vscode.TreeItem {
  constructor(label, value, options = {}) {
    super(label, get_json_tree_collapsible_state(value));
    this.value = value;
    this.options = options;
    this.description = get_json_tree_description(value);
    this.tooltip = create_json_tree_tooltip(label, value);
    this.contextValue = 'jsonTreeItem';
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

    try {
      const files = await collect_control_files(workspace_path);

      const system_ini_path = await get_system_ini_path();
      if (system_ini_path) {
        files.unshift({
          file_path: system_ini_path,
          display_name: 'System mads.ini'
        });
      }

      if (files.length === 0) {
        return [
          new vscode.TreeItem('No .ini or .toml files found in the workspace.')
        ];
      }

      const running_ini_path = this._process_manager.get_running_ini_path();

      return files.map(({ file_path, display_name }) => new ControlItem(
        file_path,
        this._process_manager.is_running(file_path),
        Boolean(running_ini_path && running_ini_path !== file_path && path.extname(file_path) === '.ini'),
        display_name
      ));
    } catch (error) {
      return [
        new vscode.TreeItem(`Failed to read ${workspace_path}: ${error.message}`)
      ];
    }
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
        await create_prefix_info_item(prefix),
        create_external_link_info_item('Guides', 'https://mads-net.github.io/guides'),
        create_external_link_info_item('Install', 'https://git.new/mads'),
        await create_chat_info_item(prefix)
      ];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [
          new InfoItem('Version', 'MADS is not installed'),
          new InfoItem('Prefix', 'Install the MADS framework from https://git.new/mads'),
          create_external_link_info_item('Guides', 'https://mads-net.github.io/guides'),
          create_external_link_info_item('Install', 'https://git.new/mads'),
          create_chat_info_item_unavailable()
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
      new ActionItem('Generate INI file', 'mads.generateIniFile', 'configurationGenerateIni'),
      new ActionItem('Generate director file', 'mads.generateDirectorFile', 'configurationGenerateDirector'),
      new ActionItem('Generate FSM template file', 'mads.generateFsmTemplateFile', 'configurationGenerateFsmTemplate')
    ];
  }
}

class PluginsProvider {
  constructor() {
    this._on_did_change_tree_data = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._on_did_change_tree_data.event;
    this._plugin_inspection_cache = new Map();
  }

  refresh() {
    this._plugin_inspection_cache.clear();
    this._on_did_change_tree_data.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element instanceof PluginsGroupItem) {
      return element.plugins;
    }

    if (element instanceof PluginItem && element.plugin_path) {
      return this.get_plugin_children(element);
    }

    if (element instanceof JsonTreeItem) {
      return get_json_tree_children(element.value, element.options);
    }

    const workspace_path = get_workspace_path();
    if (!workspace_path) {
      return [
        new vscode.TreeItem('Open a workspace to query plugins.')
      ];
    }

    const items = [new ActionItem('Create a new one', 'mads.createPlugin', 'pluginCreate')];

    try {
      const output = await capture_mads_output(['--plugins']);
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trimEnd());

      const directory_line = lines[0]?.trim();
      const plugins_directory = parse_plugins_directory_path(directory_line);
      if (directory_line) {
        items.push(await create_plugins_directory_item(directory_line));
      }

      const plugins = lines
        .slice(2)
        .map((line) => line.trim())
        .filter(Boolean);

      if (plugins.length === 0) {
        items.push(new vscode.TreeItem('No plugins reported by mads --plugins.'));
        return items;
      }

      const inspectable_plugins = await should_use_inspectable_plugins();
      items.push(new PluginsGroupItem(
        plugins.map((plugin) => create_plugin_item(plugin, plugins_directory, inspectable_plugins))
      ));
      return items;
    } catch (error) {
      items.push(new vscode.TreeItem(`Failed to query plugins: ${error.message}`));
      return items;
    }
  }

  async get_plugin_children(element) {
    try {
      const inspection = await this.inspect_plugin(element.plugin_path);
      const flatten_single_driver = await should_flatten_single_driver();
      return get_json_tree_children(inspection, { flatten_single_driver });
    } catch (error) {
      return [new vscode.TreeItem(`Failed to inspect plugin: ${error.message}`)];
    }
  }

  async inspect_plugin(plugin_path) {
    if (this._plugin_inspection_cache.has(plugin_path)) {
      return this._plugin_inspection_cache.get(plugin_path);
    }

    const inspection_promise = capture_mads_output(['inspect_plugin', '--json', plugin_path])
      .then((output) => JSON.parse(output));
    this._plugin_inspection_cache.set(plugin_path, inspection_promise);

    try {
      return await inspection_promise;
    } catch (error) {
      this._plugin_inspection_cache.delete(plugin_path);
      throw error;
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
    const cwd = workspace_path;

    this.start_process(file_path, args, cwd, should_capture_output);
  }

  start_active_file(file_path) {
    const extension_name = path.extname(file_path).toLowerCase();
    const cwd = path.dirname(file_path);

    if (extension_name === '.ini') {
      const running_ini_path = this.get_running_ini_path();
      if (running_ini_path && running_ini_path !== file_path) {
        vscode.window.showInformationMessage(
          `${path.basename(running_ini_path)} is already running. Stop it before starting another .ini file.`
        );
        return;
      }

      const args = ['broker', '-s', path.basename(file_path), '-d'];
      this.start_process(file_path, args, cwd, true);
      return;
    }

    if (extension_name === '.toml') {
      const args = ['director', path.basename(file_path)];
      this.start_process(file_path, args, cwd, false);
      return;
    }

    vscode.window.showErrorMessage('Open an .ini or .toml file before starting MADS.');
  }

  start_process(file_path, args, cwd, should_capture_output) {
    if (this._processes.has(file_path)) {
      vscode.window.showInformationMessage(`${path.basename(file_path)} is already running.`);
      return;
    }

    const child = spawn('mads', args, {
      cwd,
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

async function create_prefix_info_item(prefix) {
  if (!prefix) {
    return new InfoItem('Prefix', 'Unavailable');
  }

  try {
    await fs.promises.access(prefix, fs.constants.F_OK);
    const item = new InfoItem('Prefix', prefix, create_reveal_path_command(prefix, 'Reveal Prefix'), 'openableFolder');
    item.reveal_path = prefix;
    return item;
  } catch {
    return new InfoItem('Prefix', prefix);
  }
}

async function get_system_ini_path() {
  try {
    const prefix = await capture_mads_output(['-p'], { require_workspace: false });
    if (!prefix) {
      return null;
    }

    const system_ini_path = path.join(prefix, 'etc', 'mads.ini');
    await fs.promises.access(system_ini_path, fs.constants.F_OK);
    return system_ini_path;
  } catch {
    return null;
  }
}

async function collect_control_files(workspace_path) {
  const files = [];

  async function walk(directory_path) {
    const entries = await fs.promises.readdir(directory_path, { withFileTypes: true });

    for (const entry of entries) {
      const entry_path = path.join(directory_path, entry.name);
      if (entry.isDirectory()) {
        await walk(entry_path);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension_name = path.extname(entry.name).toLowerCase();
      if (entry.name === 'imgui.ini' || (extension_name !== '.ini' && extension_name !== '.toml')) {
        continue;
      }

      files.push({
        file_path: entry_path,
        display_name: path.relative(workspace_path, entry_path)
      });
    }
  }

  await walk(workspace_path);
  files.sort((left, right) => left.display_name.localeCompare(right.display_name));
  return files;
}

function create_external_link_info_item(label, url) {
  const item = new InfoItem(label, url, create_open_url_command(url, label), 'externalLink');
  item.link_url = url;
  return item;
}

async function create_chat_info_item(prefix) {
  const fallback_url = 'https://github.com/mads-net/mads_chat';
  if (!prefix) {
    return create_chat_info_item_unavailable();
  }

  const executable_name = process.platform === 'win32' ? 'mads-chat.exe' : 'mads-chat';
  const executable_path = path.join(prefix, 'bin', executable_name);
  try {
    await fs.promises.access(executable_path, fs.constants.X_OK);
    const item = new InfoItem(
      'Chat',
      'mads chat',
      {
        command: 'mads.launchChat',
        title: 'Launch Chat'
      },
      'chatCommand'
    );
    item.chat_command = 'mads chat';
    return item;
  } catch {
    return create_chat_info_item_unavailable(fallback_url);
  }
}

function create_chat_info_item_unavailable(url = 'https://github.com/mads-net/mads_chat') {
  const item = new InfoItem('Chat', url, create_open_url_command(url, 'Open Chat'), 'externalLink');
  item.link_url = url;
  return item;
}

async function create_plugins_directory_item(line) {
  const match = line.match(/^Plugins directory:\s*(.+)$/i);
  const directory_path = match ? match[1].trim() : line;
  if (!directory_path) {
    return new PluginsDirectoryItem(line);
  }

  try {
    await fs.promises.access(directory_path, fs.constants.F_OK);
    const item = new PluginsDirectoryItem(
      line,
      create_reveal_path_command(directory_path, 'Reveal Plugins Directory'),
      'openableFolder'
    );
    item.reveal_path = directory_path;
    return item;
  } catch {
    return new PluginsDirectoryItem(line);
  }
}

function parse_plugins_directory_path(line) {
  const match = line?.match(/^Plugins directory:\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

function create_open_url_command(url, title) {
  return {
    command: 'vscode.open',
    title,
    arguments: [vscode.Uri.parse(url)]
  };
}

function create_reveal_path_command(file_path, title) {
  return {
    command: 'revealFileInOS',
    title,
    arguments: [vscode.Uri.file(file_path)]
  };
}

function create_plugin_item(line, plugins_directory, inspectable) {
  const separators = [' - ', ': ', '\t'];
  for (const separator of separators) {
    const index = line.indexOf(separator);
    if (index > 0) {
      const label = line.slice(0, index).trim();
      const description = line.slice(index + separator.length).trim();
      return new PluginItem(label, description, {
        inspectable,
        plugin_path: inspectable ? resolve_plugin_path(label, plugins_directory) : undefined
      });
    }
  }

  return new PluginItem(line, '', {
    inspectable,
    plugin_path: inspectable ? resolve_plugin_path(line, plugins_directory) : undefined
  });
}

function resolve_plugin_path(plugin_reference, plugins_directory) {
  if (!plugin_reference) {
    return plugin_reference;
  }

  if (!plugins_directory) {
    return plugin_reference;
  }

  return path.resolve(plugins_directory, plugin_reference);
}

let use_inspectable_plugins_promise;
let flatten_single_driver_promise;

function should_use_inspectable_plugins() {
  if (!use_inspectable_plugins_promise) {
    use_inspectable_plugins_promise = capture_mads_output(['-v'], { require_workspace: false })
      .then((version) => is_version_greater_than(version, 'v2.0.3'))
      .catch(() => false);
  }

  return use_inspectable_plugins_promise;
}

function should_flatten_single_driver() {
  if (!flatten_single_driver_promise) {
    flatten_single_driver_promise = should_use_inspectable_plugins();
  }

  return flatten_single_driver_promise;
}

function is_version_greater_than(version_text, minimum_version) {
  const current = parse_semantic_version(version_text);
  const minimum = parse_semantic_version(minimum_version);
  if (!current || !minimum) {
    return false;
  }

  const max_length = Math.max(current.length, minimum.length);
  for (let index = 0; index < max_length; index += 1) {
    const current_part = current[index] ?? 0;
    const minimum_part = minimum[index] ?? 0;
    if (current_part > minimum_part) {
      return true;
    }
    if (current_part < minimum_part) {
      return false;
    }
  }

  return false;
}

function parse_semantic_version(version_text) {
  const match = version_text?.match(/v?(\d+(?:\.\d+)+)/i);
  if (!match) {
    return null;
  }

  return match[1].split('.').map((part) => Number.parseInt(part, 10));
}

function get_json_tree_collapsible_state(value) {
  if (Array.isArray(value)) {
    return value.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
  }

  return vscode.TreeItemCollapsibleState.None;
}

function get_json_tree_description(value) {
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).length}}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'undefined') {
    return 'undefined';
  }

  return String(value);
}

function create_json_tree_tooltip(label, value) {
  const rendered_value = value && typeof value === 'object'
    ? JSON.stringify(value, null, 2)
    : get_json_tree_description(value);
  return `${label}: ${rendered_value}`;
}

function get_json_tree_children(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => new JsonTreeItem(`[${index}]`, entry, options));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, entry]) => {
      if (options.flatten_single_driver && key === 'drivers' && Array.isArray(entry) && entry.length === 1) {
        return new JsonTreeItem('driver', entry[0], options);
      }

      return new JsonTreeItem(key, entry, options);
    });
  }

  return [];
}

async function prompt_for_filename(options) {
  const file_name = await vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.place_holder,
    value: options.default_value,
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

async function prompt_for_text(options) {
  const value = await vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.place_holder,
    value: options.default_value,
    validateInput: options.validate_input
  });

  return value?.trim();
}

function open_file(file_path) {
  return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file_path));
}

function run_simple_command(command, args, success_message, on_success, options = {}) {
  const command_cwd = options.cwd || get_workspace_path();
  if (!command_cwd) {
    vscode.window.showErrorMessage('Open a workspace before running MADS commands.');
    return;
  }

  const child = spawn(command, args, {
    cwd: command_cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (options.output_channel) {
    options.output_channel.clear();
    options.output_channel.show(true);
    options.output_channel.appendLine(`> ${command} ${args.join(' ')}`);
    options.output_channel.appendLine(`cwd: ${command_cwd}`);
    options.output_channel.appendLine('');
  }

  let stderr = '';

  child.stdout.on('data', (chunk) => {
    if (options.output_channel) {
      options.output_channel.append(chunk.toString());
    }
  });

  child.stderr.on('data', (chunk) => {
    const output = chunk.toString();
    stderr += output;
    if (options.output_channel) {
      options.output_channel.append(output);
    }
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

function launch_detached_command(command, args, error_label) {
  const workspace_path = get_workspace_path();
  if (!workspace_path) {
    vscode.window.showErrorMessage('Open a workspace before running MADS commands.');
    return;
  }

  const child = spawn(command, args, {
    cwd: workspace_path,
    env: process.env,
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    vscode.window.showErrorMessage(`Failed to launch ${error_label}: ${error.message}`);
  });

  child.unref();
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

async function write_template_file(template_path, target_path, on_success) {
  try {
    const contents = await fs.promises.readFile(template_path, 'utf8');
    await fs.promises.writeFile(target_path, contents, 'utf8');
    vscode.window.showInformationMessage(`Generated ${path.basename(target_path)}.`);
    on_success?.();
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to generate ${path.basename(target_path)}: ${error.message}`);
  }
}

function register_workspace_watchers(context, refresh) {
  const workspace_path = get_workspace_path();
  if (!workspace_path) {
    return;
  }

  const ini_watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace_path, '**/*.ini')
  );
  const toml_watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace_path, '**/*.toml')
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
    vscode.commands.registerCommand('mads.startActiveIniFile', (uri) => {
      const target_uri = uri instanceof vscode.Uri
        ? uri
        : vscode.window.activeTextEditor?.document?.uri;
      if (!target_uri || target_uri.scheme !== 'file') {
        vscode.window.showErrorMessage('Open an .ini or .toml file before starting MADS.');
        return;
      }

      process_manager.start_active_file(target_uri.fsPath);
    }),
    vscode.commands.registerCommand('mads.generateActiveFsmCpp', async (uri) => {
      const target_uri = uri instanceof vscode.Uri
        ? uri
        : vscode.window.activeTextEditor?.document?.uri;
      if (!target_uri || target_uri.scheme !== 'file' || path.extname(target_uri.fsPath) !== '.dot') {
        vscode.window.showErrorMessage('Open a .dot file before generating FSM code.');
        return;
      }

      const workspace_folder = vscode.workspace.getWorkspaceFolder(target_uri);
      if (!workspace_folder) {
        vscode.window.showErrorMessage('Open the .dot file from a workspace before generating FSM code.');
        return;
      }

      const workspace_path = workspace_folder.uri.fsPath;

      const source_dir = await prompt_for_text({
        prompt: 'Source directory',
        place_holder: 'src',
        default_value: 'src',
        validate_input: (value) => {
          if (!value || !value.trim()) {
            return 'A source directory is required.';
          }
          if (path.isAbsolute(value.trim())) {
            return 'Use a path relative to the current project root.';
          }
          return null;
        }
      });
      if (!source_dir) {
        return;
      }

      const class_name = await prompt_for_text({
        prompt: 'Class name',
        place_holder: 'fsm_agent',
        default_value: 'fsm_agent',
        validate_input: (value) => {
          if (!value || !value.trim()) {
            return 'A class name is required.';
          }
          if (/[\\/]/.test(value.trim())) {
            return 'Use only the class name, without path separators.';
          }
          if (/\s/.test(value.trim())) {
            return 'Use a class name without whitespace.';
          }
          return null;
        }
      });
      if (!class_name) {
        return;
      }

      const output_directory = path.join(workspace_path, source_dir);
      const output_path = path.join(output_directory, class_name);
      try {
        await fs.promises.mkdir(output_directory, { recursive: true });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create ${output_directory}: ${error.message}`);
        return;
      }

      run_simple_command(
        'mads',
        ['fsm', '--cpp', '-o', output_path, target_uri.fsPath],
        `Generated FSM C++ sources in ${output_path}.`,
        undefined,
        {
          cwd: workspace_path,
          output_channel
        }
      );
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
        default_value: 'mads.ini',
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
        default_value: 'director.toml',
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
    vscode.commands.registerCommand('mads.generateFsmTemplateFile', async () => {
      const workspace_path = get_workspace_path();
      if (!workspace_path) {
        vscode.window.showErrorMessage('Open a workspace before generating configuration files.');
        return;
      }

      const file_name = await prompt_for_filename({
        prompt: 'FSM template filename',
        place_holder: 'fsm.dot',
        default_value: 'fsm.dot',
        extension: '.dot'
      });
      if (!file_name) {
        return;
      }

      const template_path = path.join(context.extensionPath, 'media', 'svm.dot');
      const target_path = path.join(workspace_path, file_name);

      await write_template_file(template_path, target_path, () => {
        void open_file(target_path);
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
        ['plugin', '--type', plugin_type, '--dir', '.', plugin_name],
        `Created plugin ${plugin_name}.`,
        () => {
          plugins_provider.refresh();
          refresh_all();
        }
      );
    }),
    vscode.commands.registerCommand('mads.openTreeLink', (item) => {
      if (!item?.link_url) {
        return;
      }
      return vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(item.link_url));
    }),
    vscode.commands.registerCommand('mads.launchChat', () => {
      launch_detached_command('mads', ['chat'], 'mads chat');
    }),
    vscode.commands.registerCommand('mads.revealTreePath', (item) => {
      if (!item?.reveal_path) {
        return;
      }
      return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.reveal_path));
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
