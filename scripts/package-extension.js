#!/usr/bin/env node
/**
 * Empaqueta la extensión en un .zip listo para "Load unpacked".
 *
 * Sin dependencias, como la propia extensión: el ZIP se escribe a mano con
 * zlib. Dos garantías que justifican que esto sea un script y no un `zip -r`:
 *
 *  1. Lista explícita de lo que entra. Un `zip -r .` con exclusiones deja
 *     entrar cualquier archivo nuevo que nadie recuerde excluir (tests,
 *     configs, credenciales de un .env). Aquí lo que no está listado no viaja.
 *  2. Comprobación de integridad. Todo archivo referenciado por el manifest o
 *     por un HTML tiene que estar en el paquete: si un refactor renombra un
 *     script y se olvida de una referencia, el empaquetado falla aquí y no en
 *     el Chrome de quien se lo descargue.
 *
 * Uso: `npm run package` → dist/screen-recorder-qa-<version>.zip
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");

// Los tres *.config.js son de herramientas de test, no de la extensión.
const DEV_CONFIGS = new Set(["cypress.config.js", "eslint.config.js", "playwright.config.js"]);

const listFiles = (dir, filter) =>
  fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && filter(e.name))
    .map((e) => (dir ? `${dir}/${e.name}` : e.name))
    .sort();

/** Lo que se publica: runtime de la extensión, sus iconos y la licencia. */
function packageContents() {
  return [
    "manifest.json",
    "LICENSE",
    "README.md",
    ...listFiles("", (n) => n.endsWith(".html")),
    ...listFiles("", (n) => n.endsWith(".js") && !DEV_CONFIGS.has(n)),
    ...listFiles("icons", (n) => /\.(png|svg)$/.test(n)),
  ];
}

/**
 * Toda referencia a un archivo local desde el manifest o desde un HTML debe
 * estar incluida. Recoge las rutas relativas y las contrasta con el paquete.
 */
function assertNoDanglingReferences(files) {
  const included = new Set(files);
  const missing = [];

  const check = (ref, from) => {
    const clean = ref.split(/[?#]/)[0];
    if (!clean || /^(https?:|data:|mailto:|chrome:|#)/.test(clean)) return;
    if (!included.has(clean)) missing.push(`${clean} (referenciado desde ${from})`);
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  JSON.stringify(manifest).match(/"[^"]+\.(?:js|html|png|svg)"/g)?.forEach((m) => {
    check(m.slice(1, -1), "manifest.json");
  });

  // Los content scripts se inyectan por código, no por el manifest.
  for (const js of files.filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(ROOT, js), "utf8");
    src.match(/["'][\w./-]+\.(?:js|html)["']/g)?.forEach((m) => check(m.slice(1, -1), js));
  }

  for (const html of files.filter((f) => f.endsWith(".html"))) {
    const src = fs.readFileSync(path.join(ROOT, html), "utf8");
    src.match(/(?:src|href)="([^"]+)"/g)?.forEach((m) => check(m.slice(m.indexOf('"') + 1, -1), html));
  }

  if (missing.length) {
    console.error("✗ El paquete deja fuera archivos que la extensión referencia:\n");
    [...new Set(missing)].forEach((m) => console.error(`  - ${m}`));
    process.exit(1);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fecha fija (1980-01-01, el cero del formato ZIP): dos empaquetados del mismo
// commit dan un archivo byte a byte idéntico, así que el zip publicado se puede
// verificar contra el que genere cualquiera desde el código.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 30);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt32LE(0, 36);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const files = packageContents();

const absent = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (absent.length) {
  console.error(`✗ Archivos listados que no existen: ${absent.join(", ")}`);
  process.exit(1);
}

assertNoDanglingReferences(files);

const archive = zip(files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) })));
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `screen-recorder-qa-${version}.zip`);
fs.writeFileSync(out, archive);

console.log(`✓ ${path.relative(ROOT, out)} — ${files.length} archivos, ${(archive.length / 1024).toFixed(1)} kB`);
