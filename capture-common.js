"use strict";

/* exported QUALITY, pad, stamp, pickMime, extForMime, withMp4Index, humanError, buildAudioGraph, formatElapsed */

// Utilities shared by offscreen.js (tab recording), recorder.js
// (screen/window recording) and popup.js. Loaded before them.

const QUALITY = {
  high: { frameRate: 30, videoBitsPerSecond: 8_000_000 },
  medium: { frameRate: 30, videoBitsPerSecond: 4_000_000 },
  light: { frameRate: 15, videoBitsPerSecond: 1_500_000 },
};

const pad = (n) => String(n).padStart(2, "0");

function stamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

// Elapsed milliseconds → "mm:ss" ("hh:mm:ss" past the hour). Shared by
// the popup timer, the recorder timer and the report's duration line.
function formatElapsed(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
}

// MP4 FIRST, and not for compatibility: MediaRecorder writes WebM in
// streaming mode, with no Duration in the header and no Cues index, so the
// player reports duration Infinity and its scrub bar is useless — you cannot
// jump to the middle of your own recording. The MP4 container carries the
// real duration (measured: 4.98 s vs Infinity for the same clip). H.264 also
// travels better than VP9 outside the browser. AAC first because Opus inside
// MP4 is legal but not every desktop player decodes it; Chrome picks whatever
// its build supports and WebM stays as the last resort.
function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,opus",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

// File extension for the container actually used. Never hardcode it: which
// mime pickMime() lands on depends on the Chrome build.
function extForMime(mimeType) {
  if (/mp4/i.test(mimeType)) return "mp4";
  if (/matroska/i.test(mimeType)) return "mkv";
  return "webm";
}

// ---------- MP4 random-access index (mfra) ----------

// MediaRecorder can only write FRAGMENTED MP4: recording live, it does not
// know the total length, so it emits moof+mdat pairs instead of a sample
// table, and it never writes the `mfra` random-access index (there is nothing
// to index until the end). The moov does carry the duration, so players show
// the total length, but Windows Media Player (Media Foundation) REFUSES TO
// SEEK without that index. Verified on the same clip: byte-identical file
// plus mfra, and the scrub bar works. Chrome and VLC walk the fragments
// themselves and never needed it.
//
// Built here from the finished recording, reading only box HEADERS through
// blob.slice(): a 300 MB capture is never pulled into memory, and the result
// is a Blob composed of the original plus a few hundred bytes.

// Reads one box header at `offset`. Returns null past the end or on garbage,
// which stops the walk instead of looping on a bogus size.
async function readBoxHeader(blob, offset) {
  const buf = await blob.slice(offset, offset + 16).arrayBuffer();
  if (buf.byteLength < 8) return null;
  const dv = new DataView(buf);
  let size = dv.getUint32(0);
  let headerSize = 8;
  const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
  if (size === 1) {
    if (buf.byteLength < 16) return null;
    size = Number(dv.getBigUint64(8));
    headerSize = 16;
  } else if (size === 0) {
    size = blob.size - offset; // "to end of file"
  }
  if (size < headerSize || offset + size > blob.size) return null;
  return { type, size, headerSize };
}

// Per-track decode times inside one moof: [{ trackId, baseMediaDecodeTime }].
// tfhd gives the track, tfdt the time; both live inside each traf.
function parseMoofTracks(buf) {
  const dv = new DataView(buf);
  const out = [];
  const walk = (start, end, inTraf, acc) => {
    let o = start;
    while (o + 8 <= end) {
      const size = dv.getUint32(o);
      const type = String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
      if (size < 8 || o + size > end) return;
      if (type === "traf") {
        const t = {};
        walk(o + 8, o + size, true, t);
        if (t.trackId != null) out.push({ trackId: t.trackId, time: t.time || 0 });
      } else if (inTraf && type === "tfhd") {
        acc.trackId = dv.getUint32(o + 12); // after size+type+version/flags
      } else if (inTraf && type === "tfdt") {
        const version = dv.getUint8(o + 8);
        acc.time = version === 1 ? Number(dv.getBigUint64(o + 12)) : dv.getUint32(o + 12);
      }
      o += size;
    }
  };
  walk(0, buf.byteLength, false, null);
  return out;
}

// version 1 (64-bit time and offset) with 1-byte traf/trun/sample numbers:
// byte-for-byte the shape ffmpeg emits, which is the one verified to work.
function buildMfra(byTrack) {
  const ENTRY = 8 + 8 + 1 + 1 + 1;
  const tfraSize = (n) => 8 + 4 + 4 + 4 + 4 + n * ENTRY;
  const total =
    8 + [...byTrack.values()].reduce((s, e) => s + tfraSize(e.length), 0) + 16;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const ascii = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  let p = 0;

  dv.setUint32(p, total); ascii(p + 4, "mfra"); p += 8;

  for (const [trackId, entries] of byTrack) {
    dv.setUint32(p, tfraSize(entries.length)); ascii(p + 4, "tfra"); p += 8;
    dv.setUint32(p, 0x01000000); p += 4; // version 1, flags 0
    dv.setUint32(p, trackId); p += 4;
    dv.setUint32(p, 0); p += 4; // traf/trun/sample numbers are 1 byte each
    dv.setUint32(p, entries.length); p += 4;
    for (const e of entries) {
      dv.setBigUint64(p, BigInt(e.time)); p += 8;
      dv.setBigUint64(p, BigInt(e.offset)); p += 8;
      dv.setUint8(p++, 1); // first traf
      dv.setUint8(p++, 1); // first trun
      dv.setUint8(p++, 1); // first sample
    }
  }

  dv.setUint32(p, 16); ascii(p + 4, "mfro"); p += 8;
  dv.setUint32(p, 0); p += 4; // version 0, flags 0
  dv.setUint32(p, total); // mfro repeats the mfra size so players find it
  return out;
}

// Returns the blob with an mfra appended, or the SAME blob untouched when
// there is nothing to do (WebM, progressive MP4) or anything looks off. A
// recording that cannot be indexed still has to be a recording.
async function withMp4Index(blob, mimeType) {
  if (!/mp4/i.test(mimeType || blob.type || "")) return blob;
  const moofs = [];
  let offset = 0;
  while (offset < blob.size) {
    const box = await readBoxHeader(blob, offset);
    if (!box) break;
    if (box.type === "mfra") return blob; // already indexed
    // The CHILDREN are what carries tfhd/tfdt, so the header is skipped here:
    // parsing from the moof itself would just walk over one opaque box.
    if (box.type === "moof") {
      moofs.push({ offset, from: offset + box.headerSize, to: offset + box.size });
    }
    offset += box.size;
  }
  if (!moofs.length) return blob; // not fragmented: nothing to index

  const byTrack = new Map();
  for (const moof of moofs) {
    const buf = await blob.slice(moof.from, moof.to).arrayBuffer();
    for (const t of parseMoofTracks(buf)) {
      if (!byTrack.has(t.trackId)) byTrack.set(t.trackId, []);
      byTrack.get(t.trackId).push({ time: t.time, offset: moof.offset });
    }
  }
  if (!byTrack.size) return blob;

  return new Blob([blob, buildMfra(byTrack)], { type: blob.type });
}

function humanError(e) {
  const name = e && e.name;
  if (name === "NotAllowedError") return "permission denied (NotAllowedError).";
  if (name === "NotFoundError") return "source not found (NotFoundError).";
  if (name === "NotReadableError") return "the source is in use or unreadable (NotReadableError).";
  return (name ? name + ": " : "") + (e && e.message ? e.message : String(e));
}

// Combines system audio and microphone into one track. With playthrough,
// it re-injects system audio into the speakers (needed when capturing
// tabs, because Chrome mutes them while they are captured).
function buildAudioGraph(sysTrack, micTrack, playthrough) {
  if (!sysTrack && !micTrack) return { audioTrack: null, audioCtx: null };
  if (!sysTrack) return { audioTrack: micTrack, audioCtx: null }; // mic only

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();

  const sys = ctx.createMediaStreamSource(new MediaStream([sysTrack]));
  sys.connect(dest);
  if (playthrough) sys.connect(ctx.destination);

  if (micTrack) {
    ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
  }
  return { audioTrack: dest.stream.getAudioTracks()[0], audioCtx: ctx };
}
