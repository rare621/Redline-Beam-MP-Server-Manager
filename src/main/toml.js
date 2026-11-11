// Minimal TOML support for BeamMP's ServerConfig.toml.
// Parsing handles sections, strings, numbers and booleans. Writing edits values
// line-by-line so comments and ordering in the user's file are preserved.

function parseValue(raw) {
  raw = raw.trim();
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[++i];
        out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[n] ?? n;
      } else if (c === '"') break;
      else out += c;
    }
    return out;
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return raw.slice(1, end < 0 ? undefined : end);
  }
  const v = raw.replace(/\s+#.*$/, '').trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parse(text) {
  const result = {};
  let section = result;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sec = t.match(/^\[([^\]]+)\]/);
    if (sec) {
      section = result[sec[1].trim()] = result[sec[1].trim()] || {};
      continue;
    }
    const kv = t.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.*)$/);
    if (kv) section[kv[1]] = parseValue(kv[2]);
  }
  return result;
}

function format(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
}

// Set values for one section, keeping everything else in the file intact.
function setValues(text, sectionName, values) {
  const lines = String(text || '').split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  let current = null;
  let sectionEnd = -1; // index after last line of target section
  let sectionFound = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const sec = t.match(/^\[([^\]]+)\]/);
    if (sec) {
      current = sec[1].trim();
      if (current === sectionName) { sectionFound = true; sectionEnd = i + 1; }
      continue;
    }
    if (current !== sectionName) continue;
    if (t) sectionEnd = i + 1;
    const kv = t.match(/^([A-Za-z0-9_\-]+)\s*=/);
    if (kv && pending.has(kv[1])) {
      lines[i] = `${kv[1]} = ${format(pending.get(kv[1]))}`;
      pending.delete(kv[1]);
    }
  }

  if (pending.size) {
    const add = [...pending].map(([k, v]) => `${k} = ${format(v)}`);
    if (sectionFound) lines.splice(sectionEnd, 0, ...add);
    else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      if (lines.length) lines.push('');
      lines.push(`[${sectionName}]`, ...add);
    }
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

module.exports = { parse, setValues, format };
