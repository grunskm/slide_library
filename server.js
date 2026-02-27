const http = require("http");
const fs = require("fs/promises");
const fss = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PURGED_DIR = path.join(DATA_DIR, "purged");
const FIELD_BUNDLE_DIR = path.join(DATA_DIR, "field_bundle_archive");
const DB_FILE = path.join(DATA_DIR, "archive.json");
const PURGED_DB_FILE = path.join(DATA_DIR, "purged_archive.json");
const SLIDESHOWS_FILE = path.join(DATA_DIR, "slideshows.json");
const THUMB_MAX_EDGE = 360;
const execFileAsync = promisify(execFile);
const thumbnailJobs = new Map();
const PDF_PAGE_WIDTH = 11 * 72;
const PDF_PAGE_HEIGHT = 8.5 * 72;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".tif", ".tiff", ".avif"]);
const URL_FETCH_HEADERS = {
  "User-Agent": "SlideLibrary/1.0 (+local archive tool)",
  Accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
};
const DEFAULT_ARCHIVE_KEY = "slide_library";
const ARCHIVES = {
  slide_library: {
    key: "slide_library",
    label: "Slide Library",
    libraryDir: path.join(DATA_DIR, "library"),
    dbFile: DB_FILE,
    thumbsDir: path.join(DATA_DIR, "thumbs", "slide_library"),
    purgedDir: PURGED_DIR,
    purgedDbFile: PURGED_DB_FILE,
  },
  excursions: {
    key: "excursions",
    label: "Excursions",
    libraryDir: path.join(DATA_DIR, "excursions_library"),
    dbFile: path.join(DATA_DIR, "excursions_archive.json"),
    thumbsDir: path.join(DATA_DIR, "thumbs", "excursions"),
    purgedDir: path.join(DATA_DIR, "excursions_purged"),
    purgedDbFile: path.join(DATA_DIR, "excursions_purged_archive.json"),
  },
};

function parseArchiveKey(value) {
  const key = String(value || "").trim();
  return ARCHIVES[key] ? key : DEFAULT_ARCHIVE_KEY;
}

function getArchiveConfig(key) {
  return ARCHIVES[parseArchiveKey(key)];
}

function makeSlideshowId() {
  return `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultDb() {
  return {
    metadata: {},
  };
}

function defaultSlidesDb() {
  return {
    slideshows: {
      default: {
        name: "Current Slideshow",
        slides: [],
      },
    },
    currentSlideshowId: "default",
  };
}

function defaultPurgedDb() {
  return {
    items: [],
  };
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  for (const archive of Object.values(ARCHIVES)) {
    await fs.mkdir(archive.libraryDir, { recursive: true });
    await fs.mkdir(archive.purgedDir, { recursive: true });
    await fs.mkdir(archive.thumbsDir, { recursive: true });
    try {
      await fs.access(archive.dbFile);
    } catch {
      await fs.writeFile(archive.dbFile, JSON.stringify(defaultDb(), null, 2));
    }
    try {
      await fs.access(archive.purgedDbFile);
    } catch {
      await fs.writeFile(archive.purgedDbFile, JSON.stringify(defaultPurgedDb(), null, 2));
    }
  }

  try {
    await fs.access(SLIDESHOWS_FILE);
  } catch {
    await fs.writeFile(SLIDESHOWS_FILE, JSON.stringify(defaultSlidesDb(), null, 2));
  }
}

function thumbNameForRelPath(relPath) {
  return `${fileToId(relPath)}.jpg`;
}

async function ensureThumbnail(archive, absSourcePath, relPath) {
  const jobKey = `${archive.key}:${relPath}`;
  if (thumbnailJobs.has(jobKey)) return;

  const job = (async () => {
    const absThumbPath = path.join(archive.thumbsDir, thumbNameForRelPath(relPath));
    try {
      await fs.mkdir(archive.thumbsDir, { recursive: true });
      await execFileAsync("sips", [
        "-s",
        "format",
        "jpeg",
        "-Z",
        String(THUMB_MAX_EDGE),
        absSourcePath,
        "--out",
        absThumbPath,
      ]);
    } catch {
      // Keep original image fallback if thumbnail generation fails for this format.
    }
  })();

  thumbnailJobs.set(jobKey, job);
  job.finally(() => {
    thumbnailJobs.delete(jobKey);
  });
}

async function getThumbnailUrl(archive, absSourcePath, relPath, sourceMtimeMs) {
  const thumbName = thumbNameForRelPath(relPath);
  const absThumbPath = path.join(archive.thumbsDir, thumbName);

  let thumbStat = null;
  try {
    thumbStat = await fs.stat(absThumbPath);
  } catch {
    thumbStat = null;
  }

  const thumbFresh = thumbStat && thumbStat.mtimeMs >= sourceMtimeMs;
  if (!thumbFresh) {
    ensureThumbnail(archive, absSourcePath, relPath);
  }

  if (!thumbStat) return "";
  return `/thumbs/${archive.key}/${encodeURIComponent(thumbName)}`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

function sendBinary(res, status, bytes, type, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": bytes.length,
    ...extraHeaders,
  });
  res.end(bytes);
}

function safeJoin(root, relPath) {
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    return null;
  }
  return resolved;
}

function fileToId(relPath) {
  return Buffer.from(relPath, "utf8").toString("base64url");
}

function idToFile(id) {
  try {
    return Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function normalizePurgedDb(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return { items };
}

async function readPurgedDb(archive) {
  try {
    const raw = await fs.readFile(archive.purgedDbFile, "utf8");
    return normalizePurgedDb(JSON.parse(raw));
  } catch {
    return defaultPurgedDb();
  }
}

async function writePurgedDb(archive, db) {
  await fs.writeFile(archive.purgedDbFile, JSON.stringify(db, null, 2));
}

function uniqueRelPathInDir(rootDir, relPath) {
  const normalizedRel = relPath.replaceAll(path.sep, path.posix.sep);
  const ext = path.posix.extname(normalizedRel);
  const stem = normalizedRel.slice(0, normalizedRel.length - ext.length);
  let nextRel = normalizedRel;
  let index = 1;
  while (fss.existsSync(path.join(rootDir, nextRel))) {
    index += 1;
    nextRel = `${stem}-${index}${ext}`;
  }
  return nextRel;
}

async function moveFileSafely(fromAbs, toAbs) {
  try {
    await fs.rename(fromAbs, toAbs);
  } catch (err) {
    if (err && err.code !== "EXDEV") throw err;
    await fs.copyFile(fromAbs, toAbs);
    await fs.unlink(fromAbs);
  }
}

function normalizeMetadataPayload(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    title: String(source.title || "").trim(),
    artist: String(source.artist || "").trim(),
    year: String(source.year || "").trim(),
    medium: String(source.medium || "").trim(),
    gallery: String(source.gallery || "").trim(),
    size: String(source.size || "").trim(),
    tags: Array.isArray(source.tags) ? source.tags.map((t) => String(t).trim()).filter(Boolean) : [],
  };
}

function defaultMetadataRecord() {
  return {
    title: "",
    artist: "",
    year: "",
    medium: "",
    gallery: "",
    size: "",
    tags: [],
  };
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractExcursionAndImageParts(stem) {
  const value = String(stem || "");
  if (!value.startsWith("FB_")) {
    return { excursion: "", imagePart: "" };
  }

  const rest = value.slice(3);
  const imgMarker = rest.indexOf("_IMG_");
  if (imgMarker >= 0) {
    const excursion = rest.slice(0, imgMarker);
    const imagePart = `IMG_${rest.slice(imgMarker + "_IMG_".length)}`;
    return { excursion, imagePart };
  }

  const cut = rest.lastIndexOf("_");
  if (cut <= 0) {
    return { excursion: rest, imagePart: "" };
  }

  return {
    excursion: rest.slice(0, cut),
    imagePart: rest.slice(cut + 1),
  };
}

function candidateImageIdsForRelPath(relPath) {
  const rel = String(relPath || "").trim().replaceAll("\\", "/");
  const filename = path.posix.basename(rel);
  if (!filename) return [];
  return [filename, filename.toLowerCase()];
}

function parseFieldBundleEntries(parsed) {
  const entries = [];
  if (!parsed || typeof parsed !== "object") return entries;

  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      if (!item || typeof item !== "object") continue;
      const rawId = item.id || item.imageId || item.photoId || item.fileId || item.filename || item.fileName || "";
      const id = String(rawId || "").trim();
      if (!id) continue;
      entries.push([id, normalizeMetadataPayload(item)]);
    }
    return entries;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    entries.push([String(key).trim(), normalizeMetadataPayload(value)]);
  }

  return entries;
}

async function readFieldBundleCatalog() {
  const files = await fs.readdir(FIELD_BUNDLE_DIR, { withFileTypes: true }).catch(() => []);
  const catalog = [];

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;

    const abs = path.join(FIELD_BUNDLE_DIR, entry.name);
    try {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = JSON.parse(raw);
      const entries = parseFieldBundleEntries(parsed);
      if (!entries.length) continue;

      const fileStem = path.basename(entry.name, ".json");
      const excursionFromName = normalizeSlug(fileStem.replace(/^photo_metadata_/i, ""));
      const byId = new Map();
      for (const [id, metadata] of entries) {
        const key = String(id || "").trim();
        if (!key) continue;
        byId.set(key, metadata);
        byId.set(key.toLowerCase(), metadata);
      }

      catalog.push({
        sourceFile: entry.name,
        excursionSlug: excursionFromName,
        byId,
      });
    } catch {
      // Ignore unreadable or invalid bundle files.
    }
  }

  return catalog;
}

async function findFieldBundleMetadataForImage(relPath) {
  const stem = path.basename(relPath, path.extname(relPath));
  const { excursion } = extractExcursionAndImageParts(stem);
  const excursionSlug = normalizeSlug(excursion);
  const candidateIds = candidateImageIdsForRelPath(relPath);
  if (!candidateIds.length) return null;

  const catalog = await readFieldBundleCatalog();
  if (!catalog.length) return null;

  if (!excursionSlug) return null;
  const matchingBundles = catalog.filter((bundle) => bundle.excursionSlug === excursionSlug);
  if (!matchingBundles.length) return null;

  for (const bundle of matchingBundles) {
    for (const candidateId of candidateIds) {
      const hit = bundle.byId.get(candidateId);
      if (hit) return hit;
    }
  }

  return null;
}

async function purgeItemFromArchiveById(archive, id, metadataOverride) {
  const relPath = idToFile(id);
  const absSource = safeJoin(archive.libraryDir, relPath);
  if (!relPath || !absSource || !fss.existsSync(absSource)) {
    throw new Error("Item not found");
  }

  const purgedRelPath = uniqueRelPathInDir(archive.purgedDir, relPath);
  const absDest = safeJoin(archive.purgedDir, purgedRelPath);
  if (!absDest) {
    throw new Error("Could not resolve purge destination");
  }
  await fs.mkdir(path.dirname(absDest), { recursive: true });
  await moveFileSafely(absSource, absDest);

  const db = await readDb(archive);
  const knownMeta = db.metadata[id] || {};
  const normalizedMeta = metadataOverride
    ? normalizeMetadataPayload(metadataOverride)
    : normalizeMetadataPayload(knownMeta);

  delete db.metadata[id];
  await writeDb(archive, db);

  let removedFromSlides = 0;
  const slidesDb = await readSlidesDb();
  for (const show of Object.values(slidesDb.slideshows)) {
    const before = Array.isArray(show.slides) ? show.slides.length : 0;
    show.slides = Array.isArray(show.slides)
      ? show.slides.filter((slideRef) => !(slideRef.id === id && slideRef.archive === archive.key))
      : [];
    removedFromSlides += Math.max(0, before - show.slides.length);
  }
  await writeSlidesDb(slidesDb);

  const thumbPath = path.join(archive.thumbsDir, thumbNameForRelPath(relPath));
  await fs.unlink(thumbPath).catch(() => {});

  const purged = await readPurgedDb(archive);
  purged.items.push({
    id,
    originalRelPath: relPath,
    purgedRelPath,
    purgedAt: new Date().toISOString(),
    metadata: normalizedMeta,
  });
  await writePurgedDb(archive, purged);

  return { purgedRelPath, removedFromSlides };
}

function decodeHtmlEntities(value) {
  const text = String(value || "");
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m);
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaTag(html, key, value) {
  const re = new RegExp(
    `<meta[^>]*${key}\\s*=\\s*["']${value}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
    "i"
  );
  const altRe = new RegExp(
    `<meta[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*${key}\\s*=\\s*["']${value}["'][^>]*>`,
    "i"
  );
  const m = html.match(re) || html.match(altRe);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

function extractTagText(html, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = html.match(re);
  return m ? stripHtml(m[1]) : "";
}

function extractTitleFromWikipedia(html) {
  const heading = html.match(/<h1[^>]*id=["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (heading) return stripHtml(heading[1]);
  return "";
}

function extractInfoboxValue(html, labels) {
  const infobox = html.match(/<table[^>]*class=["'][^"']*infobox[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  const source = infobox ? infobox[1] : html;
  const rows = source.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  const normalized = labels.map((label) => String(label || "").toLowerCase());

  for (const row of rows) {
    const rowHtml = row[1];
    const th = rowHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const td = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!th || !td) continue;

    const key = stripHtml(th[1]).toLowerCase();
    const hit = normalized.some((label) => key === label || key.includes(label));
    if (!hit) continue;
    return stripHtml(td[1]);
  }

  return "";
}

function normalizeWikiThumbUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.endsWith("wikimedia.org")) return rawUrl;
    if (!url.pathname.includes("/thumb/")) return rawUrl;
    const normalizedPath = url.pathname
      .replace("/thumb/", "/")
      .replace(/\/\d+px-[^/]+$/, "");
    url.pathname = normalizedPath;
    url.search = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function extractImageUrlsFromHtml(html, pageUrl) {
  const ordered = [];
  const seen = new Set();
  const addUrl = (raw, label = "") => {
    if (!raw) return;
    if (/^data:/i.test(raw)) return;
    try {
      const absolute = new URL(raw, pageUrl).toString();
      const normalized = normalizeWikiThumbUrl(absolute);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      ordered.push({ url: normalized, label });
    } catch {
      // ignore malformed URL
    }
  };

  const wikiInfobox = html.match(/<table[^>]*class=["'][^"']*infobox[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (wikiInfobox) {
    const infoboxImgs = wikiInfobox[1].matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi);
    for (const img of infoboxImgs) {
      addUrl(img[1], "Infobox image");
    }
  }

  const ogImage = extractMetaTag(html, "property", "og:image");
  addUrl(ogImage, "Open Graph image");

  const twitterImage = extractMetaTag(html, "name", "twitter:image");
  addUrl(twitterImage, "Twitter image");

  const allImages = html.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi);
  for (const img of allImages) {
    addUrl(img[1], "Page image");
  }

  return ordered.slice(0, 80);
}

function extractMetadataFromHtml(html) {
  const title = extractTitleFromWikipedia(html) || extractMetaTag(html, "property", "og:title") || extractTagText(html, "title");
  const artist = extractInfoboxValue(html, ["artist", "painter", "author", "creator"]);
  const yearRaw = extractInfoboxValue(html, ["year", "date"]);
  const year = (yearRaw.match(/(?:1[0-9]{3}|20[0-9]{2})/) || [yearRaw])[0] || "";
  const medium = extractInfoboxValue(html, ["medium", "material"]);
  const size = extractInfoboxValue(html, ["dimensions", "size"]);

  return { title, artist, year, medium, size };
}

function contentTypeToExt(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("image/jpeg")) return ".jpg";
  if (value.includes("image/png")) return ".png";
  if (value.includes("image/gif")) return ".gif";
  if (value.includes("image/webp")) return ".webp";
  if (value.includes("image/bmp")) return ".bmp";
  if (value.includes("image/tiff")) return ".tif";
  if (value.includes("image/avif")) return ".avif";
  if (value.includes("image/svg+xml")) return ".svg";
  return "";
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 180);
}

function ensureImageExtension(filename, fallbackExt = ".jpg") {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return filename;
  return `${filename}${fallbackExt}`;
}

function uniqueFilename(dir, candidate) {
  const parsed = path.parse(candidate);
  let index = 1;
  let current = candidate;
  while (fss.existsSync(path.join(dir, current))) {
    index += 1;
    current = `${parsed.name}-${index}${parsed.ext}`;
  }
  return current;
}

async function downloadImageFromUrl(archive, urlString) {
  const response = await fetch(urlString, { headers: URL_FETCH_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not download image (${response.status}).`);
  }
  const contentType = String(response.headers.get("content-type") || "");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error("Downloaded image is empty.");
  }

  const finalUrl = String(response.url || urlString);
  const extFromType = contentTypeToExt(contentType);
  const parsed = new URL(finalUrl);
  const baseName = sanitizeName(path.basename(parsed.pathname || "image")) || `image-${Date.now()}`;
  const fallbackExt = extFromType || ".jpg";
  const named = ensureImageExtension(baseName, fallbackExt);
  const relPath = uniqueFilename(archive.libraryDir, named);
  const absPath = path.join(archive.libraryDir, relPath);
  await fs.writeFile(absPath, bytes);

  return { relPath, contentType };
}

function parseAndValidateHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("url is required");
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are supported");
  }
  return parsed;
}

async function listImportCandidatesFromUrl(sourceUrlValue) {
  const source = parseAndValidateHttpUrl(sourceUrlValue);
  const response = await fetch(source.toString(), { headers: URL_FETCH_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not fetch URL (${response.status})`);
  }

  const finalUrl = String(response.url || source.toString());
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.startsWith("image/")) {
    const parsed = new URL(finalUrl);
    const baseName = sanitizeName(path.basename(parsed.pathname || "image")) || "Image";
    return {
      sourceUrl: finalUrl,
      metadata: {},
      candidates: [{ url: finalUrl, label: baseName }],
    };
  }

  const html = await response.text();
  const meta = extractMetadataFromHtml(html);
  const candidates = extractImageUrlsFromHtml(html, finalUrl);
  return {
    sourceUrl: finalUrl,
    metadata: {
      title: meta.title || "",
      artist: meta.artist || "",
      year: meta.year || "",
      medium: meta.medium || "",
      size: meta.size || "",
    },
    candidates,
  };
}

async function importSelectedImageFromCandidate(archive, payload) {
  const imageUrl = parseAndValidateHttpUrl(payload?.imageUrl).toString();
  const meta = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const importResult = await downloadImageFromUrl(archive, imageUrl);
  const fallbackTitle = sanitizeName(path.basename(importResult.relPath, path.extname(importResult.relPath)));
  const normalizedMeta = {
    title: String(meta.title || fallbackTitle).trim(),
    artist: String(meta.artist || "").trim(),
    year: String(meta.year || "").trim(),
    medium: String(meta.medium || "").trim(),
    gallery: String(meta.gallery || "").trim(),
    size: String(meta.size || "").trim(),
    tags: [],
  };

  const id = fileToId(importResult.relPath);
  const db = await readDb(archive);
  db.metadata[id] = normalizedMeta;
  await writeDb(archive, db);
  return { itemId: id, relPath: importResult.relPath };
}

function buildCaptionParts(values) {
  const artist = String(values.artist || "").trim() || "Unknown artist";
  const title = String(values.title || "").trim() || "(title unknown)";
  const year = String(values.year || "").trim();
  const size = String(values.size || "").trim();
  const medium = String(values.medium || "").trim();
  const tail = [medium, size].filter(Boolean).join(", ");
  const prefix = `${artist},\u00A0`;
  const suffixCore = year ? `, ${year}.` : ".";
  const suffix = tail ? `${suffixCore} ${tail}.` : suffixCore;
  return { prefix, title, suffix };
}

function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ");
  return cleaned || "slideshow";
}

function fitContain(srcW, srcH, maxW, maxH) {
  if (!srcW || !srcH || srcW <= 0 || srcH <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return {
    width: srcW * scale,
    height: srcH * scale,
  };
}

function fitCaptionPartsToWidth(prefix, title, suffix, maxWidth, normalFont, italicFont, size) {
  const full = `${prefix}${title}${suffix}`;
  const ellipsis = "…";
  const ellipsisW = normalFont.widthOfTextAtSize(ellipsis, size);

  const measure = (a, b, c, includeEllipsis = false) => {
    const wA = a ? normalFont.widthOfTextAtSize(a, size) : 0;
    const wB = b ? italicFont.widthOfTextAtSize(b, size) : 0;
    const wC = c ? normalFont.widthOfTextAtSize(c, size) : 0;
    return wA + wB + wC + (includeEllipsis ? ellipsisW : 0);
  };

  if (measure(prefix, title, suffix, false) <= maxWidth) {
    return { prefix, title, suffix, ellipsis: false };
  }

  const maxKeep = Math.max(0, full.length);
  for (let keep = maxKeep; keep >= 0; keep -= 1) {
    let left = keep;
    const a = prefix.slice(0, Math.min(prefix.length, left));
    left -= a.length;
    const b = title.slice(0, Math.min(title.length, left));
    left -= b.length;
    const c = suffix.slice(0, Math.min(suffix.length, left));
    if (measure(a, b, c, true) <= maxWidth) {
      return { prefix: a, title: b, suffix: c, ellipsis: true };
    }
  }

  return { prefix: "", title: "", suffix: "", ellipsis: true };
}

async function readImageForPdf(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return { format: "jpg", bytes: await fs.readFile(absPath) };
  }
  if (ext === ".png") {
    return { format: "png", bytes: await fs.readFile(absPath) };
  }

  const tempName = `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const tempPath = path.join(DATA_DIR, tempName);
  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", absPath, "--out", tempPath]);
    return { format: "jpg", bytes: await fs.readFile(tempPath) };
  } finally {
    fs.unlink(tempPath).catch(() => {});
  }
}

async function convertImageToJpegBytes(absPath) {
  const tempName = `pdf_fallback_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const tempPath = path.join(DATA_DIR, tempName);
  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", absPath, "--out", tempPath]);
    return await fs.readFile(tempPath);
  } finally {
    fs.unlink(tempPath).catch(() => {});
  }
}

async function generateSlideshowPdf(state, slideshowId) {
  let pdfLib;
  try {
    // Lazy-load so the app still runs even before dependencies are installed.
    pdfLib = require("pdf-lib");
  } catch {
    throw new Error('Missing dependency: "pdf-lib". Run "npm install" in the project folder.');
  }

  const { PDFDocument, rgb, StandardFonts } = pdfLib;
  const slideshow = state.slideshows.find((show) => show.id === slideshowId);
  if (!slideshow) {
    throw new Error("Slideshow not found.");
  }
  if (!slideshow.slides.length) {
    throw new Error("No slides in slideshow.");
  }

  const slideItemMap = state && typeof state.slideItems === "object" && state.slideItems ? state.slideItems : {};
  const pdf = await PDFDocument.create();
  const captionFont = await pdf.embedFont(StandardFonts.Helvetica);
  const captionItalicFont = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const outerPad = 0;
  const framePadTop = 13.5;
  const framePadSide = 15;
  const framePadBottom = 6;
  const captionH = 18;
  const frameGap = 2.25;
  const frameRadius = 6;
  const borderW = 0.75;
  const captionFontSize = 11;
  const captionColor = rgb(0.82, 0.84, 0.86);
  const black = rgb(0, 0, 0);
  const borderColor = rgb(0.07, 0.09, 0.16);

  for (const slideRef of slideshow.slides) {
    const refArchive = parseArchiveKey(slideRef.archive);
    const refId = String(slideRef.id || "").trim();
    const item = slideItemMap[`${refArchive}:${refId}`];
    if (!item) continue;

    const page = pdf.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);

    const frameW = PDF_PAGE_WIDTH - outerPad * 2;
    const frameH = PDF_PAGE_HEIGHT - outerPad * 2;
    const frameX = outerPad;
    const frameY = outerPad;

    page.drawRectangle({
      x: frameX,
      y: frameY,
      width: frameW,
      height: frameH,
      color: black,
      borderColor,
      borderWidth: borderW,
      borderRadius: frameRadius,
    });

    const contentX = frameX + framePadSide;
    const contentY = frameY + framePadBottom;
    const contentW = frameW - framePadSide * 2;
    const contentH = frameH - framePadTop - framePadBottom;
    const imageMaxH = contentH - captionH - frameGap;
    const imageY = contentY + captionH + frameGap;

    let image = null;
    try {
      const relPath = idToFile(item.id);
      const itemArchive = getArchiveConfig(item.archive || refArchive);
      const absPath = safeJoin(itemArchive.libraryDir, relPath);
      if (!absPath || !fss.existsSync(absPath)) {
        throw new Error("missing image");
      }
      const source = await readImageForPdf(absPath);
      try {
        image = source.format === "png" ? await pdf.embedPng(source.bytes) : await pdf.embedJpg(source.bytes);
      } catch {
        const fallbackBytes = await convertImageToJpegBytes(absPath);
        image = await pdf.embedJpg(fallbackBytes);
      }
    } catch {
      image = null;
    }

    if (image) {
      const fit = fitContain(image.width, image.height, contentW, imageMaxH);
      const imageX = contentX + (contentW - fit.width) / 2;
      const drawY = imageY + (imageMaxH - fit.height) / 2;
      page.drawImage(image, {
        x: imageX,
        y: drawY,
        width: fit.width,
        height: fit.height,
      });
    }

    const parts = buildCaptionParts(item);
    const fitParts = fitCaptionPartsToWidth(
      parts.prefix,
      parts.title,
      parts.suffix,
      contentW,
      captionFont,
      captionItalicFont,
      captionFontSize
    );

    const prefixWidth = fitParts.prefix ? captionFont.widthOfTextAtSize(fitParts.prefix, captionFontSize) : 0;
    const titleWidth = fitParts.title ? captionItalicFont.widthOfTextAtSize(fitParts.title, captionFontSize) : 0;
    const suffixWidth = fitParts.suffix ? captionFont.widthOfTextAtSize(fitParts.suffix, captionFontSize) : 0;
    const ellipsisWidth = fitParts.ellipsis ? captionFont.widthOfTextAtSize("…", captionFontSize) : 0;
    const totalWidth = prefixWidth + titleWidth + suffixWidth + ellipsisWidth;
    const textY = contentY + (captionH - captionFontSize) / 2;

    const textX = contentX + Math.max(0, (contentW - totalWidth) / 2);
    let cursorX = textX;

    if (fitParts.prefix) {
      page.drawText(fitParts.prefix, {
        x: cursorX,
        y: textY,
        size: captionFontSize,
        font: captionFont,
        color: captionColor,
      });
      cursorX += prefixWidth;
    }

    if (fitParts.title) {
      page.drawText(fitParts.title, {
        x: cursorX,
        y: textY,
        size: captionFontSize,
        font: captionItalicFont,
        color: captionColor,
      });
      cursorX += titleWidth;
    }

    if (fitParts.suffix) {
      page.drawText(fitParts.suffix, {
        x: cursorX,
        y: textY,
        size: captionFontSize,
        font: captionFont,
        color: captionColor,
      });
      cursorX += suffixWidth;
    }

    if (fitParts.ellipsis) {
      page.drawText("…", {
      x: cursorX,
      y: textY,
      size: captionFontSize,
      font: captionFont,
      color: captionColor,
    });
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

function normalizeDb(parsed) {
  const metadata = parsed && typeof parsed.metadata === "object" && parsed.metadata ? parsed.metadata : {};
  return { metadata };
}

async function readDb(archive) {
  try {
    const raw = await fs.readFile(archive.dbFile, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch {
    return defaultDb();
  }
}

async function writeDb(archive, db) {
  await fs.writeFile(archive.dbFile, JSON.stringify(db, null, 2));
}

function normalizeSlideRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const archive = parseArchiveKey(raw.archive);
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return { archive, id };
}

function normalizeSlidesDb(parsed) {
  const slideshows = parsed && typeof parsed.slideshows === "object" && parsed.slideshows ? parsed.slideshows : {};
  const normalizedShows = {};

  for (const [id, show] of Object.entries(slideshows)) {
    if (!show || typeof show !== "object") continue;
    const slides = Array.isArray(show.slides)
      ? show.slides.map(normalizeSlideRef).filter(Boolean)
      : [];

    normalizedShows[id] = {
      name: String(show.name || "Untitled Slideshow").trim() || "Untitled Slideshow",
      slides,
    };
  }

  if (!Object.keys(normalizedShows).length) {
    normalizedShows.default = {
      name: "Current Slideshow",
      slides: [],
    };
  }

  let currentSlideshowId = String(parsed?.currentSlideshowId || "").trim();
  if (!normalizedShows[currentSlideshowId]) {
    currentSlideshowId = Object.keys(normalizedShows)[0];
  }

  return {
    slideshows: normalizedShows,
    currentSlideshowId,
  };
}

async function readSlidesDb() {
  try {
    const raw = await fs.readFile(SLIDESHOWS_FILE, "utf8");
    return normalizeSlidesDb(JSON.parse(raw));
  } catch {
    return defaultSlidesDb();
  }
}

async function writeSlidesDb(db) {
  await fs.writeFile(SLIDESHOWS_FILE, JSON.stringify(db, null, 2));
}

async function walkImages(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const rel = base ? path.posix.join(base, entry.name) : entry.name;
    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkImages(abs, rel)));
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    files.push(rel.replaceAll(path.sep, path.posix.sep));
  }

  return files;
}

async function buildState(archive) {
  const relFiles = await walkImages(archive.libraryDir);
  const db = await readDb(archive);
  const slidesDb = await readSlidesDb();
  let dbChanged = false;

  for (const relPath of relFiles) {
    const id = fileToId(relPath);
    if (!Object.prototype.hasOwnProperty.call(db.metadata, id)) {
      db.metadata[id] = defaultMetadataRecord();
      dbChanged = true;
    }

    if (archive.key === "excursions") {
      const existing = normalizeMetadataPayload(db.metadata[id]);
      const isBlank =
        !existing.title
        && !existing.artist
        && !existing.year
        && !existing.medium
        && !existing.gallery
        && !existing.size
        && (!Array.isArray(existing.tags) || !existing.tags.length);
      if (isBlank) {
        const matched = await findFieldBundleMetadataForImage(relPath);
        if (matched) {
          db.metadata[id] = {
            ...defaultMetadataRecord(),
            ...matched,
          };
          dbChanged = true;
        }
      }
    }
  }

  for (const id of Object.keys(db.metadata)) {
    const relPath = idToFile(id);
    const absPath = safeJoin(archive.libraryDir, relPath);
    if (!relPath || !absPath || !fss.existsSync(absPath)) {
      delete db.metadata[id];
      dbChanged = true;
    }
  }

  if (dbChanged) {
    await writeDb(archive, db);
  }

  const items = (await Promise.all(relFiles.map(async (relPath) => {
    try {
      const absPath = path.join(archive.libraryDir, relPath);
      const stat = await fs.stat(absPath);
      const id = fileToId(relPath);
      const meta = db.metadata[id] || {};
      const hasStoredTitle = Object.prototype.hasOwnProperty.call(meta, "title");
      const title = hasStoredTitle
        ? String(meta.title || "").trim()
        : path.basename(relPath, path.extname(relPath));
      const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim()).filter(Boolean) : [];
      const thumbUrl = await getThumbnailUrl(archive, absPath, relPath, stat.mtimeMs);

      return {
        id,
        archive: archive.key,
        relPath,
        url: `/library/${archive.key}/${encodeURIComponent(relPath).replaceAll("%2F", "/")}`,
        thumbUrl,
        title,
        artist: String(meta.artist || "").trim(),
        year: String(meta.year || "").trim(),
        medium: String(meta.medium || "").trim(),
        gallery: String(meta.gallery || "").trim(),
        size: String(meta.size || "").trim(),
        tags,
        sourceName: relPath,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  const byArchive = {
    [archive.key]: new Map(items.map((item) => [item.id, item])),
  };

  const neededArchives = new Set();
  for (const show of Object.values(slidesDb.slideshows)) {
    for (const ref of show.slides) {
      if (ref.archive !== archive.key) neededArchives.add(ref.archive);
    }
  }

  for (const key of neededArchives) {
    const other = getArchiveConfig(key);
    const otherDb = await readDb(other);
    const otherFiles = await walkImages(other.libraryDir);
    const otherItems = (await Promise.all(otherFiles.map(async (relPath) => {
      try {
        const absPath = path.join(other.libraryDir, relPath);
        const stat = await fs.stat(absPath);
        const id = fileToId(relPath);
        const meta = otherDb.metadata[id] || {};
        const hasStoredTitle = Object.prototype.hasOwnProperty.call(meta, "title");
        const title = hasStoredTitle
          ? String(meta.title || "").trim()
          : path.basename(relPath, path.extname(relPath));
        const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim()).filter(Boolean) : [];
        const thumbUrl = await getThumbnailUrl(other, absPath, relPath, stat.mtimeMs);

        return {
          id,
          relPath,
          url: `/library/${other.key}/${encodeURIComponent(relPath).replaceAll("%2F", "/")}`,
          thumbUrl,
          title,
          artist: String(meta.artist || "").trim(),
          year: String(meta.year || "").trim(),
          medium: String(meta.medium || "").trim(),
          gallery: String(meta.gallery || "").trim(),
          size: String(meta.size || "").trim(),
          tags,
          sourceName: relPath,
          mtimeMs: stat.mtimeMs,
          archive: other.key,
        };
      } catch {
        return null;
      }
    }))).filter(Boolean);
    byArchive[other.key] = new Map(otherItems.map((item) => [item.id, item]));
  }

  const slideshows = [];
  const slideItems = {};
  for (const [id, show] of Object.entries(slidesDb.slideshows)) {
    const normalizedSlides = [];
    for (const ref of show.slides) {
      const item = byArchive[ref.archive]?.get(ref.id);
      if (!item) continue;
      normalizedSlides.push(ref);
      const key = `${ref.archive}:${ref.id}`;
      if (!slideItems[key]) {
        slideItems[key] = {
          archive: ref.archive,
          id: ref.id,
          title: item.title,
          artist: item.artist,
          year: item.year,
          medium: item.medium,
          gallery: item.gallery,
          size: item.size,
          tags: item.tags || [],
          url: item.url,
          thumbUrl: item.thumbUrl,
          sourceName: item.sourceName,
        };
      }
    }
    slideshows.push({
      id,
      name: show.name,
      slides: normalizedSlides,
    });
  }

  return {
    activeArchive: archive.key,
    archives: Object.values(ARCHIVES).map((entry) => ({ key: entry.key, label: entry.label })),
    items,
    slideItems,
    slideshows,
    currentSlideshowId: slidesDb.currentSlideshowId,
    libraryPath: archive.libraryDir,
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function serveStaticFile(res, absPath, cacheControl = "no-store") {
  const ext = path.extname(absPath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".avif": "image/avif",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";

  const stream = fss.createReadStream(absPath);
  stream.on("error", () => sendText(res, 404, "Not found"));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cacheControl });
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const archive = getArchiveConfig(url.searchParams.get("archive"));

  if (url.pathname === "/api/state" && req.method === "GET") {
    const state = await buildState(archive);
    sendJson(res, 200, state);
    return true;
  }

  if (url.pathname.startsWith("/api/items/") && url.pathname.endsWith("/purge") && req.method === "POST") {
    const encoded = url.pathname.slice("/api/items/".length, -"/purge".length);
    const id = decodeURIComponent(encoded);
    const body = await parseBody(req);
    const metadataOverride = body && typeof body.metadata === "object" ? body.metadata : null;
    const result = await purgeItemFromArchiveById(archive, id, metadataOverride);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname.startsWith("/api/items/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/api/items/".length));
    const relPath = idToFile(id);
    const safePath = safeJoin(archive.libraryDir, relPath);
    if (!relPath || !safePath || !fss.existsSync(safePath)) {
      sendJson(res, 404, { error: "Item not found" });
      return true;
    }

    const body = await parseBody(req);
    const db = await readDb(archive);

    db.metadata[id] = {
      title: String(body.title || "").trim(),
      artist: String(body.artist || "").trim(),
      year: String(body.year || "").trim(),
      medium: String(body.medium || "").trim(),
      gallery: String(body.gallery || "").trim(),
      size: String(body.size || "").trim(),
      tags: Array.isArray(body.tags)
        ? body.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
    };

    await writeDb(archive, db);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/import-url/candidates" && req.method === "POST") {
    const body = await parseBody(req);
    const result = await listImportCandidatesFromUrl(body.url);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname === "/api/import-url/import" && req.method === "POST") {
    const body = await parseBody(req);
    const result = await importSelectedImageFromCandidate(archive, body);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname === "/api/slideshows" && req.method === "POST") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim() || "Untitled Slideshow";
    const db = await readSlidesDb();
    const id = makeSlideshowId();

    db.slideshows[id] = { name, slides: [] };
    db.currentSlideshowId = id;

    await writeSlidesDb(db);
    sendJson(res, 200, { ok: true, id });
    return true;
  }

  if (url.pathname === "/api/slideshows/current" && req.method === "POST") {
    const body = await parseBody(req);
    const id = String(body.id || "").trim();
    const db = await readSlidesDb();

    if (!db.slideshows[id]) {
      sendJson(res, 404, { error: "Slideshow not found" });
      return true;
    }

    db.currentSlideshowId = id;
    await writeSlidesDb(db);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname.startsWith("/api/slideshows/") && req.method === "POST") {
    const rest = decodeURIComponent(url.pathname.slice("/api/slideshows/".length));
    const [id, action] = rest.split("/");
    const db = await readSlidesDb();
    const slideshow = db.slideshows[id];

    if (!slideshow) {
      sendJson(res, 404, { error: "Slideshow not found" });
      return true;
    }

    if (action === "items") {
      const body = await parseBody(req);
      const itemId = String(body.itemId || "").trim();
      const itemArchive = parseArchiveKey(body.archive);
      const selected = Boolean(body.selected);

      if (!itemId) {
        sendJson(res, 400, { error: "itemId is required" });
        return true;
      }

      const next = slideshow.slides.filter((slideRef) => !(slideRef.id === itemId && slideRef.archive === itemArchive));
      if (selected) next.push({ archive: itemArchive, id: itemId });
      slideshow.slides = next;
      await writeSlidesDb(db);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "order") {
      const body = await parseBody(req);
      slideshow.slides = Array.isArray(body.slides) ? body.slides.map(normalizeSlideRef).filter(Boolean) : [];
      await writeSlidesDb(db);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "rename") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim() || "Untitled Slideshow";
      slideshow.name = name;
      await writeSlidesDb(db);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "delete") {
      const ids = Object.keys(db.slideshows);
      if (ids.length <= 1) {
        sendJson(res, 400, { error: "Cannot delete the only slideshow" });
        return true;
      }

      delete db.slideshows[id];
      const remainingIds = Object.keys(db.slideshows);
      if (!db.slideshows[db.currentSlideshowId]) {
        db.currentSlideshowId = remainingIds[0];
      }
      await writeSlidesDb(db);
      sendJson(res, 200, { ok: true, currentSlideshowId: db.currentSlideshowId });
      return true;
    }
  }

  if (url.pathname.startsWith("/api/slideshows/") && req.method === "GET") {
    const rest = decodeURIComponent(url.pathname.slice("/api/slideshows/".length));
    const [id, action] = rest.split("/");
    if (action === "pdf") {
      const state = await buildState(archive);
      const pdfBytes = await generateSlideshowPdf(state, id);
      const show = state.slideshows.find((slideshow) => slideshow.id === id);
      const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
      const filename = `${sanitizeFilename(show?.name || "slideshow")}.pdf`;
      sendBinary(res, 200, pdfBytes, "application/pdf", {
        "Cache-Control": "no-store",
        "Content-Disposition": `${disposition}; filename="${filename}"`,
      });
      return true;
    }
  }

  return false;
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (await handleApi(req, res, url)) return;
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Bad request" });
    return;
  }

  if (url.pathname.startsWith("/library/")) {
    const relWithArchive = decodeURIComponent(url.pathname.slice("/library/".length));
    const [archiveKey, ...parts] = relWithArchive.split("/");
    const archive = getArchiveConfig(archiveKey);
    const rel = parts.join("/");
    const abs = safeJoin(archive.libraryDir, rel);
    if (!abs || !fss.existsSync(abs)) {
      sendText(res, 404, "Not found");
      return;
    }
    serveStaticFile(res, abs);
    return;
  }

  if (url.pathname.startsWith("/thumbs/")) {
    const relWithArchive = decodeURIComponent(url.pathname.slice("/thumbs/".length));
    const [archiveKey, ...parts] = relWithArchive.split("/");
    const archive = getArchiveConfig(archiveKey);
    const rel = parts.join("/");
    const abs = safeJoin(archive.thumbsDir, rel);
    if (!abs || !fss.existsSync(abs)) {
      sendText(res, 404, "Not found");
      return;
    }
    serveStaticFile(res, abs, "public, max-age=3600");
    return;
  }

  const target = url.pathname === "/" ? "/index.html" : url.pathname;
  const abs = safeJoin(ROOT, target.replace(/^\//, ""));
  if (!abs || !fss.existsSync(abs)) {
    sendText(res, 404, "Not found");
    return;
  }

  serveStaticFile(res, abs);
}

(async () => {
  await ensureDirs();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      sendJson(res, 500, { error: err.message || "Server error" });
    });
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Slide Library running at http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Slide library folder: ${ARCHIVES.slide_library.libraryDir}`);
    // eslint-disable-next-line no-console
    console.log(`Excursions folder: ${ARCHIVES.excursions.libraryDir}`);
  });
})();
