const http = require("http");
const fs = require("fs/promises");
const fss = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const LIBRARY_DIR = path.join(ROOT, "library");
const PURGED_DIR = path.join(ROOT, "purged");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "archive.json");
const PURGED_DB_FILE = path.join(DATA_DIR, "purged_archive.json");
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
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

function makeSlideshowId() {
  return `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultDb() {
  return {
    metadata: {},
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
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  await fs.mkdir(PURGED_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(THUMBS_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  }
  try {
    await fs.access(PURGED_DB_FILE);
  } catch {
    await fs.writeFile(PURGED_DB_FILE, JSON.stringify(defaultPurgedDb(), null, 2));
  }
}

function thumbNameForRelPath(relPath) {
  return `${fileToId(relPath)}.jpg`;
}

async function ensureThumbnail(absSourcePath, relPath) {
  if (thumbnailJobs.has(relPath)) return;

  const job = (async () => {
    const absThumbPath = path.join(THUMBS_DIR, thumbNameForRelPath(relPath));
    try {
      await fs.mkdir(THUMBS_DIR, { recursive: true });
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

  thumbnailJobs.set(relPath, job);
  job.finally(() => {
    thumbnailJobs.delete(relPath);
  });
}

async function getThumbnailUrl(absSourcePath, relPath, sourceMtimeMs) {
  const thumbName = thumbNameForRelPath(relPath);
  const absThumbPath = path.join(THUMBS_DIR, thumbName);

  let thumbStat = null;
  try {
    thumbStat = await fs.stat(absThumbPath);
  } catch {
    thumbStat = null;
  }

  const thumbFresh = thumbStat && thumbStat.mtimeMs >= sourceMtimeMs;
  if (!thumbFresh) {
    ensureThumbnail(absSourcePath, relPath);
  }

  if (!thumbStat) return "";
  return `/thumbs/${encodeURIComponent(thumbName)}`;
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

async function readPurgedDb() {
  try {
    const raw = await fs.readFile(PURGED_DB_FILE, "utf8");
    return normalizePurgedDb(JSON.parse(raw));
  } catch {
    return defaultPurgedDb();
  }
}

async function writePurgedDb(db) {
  await fs.writeFile(PURGED_DB_FILE, JSON.stringify(db, null, 2));
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
    size: String(source.size || "").trim(),
    tags: Array.isArray(source.tags) ? source.tags.map((t) => String(t).trim()).filter(Boolean) : [],
  };
}

async function purgeItemFromArchiveById(id, metadataOverride) {
  const relPath = idToFile(id);
  const absSource = safeJoin(LIBRARY_DIR, relPath);
  if (!relPath || !absSource || !fss.existsSync(absSource)) {
    throw new Error("Item not found");
  }

  const purgedRelPath = uniqueRelPathInDir(PURGED_DIR, relPath);
  const absDest = safeJoin(PURGED_DIR, purgedRelPath);
  if (!absDest) {
    throw new Error("Could not resolve purge destination");
  }
  await fs.mkdir(path.dirname(absDest), { recursive: true });
  await moveFileSafely(absSource, absDest);

  const db = await readDb();
  const knownMeta = db.metadata[id] || {};
  const normalizedMeta = metadataOverride
    ? normalizeMetadataPayload(metadataOverride)
    : normalizeMetadataPayload(knownMeta);

  delete db.metadata[id];
  let removedFromSlides = 0;
  for (const show of Object.values(db.slideshows)) {
    const before = Array.isArray(show.slides) ? show.slides.length : 0;
    show.slides = Array.isArray(show.slides) ? show.slides.filter((slideId) => slideId !== id) : [];
    removedFromSlides += Math.max(0, before - show.slides.length);
  }
  await writeDb(db);

  const thumbPath = path.join(THUMBS_DIR, thumbNameForRelPath(relPath));
  await fs.unlink(thumbPath).catch(() => {});

  const purged = await readPurgedDb();
  purged.items.push({
    id,
    originalRelPath: relPath,
    purgedRelPath,
    purgedAt: new Date().toISOString(),
    metadata: normalizedMeta,
  });
  await writePurgedDb(purged);

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

async function downloadImageFromUrl(urlString) {
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
  const relPath = uniqueFilename(LIBRARY_DIR, named);
  const absPath = path.join(LIBRARY_DIR, relPath);
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

async function importSelectedImageFromCandidate(payload) {
  const imageUrl = parseAndValidateHttpUrl(payload?.imageUrl).toString();
  const meta = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const importResult = await downloadImageFromUrl(imageUrl);
  const fallbackTitle = sanitizeName(path.basename(importResult.relPath, path.extname(importResult.relPath)));
  const normalizedMeta = {
    title: String(meta.title || fallbackTitle).trim(),
    artist: String(meta.artist || "").trim(),
    year: String(meta.year || "").trim(),
    medium: String(meta.medium || "").trim(),
    size: String(meta.size || "").trim(),
    tags: [],
  };

  const id = fileToId(importResult.relPath);
  const db = await readDb();
  db.metadata[id] = normalizedMeta;
  await writeDb(db);
  return { itemId: id, relPath: importResult.relPath };
}

function buildSlideMetadataLine(values) {
  const artist = String(values.artist || "").trim() || "Unknown artist";
  const title = String(values.title || "").trim() || "(title unknown)";
  const year = String(values.year || "").trim();
  const size = String(values.size || "").trim();
  const medium = String(values.medium || "").trim();
  const tail = [medium, size].filter(Boolean).join(", ");
  const core = year ? `${artist}, ${title}, ${year}.` : `${artist}, ${title}.`;
  return tail ? `${core} ${tail}.` : core;
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

  const itemMap = new Map(state.items.map((item) => [item.id, item]));
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

  for (const slideId of slideshow.slides) {
    const item = itemMap.get(slideId);
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
      const absPath = safeJoin(LIBRARY_DIR, relPath);
      if (!absPath || !fss.existsSync(absPath)) {
        throw new Error("missing image");
      }
      const source = await readImageForPdf(absPath);
      image = source.format === "png" ? await pdf.embedPng(source.bytes) : await pdf.embedJpg(source.bytes);
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

  // Backward compatibility: migrate { slides: [] } into the new slideshows model.
  if (parsed && Array.isArray(parsed.slides)) {
    return {
      metadata,
      slideshows: {
        default: {
          name: "Current Slideshow",
          slides: parsed.slides.map(String),
        },
      },
      currentSlideshowId: "default",
    };
  }

  const slideshows = parsed && typeof parsed.slideshows === "object" && parsed.slideshows ? parsed.slideshows : {};
  const normalizedShows = {};

  for (const [id, show] of Object.entries(slideshows)) {
    if (!show || typeof show !== "object") continue;
    normalizedShows[id] = {
      name: String(show.name || "Untitled Slideshow").trim() || "Untitled Slideshow",
      slides: Array.isArray(show.slides) ? show.slides.map(String) : [],
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
    metadata,
    slideshows: normalizedShows,
    currentSlideshowId,
  };
}

async function readDb() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch {
    return defaultDb();
  }
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
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

async function buildState() {
  const db = await readDb();
  const relFiles = await walkImages(LIBRARY_DIR);

  const items = (await Promise.all(relFiles.map(async (relPath) => {
    try {
      const absPath = path.join(LIBRARY_DIR, relPath);
      const stat = await fs.stat(absPath);
      const id = fileToId(relPath);
      const meta = db.metadata[id] || {};
      const hasStoredTitle = Object.prototype.hasOwnProperty.call(meta, "title");
      const title = hasStoredTitle
        ? String(meta.title || "").trim()
        : path.basename(relPath, path.extname(relPath));
      const legacyGenre = String(meta.genre || "").trim();
      const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim()).filter(Boolean) : [];
      if (legacyGenre && !tags.some((t) => t.toLowerCase() === legacyGenre.toLowerCase())) {
        tags.push(legacyGenre);
      }
      const thumbUrl = await getThumbnailUrl(absPath, relPath, stat.mtimeMs);

      return {
        id,
        relPath,
        url: `/library/${encodeURIComponent(relPath).replaceAll("%2F", "/")}`,
        thumbUrl,
        title,
        artist: String(meta.artist || "").trim(),
        year: String(meta.year || "").trim(),
        medium: String(meta.medium || "").trim(),
        size: String(meta.size || "").trim(),
        tags,
        sourceName: relPath,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }))).filter(Boolean);

  const knownIds = new Set(items.map((i) => i.id));
  const slideshows = Object.entries(db.slideshows).map(([id, show]) => ({
    id,
    name: show.name,
    slides: show.slides.filter((itemId) => knownIds.has(itemId)),
  }));

  return {
    items,
    slideshows,
    currentSlideshowId: db.currentSlideshowId,
    libraryPath: LIBRARY_DIR,
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
  if (url.pathname === "/api/state" && req.method === "GET") {
    const state = await buildState();
    sendJson(res, 200, state);
    return true;
  }

  if (url.pathname.startsWith("/api/items/") && url.pathname.endsWith("/purge") && req.method === "POST") {
    const encoded = url.pathname.slice("/api/items/".length, -"/purge".length);
    const id = decodeURIComponent(encoded);
    const body = await parseBody(req);
    const metadataOverride = body && typeof body.metadata === "object" ? body.metadata : null;
    const result = await purgeItemFromArchiveById(id, metadataOverride);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname.startsWith("/api/items/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/api/items/".length));
    const relPath = idToFile(id);
    const safePath = safeJoin(LIBRARY_DIR, relPath);
    if (!relPath || !safePath || !fss.existsSync(safePath)) {
      sendJson(res, 404, { error: "Item not found" });
      return true;
    }

    const body = await parseBody(req);
    const db = await readDb();

    db.metadata[id] = {
      title: String(body.title || "").trim(),
      artist: String(body.artist || "").trim(),
      year: String(body.year || "").trim(),
      medium: String(body.medium || "").trim(),
      size: String(body.size || "").trim(),
      tags: Array.isArray(body.tags)
        ? body.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
    };

    await writeDb(db);
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
    const result = await importSelectedImageFromCandidate(body);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // Backward compatibility for older clients: import first candidate directly.
  if (url.pathname === "/api/import-url" && req.method === "POST") {
    const body = await parseBody(req);
    const listed = await listImportCandidatesFromUrl(body.url);
    if (!listed.candidates.length) {
      sendJson(res, 400, { error: "Could not find an image URL on that page" });
      return true;
    }
    const result = await importSelectedImageFromCandidate({
      imageUrl: listed.candidates[0].url,
      metadata: listed.metadata,
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname === "/api/slideshows" && req.method === "POST") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim() || "Untitled Slideshow";
    const db = await readDb();
    const id = makeSlideshowId();

    db.slideshows[id] = { name, slides: [] };
    db.currentSlideshowId = id;

    await writeDb(db);
    sendJson(res, 200, { ok: true, id });
    return true;
  }

  if (url.pathname === "/api/slideshows/current" && req.method === "POST") {
    const body = await parseBody(req);
    const id = String(body.id || "").trim();
    const db = await readDb();

    if (!db.slideshows[id]) {
      sendJson(res, 404, { error: "Slideshow not found" });
      return true;
    }

    db.currentSlideshowId = id;
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname.startsWith("/api/slideshows/") && req.method === "POST") {
    const rest = decodeURIComponent(url.pathname.slice("/api/slideshows/".length));
    const [id, action] = rest.split("/");
    const db = await readDb();
    const slideshow = db.slideshows[id];

    if (!slideshow) {
      sendJson(res, 404, { error: "Slideshow not found" });
      return true;
    }

    if (action === "items") {
      const body = await parseBody(req);
      const itemId = String(body.itemId || "").trim();
      const selected = Boolean(body.selected);

      if (!itemId) {
        sendJson(res, 400, { error: "itemId is required" });
        return true;
      }

      const next = slideshow.slides.filter((idValue) => idValue !== itemId);
      if (selected) next.push(itemId);
      slideshow.slides = next;
      await writeDb(db);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "order") {
      const body = await parseBody(req);
      slideshow.slides = Array.isArray(body.slides) ? body.slides.map(String) : [];
      await writeDb(db);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "rename") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim() || "Untitled Slideshow";
      slideshow.name = name;
      await writeDb(db);
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
      await writeDb(db);
      sendJson(res, 200, { ok: true, currentSlideshowId: db.currentSlideshowId });
      return true;
    }
  }

  if (url.pathname.startsWith("/api/slideshows/") && req.method === "GET") {
    const rest = decodeURIComponent(url.pathname.slice("/api/slideshows/".length));
    const [id, action] = rest.split("/");
    if (action === "pdf") {
      const state = await buildState();
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

  // Backward compatibility endpoint for old clients.
  if (url.pathname === "/api/slides" && req.method === "POST") {
    const body = await parseBody(req);
    const ids = Array.isArray(body.slides) ? body.slides.map(String) : [];
    const db = await readDb();
    const current = db.slideshows[db.currentSlideshowId];
    if (current) {
      current.slides = ids;
      await writeDb(db);
    }
    sendJson(res, 200, { ok: true });
    return true;
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
    const rel = decodeURIComponent(url.pathname.slice("/library/".length));
    const abs = safeJoin(LIBRARY_DIR, rel);
    if (!abs || !fss.existsSync(abs)) {
      sendText(res, 404, "Not found");
      return;
    }
    serveStaticFile(res, abs);
    return;
  }

  if (url.pathname.startsWith("/thumbs/")) {
    const rel = decodeURIComponent(url.pathname.slice("/thumbs/".length));
    const abs = safeJoin(THUMBS_DIR, rel);
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
    console.log(`Library folder: ${LIBRARY_DIR}`);
  });
})();
