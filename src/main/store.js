// Persistent app state (server list + settings) stored in the Electron userData folder.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let data = null;
const file = () => path.join(app.getPath('userData'), 'manager.json');

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  data.servers = Array.isArray(data.servers) ? data.servers : [];
  data.settings = data.settings || {};
  return data;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
}

module.exports = {
  load,
  save,
  get servers() { return load().servers; },
  get settings() { return load().settings; },
};
