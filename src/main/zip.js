// Zip helpers built on yauzl: reads only the central directory plus the
// entries we ask for, so scanning large BeamNG content zips stays fast.
const yauzl = require('yauzl');

function open(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: false, decodeStrings: true },
      (err, zip) => (err ? reject(err) : resolve(zip))));
}

async function openWithEntries(file) {
  const zip = await open(file);
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => { entries.push(e); zip.readEntry(); });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  const byName = new Map(entries.map((e) => [e.fileName.toLowerCase(), e]));
  return {
    zip,
    entries,
    names: entries.map((e) => e.fileName),
    get: (name) => byName.get(String(name).toLowerCase()),
    read: (entry) => readEntry(zip, entry),
    close: () => { try { zip.close(); } catch { /* ignore */ } },
  };
}

function readEntry(zip, entry, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) return reject(new Error('entry too large'));
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// BeamNG JSON files allow comments, trailing commas and sometimes missing commas.
function lenientJson(buf) {
  let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  text = text.replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { /* fall through */ }
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(out); } catch { /* fall through */ }
  // Last resort: insert missing commas between values on separate lines.
  try { return JSON.parse(out.replace(/(["}\]0-9el])(\s*\n\s*)(["{\[])/g, '$1,$2$3')); } catch { /* ignore */ }
  const pick = (key) => (out.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`)) || [])[1];
  return { Name: pick('Name'), Brand: pick('Brand'), Type: pick('Type'), title: pick('title'), description: pick('description') };
}

module.exports = { openWithEntries, lenientJson };
