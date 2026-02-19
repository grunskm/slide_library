const state = {
  items: [],
  slideshows: [],
  currentSlideshowId: "",
  libraryPath: "",
  sidebarOpen: false,
  dragSlideIndex: -1,
  splitLeft: 60,
  editorTags: [],
  editorBaselinePayload: null,
  editorSequenceIds: [],
  editorIndex: -1,
  editorScope: "archive",
  importCandidates: [],
  importCandidateIndex: -1,
  importSourceUrl: "",
  importMetadata: {},
  importCandidateDimensions: {},
  filters: {
    search: "",
    year: "",
    artist: "",
    medium: "",
    tag: "",
    sortBy: "title",
    sortDir: "asc",
  },
};
const UI_STORE_KEY = "slide_archive_ui_v1";

const dom = {
  libraryPanel: document.getElementById("library-panel"),
  archiveGrid: document.getElementById("archive-grid"),
  archiveSize: document.getElementById("archive-size"),
  archiveSizeValue: document.getElementById("archive-size-value"),
  btnImportUrl: document.getElementById("btn-import-url"),
  split: document.getElementById("split"),
  splitHandle: document.getElementById("split-handle"),
  slidesList: document.getElementById("slides-list"),
  slideshowSelect: document.getElementById("slideshow-select"),
  slideshowActionSelect: document.getElementById("slideshow-action-select"),
  search: document.getElementById("search"),
  filterYear: document.getElementById("filter-year"),
  filterArtist: document.getElementById("filter-artist"),
  filterMedium: document.getElementById("filter-medium"),
  filterTag: document.getElementById("filter-tag"),
  sortBy: document.getElementById("sort-by"),
  sortDir: document.getElementById("sort-dir"),
  clearFilters: document.getElementById("clear-filters"),
  btnToggleSidebar: document.getElementById("btn-toggle-sidebar"),
  btnPreview: document.getElementById("btn-preview"),
  btnPdf: document.getElementById("btn-pdf"),
  dialog: document.getElementById("image-dialog"),
  form: document.getElementById("image-form"),
  dialogTitle: document.getElementById("dialog-title"),
  imageId: document.getElementById("image-id"),
  titleSuggestions: document.getElementById("title-suggestions"),
  artistSuggestions: document.getElementById("artist-suggestions"),
  yearSuggestions: document.getElementById("year-suggestions"),
  mediumSuggestions: document.getElementById("medium-suggestions"),
  sizeSuggestions: document.getElementById("size-suggestions"),
  tagSuggestionsList: document.getElementById("tag-suggestions-list"),
  tagSuggestions: document.getElementById("tag-suggestions"),
  editorTags: document.getElementById("editor-tags"),
  title: document.getElementById("title"),
  editorInSlideshow: document.getElementById("editor-in-slideshow"),
  artist: document.getElementById("artist"),
  year: document.getElementById("year"),
  medium: document.getElementById("medium"),
  size: document.getElementById("size"),
  tags: document.getElementById("tags"),
  editorImage: document.getElementById("editor-image"),
  editorPreviewTitle: document.getElementById("editor-preview-title"),
  editorPreviewDetails: document.getElementById("editor-preview-details"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  importDialog: document.getElementById("import-dialog"),
  importUrlInput: document.getElementById("import-url-input"),
  btnImportLoad: document.getElementById("btn-import-load"),
  importPreviewImage: document.getElementById("import-preview-image"),
  importPreviewEmpty: document.getElementById("import-preview-empty"),
  importPreviewCaption: document.getElementById("import-preview-caption"),
  importCounter: document.getElementById("import-counter"),
  btnImportPrev: document.getElementById("btn-import-prev"),
  btnImportNext: document.getElementById("btn-import-next"),
  btnImportCancel: document.getElementById("btn-import-cancel"),
  btnImportConfirm: document.getElementById("btn-import-confirm"),
  btnPurgeItem: document.getElementById("btn-purge-item"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function norm(value) {
  return (value || "").toLowerCase();
}

function getItemById(id) {
  return state.items.find((item) => item.id === id);
}

function displayArtistName(value) {
  const clean = String(value || "").trim();
  return clean || "Unknown artist";
}

function hasActiveArchiveFilters() {
  return Boolean(state.filters.search || state.filters.year || state.filters.artist || state.filters.medium || state.filters.tag);
}

function shouldRerenderArchiveAfterMetadataSave() {
  if (hasActiveArchiveFilters()) return true;
  return ["title", "artist", "year", "medium", "tags"].includes(state.filters.sortBy);
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean)));
}

function setDatalistOptions(datalistEl, values, limit = 200) {
  const capped = values.slice(0, limit);
  datalistEl.innerHTML = capped.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function getTagVocabulary() {
  const tags = state.items.flatMap((item) => (Array.isArray(item.tags) ? item.tags : []));
  return uniqueNonEmpty(tags).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function renderEditorSuggestions() {
  const byField = (key) =>
    uniqueNonEmpty(state.items.map((item) => item[key])).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

  setDatalistOptions(dom.titleSuggestions, byField("title"), 250);
  setDatalistOptions(dom.artistSuggestions, byField("artist"), 250);
  setDatalistOptions(dom.yearSuggestions, byField("year"), 120);
  setDatalistOptions(dom.mediumSuggestions, byField("medium"), 250);
  setDatalistOptions(dom.sizeSuggestions, byField("size"), 250);
  setDatalistOptions(dom.tagSuggestionsList, getTagVocabulary(), 400);
}

function renderTagSuggestions() {
  const vocab = getTagVocabulary();
  const prefix = String(dom.tags.value || "").trim().toLowerCase();
  const committed = state.editorTags.map((t) => t.toLowerCase());

  const suggestions = vocab
    .filter((tag) => !committed.includes(tag.toLowerCase()))
    .filter((tag) => !prefix || tag.toLowerCase().includes(prefix));

  if (!suggestions.length) {
    dom.tagSuggestions.innerHTML = "";
    return;
  }

  dom.tagSuggestions.innerHTML = suggestions
    .map((tag) => `<button type="button" class="tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`)
    .join("");
}

function renderEditorTags() {
  if (!state.editorTags.length) {
    dom.editorTags.innerHTML = "";
    return;
  }

  dom.editorTags.innerHTML = state.editorTags
    .map(
      (tag) =>
        `<span class="editor-tag">${escapeHtml(tag)}<button type="button" class="editor-tag-remove" data-remove-tag="${escapeHtml(
          tag
        )}" aria-label="Remove tag">x</button></span>`
    )
    .join("");
}

function insertTagSuggestion(tag) {
  const clean = String(tag || "").trim();
  if (!clean) return;
  if (!state.editorTags.find((v) => v.toLowerCase() === clean.toLowerCase())) {
    state.editorTags.push(clean);
  }
  dom.tags.value = "";
  renderEditorTags();
  renderTagSuggestions();
}

function addTagFromInput() {
  const value = String(dom.tags.value || "").trim();
  if (!value) return;
  insertTagSuggestion(value);
}

function removeEditorTag(tag) {
  state.editorTags = state.editorTags.filter((t) => t.toLowerCase() !== String(tag || "").toLowerCase());
  renderEditorTags();
  renderTagSuggestions();
}

function getCurrentSlideshow() {
  if (!state.slideshows.length) return null;
  return state.slideshows.find((show) => show.id === state.currentSlideshowId) || state.slideshows[0];
}

function getCurrentSlides() {
  return getCurrentSlideshow()?.slides || [];
}

function setCurrentSlides(nextSlides) {
  const show = getCurrentSlideshow();
  if (!show) return;
  show.slides = nextSlides;
}

function isInCurrentSlideshow(id) {
  return getCurrentSlides().includes(id);
}

function getCurrentEditorId() {
  return state.editorSequenceIds[state.editorIndex] || "";
}

function getCurrentEditorItem() {
  const id = getCurrentEditorId();
  return getItemById(id);
}

function renderSidebarState() {
  if (dom.libraryPanel) {
    dom.libraryPanel.classList.toggle("filters-open", state.sidebarOpen);
  }
  if (dom.btnToggleSidebar) {
    dom.btnToggleSidebar.setAttribute("aria-expanded", String(state.sidebarOpen));
    dom.btnToggleSidebar.textContent = state.sidebarOpen ? "▾" : "▸";
  }
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  renderSidebarState();
}

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const size = Number(parsed.archiveSize || 170);
    applyArchiveSize(size);
    applySplitWidth(Number(parsed.splitLeft || 60));
  } catch {
    // Ignore bad UI prefs.
  }
}

function saveUiPrefs() {
  const payload = {
    archiveSize: Number(dom.archiveSize.value || 170),
    splitLeft: Number(state.splitLeft || 60),
  };
  localStorage.setItem(UI_STORE_KEY, JSON.stringify(payload));
}

function applyArchiveSize(sizeValue) {
  const clamped = Math.max(100, Math.min(170, Number(sizeValue) || 170));
  dom.archiveSize.value = String(clamped);
  dom.archiveSizeValue.textContent = String(clamped);
  document.documentElement.style.setProperty("--archive-card-min", `${clamped}px`);
}

function applySplitWidth(value) {
  const clamped = Math.max(38, Math.min(75, Number(value) || 60));
  state.splitLeft = clamped;
  document.documentElement.style.setProperty("--split-left", String(clamped));
}

function updateEditorHeadline() {
  const title = String(dom.title.value || "").trim();
  dom.dialogTitle.textContent = title || "(title unknown)";
}

function buildSlideMetadataLines(values) {
  const artist = String(values.artist || "").trim() || "Unknown artist";
  const title = String(values.title || "").trim() || "(title unknown)";
  const year = String(values.year || "").trim();
  const size = String(values.size || "").trim();
  const medium = String(values.medium || "").trim();
  const tail = [medium, size].filter(Boolean).join(", ");
  const core = year ? `${artist}, ${title}, ${year}.` : `${artist}, ${title}.`;

  return tail ? `${core} ${tail}.` : core;
}

function buildSlideMetadataHtml(values) {
  const artist = String(values.artist || "").trim() || "Unknown artist";
  const title = String(values.title || "").trim() || "(title unknown)";
  const year = String(values.year || "").trim();
  const size = String(values.size || "").trim();
  const medium = String(values.medium || "").trim();
  const tail = [medium, size].filter(Boolean).join(", ");
  const core = year
    ? `${escapeHtml(artist)},&nbsp;<em>${escapeHtml(title)}</em>, ${escapeHtml(year)}.`
    : `${escapeHtml(artist)},&nbsp;<em>${escapeHtml(title)}</em>.`;
  return tail
    ? `${core} ${escapeHtml(tail)}.`
    : core;
}

function updateEditorSlidePreviewText() {
  const metaHtml = buildSlideMetadataHtml({
    artist: dom.artist.value,
    title: dom.title.value,
    year: dom.year.value,
    size: dom.size.value,
    medium: dom.medium.value,
  });

  dom.editorPreviewTitle.innerHTML = metaHtml;
  dom.editorPreviewDetails.textContent = "";
}

function updateEditorNavButtons() {
  dom.btnPrev.disabled = state.editorIndex <= 0;
  dom.btnNext.disabled = state.editorIndex < 0;
}

function updateEditorScopeUi() {
  const hideCheckbox = state.editorScope === "slideshow";
  dom.form.classList.toggle("hide-in-slideshow", hideCheckbox);
}

function getEditorImageWrap() {
  return dom.editorImage.parentElement;
}

function showEditorImageLoading() {
  const wrap = getEditorImageWrap();
  if (wrap) wrap.classList.add("is-loading");
  dom.editorImage.classList.add("is-loading");
}

function hideEditorImageLoading() {
  const wrap = getEditorImageWrap();
  if (wrap) wrap.classList.remove("is-loading");
  dom.editorImage.classList.remove("is-loading");
}

function resetEditorImage() {
  showEditorImageLoading();
  dom.editorImage.removeAttribute("src");
  dom.editorImage.alt = "";
}

function setEditorImageSource(url, alt = "") {
  resetEditorImage();
  dom.editorImage.alt = alt;
  dom.editorImage.src = url;
}

function fillEditor(item) {
  dom.imageId.value = item.id;
  dom.title.value = item.title || "";
  updateEditorHeadline();
  dom.artist.value = item.artist || "";
  dom.year.value = item.year || "";
  dom.medium.value = item.medium || "";
  dom.size.value = item.size || "";
  state.editorTags = uniqueNonEmpty(item.tags || []);
  dom.tags.value = "";
  renderEditorTags();
  const displayTitle = String(item.title || "").trim() || "(title unknown)";
  setEditorImageSource(item.url, displayTitle);
  updateEditorSlidePreviewText();
  const show = getCurrentSlideshow();
  dom.editorInSlideshow.checked = isInCurrentSlideshow(item.id);
  dom.editorInSlideshow.disabled = !show;
  renderTagSuggestions();
  updateEditorNavButtons();
  state.editorBaselinePayload = collectEditorPayload();
}

function openEditor(itemId, sequenceIds = []) {
  const explicitIds = Array.isArray(sequenceIds) ? sequenceIds.filter((id) => !!getItemById(id)) : [];
  state.editorScope = explicitIds.length ? "slideshow" : "archive";
  updateEditorScopeUi();
  const filteredIds = filteredItems().map((item) => item.id);
  state.editorSequenceIds = explicitIds.length
    ? explicitIds
    : (filteredIds.length ? filteredIds : state.items.map((item) => item.id));
  state.editorIndex = state.editorSequenceIds.indexOf(itemId);

  if (state.editorIndex < 0) {
    state.editorSequenceIds = [itemId];
    state.editorIndex = 0;
  }

  const item = getCurrentEditorItem();
  if (!item) return;
  fillEditor(item);
  dom.dialog.showModal();
}

function setEditorIndex(nextIndex) {
  if (nextIndex < 0 || nextIndex >= state.editorSequenceIds.length) return;
  state.editorIndex = nextIndex;
  const item = getCurrentEditorItem();
  if (item) fillEditor(item);
}

async function goToPrevInEditor() {
  const ok = await saveCurrentMetadata({ mode: "editor-nav" });
  if (!ok) return;
  setEditorIndex(state.editorIndex - 1);
}

async function goToNextInEditor() {
  const ok = await saveCurrentMetadata({ mode: "editor-nav" });
  if (!ok) return;
  if (state.editorIndex >= state.editorSequenceIds.length - 1) {
    dom.dialog.close();
    return;
  }
  setEditorIndex(state.editorIndex + 1);
}

async function closeEditorWithSave() {
  if (!getCurrentEditorItem()) {
    dom.dialog.close();
    return true;
  }
  const ok = await saveCurrentMetadata({ mode: "light" });
  if (!ok) return false;
  dom.dialog.close();
  return true;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function loadState() {
  const payload = await api("/api/state", { method: "GET" });
  state.items = Array.isArray(payload.items) ? payload.items : [];
  state.slideshows = Array.isArray(payload.slideshows) ? payload.slideshows : [];
  state.currentSlideshowId = String(payload.currentSlideshowId || "");
  if (!state.currentSlideshowId && state.slideshows.length) {
    state.currentSlideshowId = state.slideshows[0].id;
  }
  state.libraryPath = String(payload.libraryPath || "");
}

function filteredItems() {
  const filtered = state.items.filter((item) => itemMatchesFilters(item));

  const { sortBy, sortDir } = state.filters;
  filtered.sort((a, b) => {
    const av = norm(a[sortBy]);
    const bv = norm(b[sortBy]);

    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return filtered;
}

function itemMatchesFilters(item, ignoreKey = "") {
  const { search, year, artist, medium, tag } = state.filters;

  const blob = [
    item.title,
    item.artist,
    item.year,
    item.medium,
    item.size,
    item.sourceName,
    ...(item.tags || []),
  ]
    .join(" ")
    .toLowerCase();

  if (search && !blob.includes(norm(search))) return false;
  if (ignoreKey !== "year" && !yearInSelectedRange(item.year, year)) return false;
  if (ignoreKey !== "artist" && artist && norm(item.artist) !== norm(artist)) return false;
  if (ignoreKey !== "medium" && medium && norm(item.medium) !== norm(medium)) return false;
  if (ignoreKey !== "tag" && tag) {
    const hasTag = (item.tags || []).some((t) => norm(t) === norm(tag));
    if (!hasTag) return false;
  }

  return true;
}

function uniqueSortedValues(items, key) {
  const values = Array.from(
    new Set(
      items
        .map((item) => String(item[key] || "").trim())
        .filter(Boolean)
    )
  );

  if (key === "year") {
    values.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b, undefined, { numeric: true }));
    return values;
  }

  values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return values;
}

function extractYear(value) {
  const text = String(value || "");
  const match = text.match(/(?:1[0-9]{3}|20[0-9]{2})/);
  return match ? Number(match[0]) : null;
}

function yearInSelectedRange(itemYearValue, yearFilterValue) {
  if (!yearFilterValue) return true;
  const year = extractYear(itemYearValue);
  if (!Number.isFinite(year)) return false;

  if (yearFilterValue === "1700-1799") return year >= 1700 && year <= 1799;
  if (yearFilterValue === "1800-1899") return year >= 1800 && year <= 1899;
  if (yearFilterValue === "1900-1999") return year >= 1900 && year <= 1999;
  if (yearFilterValue === "2000-now") return year >= 2000;
  return true;
}

function fillFacetSelect(selectEl, values, currentValue, anyLabel) {
  const current = String(currentValue || "");
  const options = [`<option value="">${anyLabel}</option>`];

  values.forEach((value) => {
    const selected = current === value ? " selected" : "";
    options.push(`<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`);
  });

  selectEl.innerHTML = options.join("");
}

function renderFacetOptions() {
  const artistPool = state.items.filter((item) => itemMatchesFilters(item, "artist"));
  const mediumPool = state.items.filter((item) => itemMatchesFilters(item, "medium"));
  const tagPool = state.items.filter((item) => itemMatchesFilters(item, "tag"));

  const artistValues = uniqueSortedValues(artistPool, "artist");
  const mediumValues = uniqueSortedValues(mediumPool, "medium");
  const tagValues = uniqueNonEmpty(tagPool.flatMap((item) => item.tags || [])).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  dom.filterYear.value = state.filters.year || "";
  fillFacetSelect(dom.filterArtist, artistValues, state.filters.artist, "Artist");
  fillFacetSelect(dom.filterMedium, mediumValues, state.filters.medium, "Medium");
  fillFacetSelect(dom.filterTag, tagValues, state.filters.tag, "Tag");
}

function renderArchive() {
  const items = filteredItems();

  if (!items.length) {
    dom.archiveGrid.innerHTML = '<p class="muted">No matching images. Add files into the library folder and reopen the app to rescan.</p>';
    return;
  }

  dom.archiveGrid.innerHTML = items
    .map(
      (item) => {
        const displayTitle = String(item.title || "").trim() || "(title unknown)";
        return `
    <article class="archive-card ${isInCurrentSlideshow(item.id) ? "selected" : ""}" data-action="edit" data-id="${item.id}">
      <input class="archive-check" type="checkbox" data-action="toggle-select" data-id="${item.id}" ${isInCurrentSlideshow(item.id) ? "checked" : ""} />
      <img class="archive-thumb" src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(displayTitle)}" loading="lazy" />
      <div class="archive-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</div>
      <div class="archive-meta">${escapeHtml(displayArtistName(item.artist))}</div>
    </article>
  `;
      }
    )
    .join("");
}

function syncArchiveSelectionUI() {
  const cards = dom.archiveGrid.querySelectorAll(".archive-card[data-id]");
  cards.forEach((card) => {
    const id = card.dataset.id;
    const selected = isInCurrentSlideshow(id);
    card.classList.toggle("selected", selected);
    const checkbox = card.querySelector(".archive-check");
    if (checkbox) checkbox.checked = selected;
  });
}

function findArchiveCardById(itemId) {
  return Array.from(dom.archiveGrid.querySelectorAll(".archive-card[data-id]")).find((card) => card.dataset.id === itemId) || null;
}

function updateArchiveCardForItem(itemId) {
  const card = findArchiveCardById(itemId);
  if (!card) return false;
  const item = getItemById(itemId);
  if (!item) return false;

  const displayTitle = String(item.title || "").trim() || "(title unknown)";
  const titleEl = card.querySelector(".archive-title");
  if (titleEl) {
    titleEl.textContent = displayTitle;
    titleEl.title = displayTitle;
  }

  const thumbEl = card.querySelector(".archive-thumb");
  if (thumbEl) {
    thumbEl.alt = displayTitle;
  }

  const metaEl = card.querySelector(".archive-meta");
  if (metaEl) {
    metaEl.textContent = displayArtistName(item.artist);
  }
  return true;
}

function renderSlideshowControls() {
  dom.slideshowSelect.innerHTML = state.slideshows
    .map((show) => `<option value="${escapeHtml(show.id)}">${escapeHtml(show.name)}</option>`)
    .join("");

  if (state.currentSlideshowId) {
    dom.slideshowSelect.value = state.currentSlideshowId;
  }
}

function renderSlides() {
  const slides = getCurrentSlides();

  if (!slides.length) {
    dom.slidesList.innerHTML = '<li class="muted">No slides yet. Select images using checkboxes in the archive grid.</li>';
    return;
  }

  dom.slidesList.innerHTML = slides
    .map((id, idx) => {
      const item = getItemById(id);
      if (!item) return "";
      const displayTitle = String(item.title || "").trim() || "(title unknown)";

      return `
      <li class="slide-item" draggable="true" data-slide-index="${idx}">
        <img class="preview preview-click" src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(displayTitle)}" data-action="edit" data-id="${item.id}" />
        <div>
          <div class="title">${idx + 1}. ${escapeHtml(displayTitle)}</div>
          <div class="meta">${escapeHtml(displayArtistName(item.artist))}</div>
        </div>
        <button data-action="remove-slide" data-index="${idx}" class="slide-remove" aria-label="Remove slide">X</button>
      </li>
    `;
    })
    .join("");
}

function render() {
  renderEditorSuggestions();
  renderFacetOptions();
  renderSlideshowControls();
  renderArchive();
  renderSlides();
}

function collectEditorPayload() {
  return {
    title: dom.title.value.trim(),
    artist: dom.artist.value.trim(),
    year: dom.year.value.trim(),
    medium: dom.medium.value.trim(),
    size: dom.size.value.trim(),
    tags: [...state.editorTags],
  };
}

function payloadsEqual(a, b) {
  if (!a || !b) return false;
  if (a.title !== b.title) return false;
  if (a.artist !== b.artist) return false;
  if (a.year !== b.year) return false;
  if (a.medium !== b.medium) return false;
  if (a.size !== b.size) return false;
  const tagsA = Array.isArray(a.tags) ? a.tags : [];
  const tagsB = Array.isArray(b.tags) ? b.tags : [];
  if (tagsA.length !== tagsB.length) return false;
  for (let i = 0; i < tagsA.length; i += 1) {
    if (tagsA[i] !== tagsB[i]) return false;
  }
  return true;
}

async function saveCurrentMetadata(options = {}) {
  const id = getCurrentEditorId();
  if (!id) return true;
  const mode = options.mode || "light";

  const payload = collectEditorPayload();
  if (payloadsEqual(payload, state.editorBaselinePayload)) {
    return true;
  }

  await api(`/api/items/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const item = getItemById(id);
  if (item) {
    item.title = payload.title;
    item.artist = payload.artist;
    item.year = payload.year;
    item.medium = payload.medium;
    item.size = payload.size;
    item.tags = payload.tags;
  }
  state.editorBaselinePayload = { ...payload, tags: [...payload.tags] };

  if (mode === "editor-nav" || mode === "light") {
    renderEditorSuggestions();
    renderFacetOptions();
    const updatedCard = updateArchiveCardForItem(id);
    if (!updatedCard || shouldRerenderArchiveAfterMetadataSave()) {
      renderArchive();
    }
    renderSlides();
  } else {
    render();
    const current = getCurrentEditorItem();
    if (current) fillEditor(current);
  }
  return true;
}

async function saveCurrentSlideshowOrder(slides) {
  const show = getCurrentSlideshow();
  if (!show) return;

  await api(`/api/slideshows/${encodeURIComponent(show.id)}/order`, {
    method: "POST",
    body: JSON.stringify({ slides }),
  });

  setCurrentSlides(slides);
}

async function toggleItemInCurrentSlideshow(itemId, selected) {
  const show = getCurrentSlideshow();
  if (!show) return;

  await api(`/api/slideshows/${encodeURIComponent(show.id)}/items`, {
    method: "POST",
    body: JSON.stringify({ itemId, selected }),
  });

  const next = show.slides.filter((id) => id !== itemId);
  if (selected) next.push(itemId);
  show.slides = next;
}

async function setCurrentSlideshow(id) {
  await api("/api/slideshows/current", {
    method: "POST",
    body: JSON.stringify({ id }),
  });

  state.currentSlideshowId = id;
}

async function createSlideshow(name) {
  const payload = await api("/api/slideshows", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  state.currentSlideshowId = String(payload?.id || state.currentSlideshowId);
  await refreshFromDisk();
}

async function deleteCurrentSlideshow() {
  const show = getCurrentSlideshow();
  if (!show) return;
  if (state.slideshows.length <= 1) {
    alert("You need at least one slideshow.");
    return;
  }

  await api(`/api/slideshows/${encodeURIComponent(show.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  await refreshFromDisk();
}

async function renameCurrentSlideshow(name) {
  const show = getCurrentSlideshow();
  if (!show) return;
  const nextName = String(name || "").trim();
  if (!nextName) return;

  await api(`/api/slideshows/${encodeURIComponent(show.id)}/rename`, {
    method: "POST",
    body: JSON.stringify({ name: nextName }),
  });

  await refreshFromDisk();
}

async function removeSlide(index) {
  const slides = [...getCurrentSlides()];
  slides.splice(index, 1);
  await saveCurrentSlideshowOrder(slides);
  renderSlides();
  syncArchiveSelectionUI();
}

async function reorderSlides(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const slides = [...getCurrentSlides()];
  if (fromIndex < 0 || fromIndex >= slides.length || toIndex < 0 || toIndex > slides.length) return;
  const [moved] = slides.splice(fromIndex, 1);
  const adjustedTo = fromIndex < toIndex ? toIndex - 1 : toIndex;
  if (adjustedTo === fromIndex) return;
  slides.splice(adjustedTo, 0, moved);
  await saveCurrentSlideshowOrder(slides);
  renderSlides();
}

function clearDropMarkers() {
  dom.slidesList.querySelectorAll(".slide-item").forEach((el) => {
    el.classList.remove("drop-before");
    el.classList.remove("drop-after");
    delete el.dataset.dropPos;
  });
}

function openPdfExport(download = false) {
  const show = getCurrentSlideshow();
  if (!show || !show.slides.length) {
    alert("No slides in slideshow.");
    return;
  }

  const disposition = download ? "attachment" : "inline";
  const url = `/api/slideshows/${encodeURIComponent(show.id)}/pdf?disposition=${disposition}&_=${Date.now()}`;

  if (download) {
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }

  window.open(url, "_blank", "noopener");
}

async function refreshFromDisk() {
  await loadState();
  render();
}

function resetImportState() {
  state.importCandidates = [];
  state.importCandidateIndex = -1;
  state.importSourceUrl = "";
  state.importMetadata = {};
  state.importCandidateDimensions = {};
  dom.importPreviewImage.removeAttribute("src");
  dom.importPreviewImage.style.display = "none";
  dom.importPreviewEmpty.style.display = "block";
  dom.importPreviewCaption.textContent = "";
  dom.importCounter.textContent = "0 / 0";
  dom.btnImportPrev.disabled = true;
  dom.btnImportNext.disabled = true;
  dom.btnImportConfirm.disabled = true;
}

function currentImportCandidate() {
  if (state.importCandidateIndex < 0) return null;
  return state.importCandidates[state.importCandidateIndex] || null;
}

function updateImportPreviewCaption() {
  const current = currentImportCandidate();
  if (!current) {
    dom.importPreviewCaption.textContent = "";
    return;
  }

  const meta = state.importMetadata || {};
  const title = String(meta.title || "").trim();
  const artist = String(meta.artist || "").trim();
  const year = String(meta.year || "").trim();
  const medium = String(meta.medium || "").trim();
  const size = String(meta.size || "").trim();
  const metadataBits = [title, artist, year, medium, size].filter(Boolean).join(" | ");
  const label = String(current.label || "").trim();
  const dims = state.importCandidateDimensions[current.url];
  const dimsText = dims ? `${dims.width} x ${dims.height} px` : "";
  dom.importPreviewCaption.textContent = [label, dimsText, metadataBits].filter(Boolean).join("  -  ");
}

function renderImportCandidate() {
  const total = state.importCandidates.length;
  const current = currentImportCandidate();
  if (!current) {
    dom.importPreviewImage.removeAttribute("src");
    dom.importPreviewImage.style.display = "none";
    dom.importPreviewEmpty.style.display = "block";
    dom.importPreviewCaption.textContent = "";
    dom.importCounter.textContent = "0 / 0";
    dom.btnImportPrev.disabled = true;
    dom.btnImportNext.disabled = true;
    dom.btnImportConfirm.disabled = true;
    return;
  }

  dom.importPreviewImage.src = current.url;
  dom.importPreviewImage.alt = current.label || "Import candidate";
  dom.importPreviewImage.style.display = "block";
  dom.importPreviewEmpty.style.display = "none";
  dom.importCounter.textContent = `${state.importCandidateIndex + 1} / ${total}`;
  dom.btnImportPrev.disabled = total <= 1;
  dom.btnImportNext.disabled = total <= 1;
  dom.btnImportConfirm.disabled = false;
  updateImportPreviewCaption();
}

function stepImportCandidate(delta) {
  const total = state.importCandidates.length;
  if (!total) return;
  const next = (state.importCandidateIndex + delta + total) % total;
  state.importCandidateIndex = next;
  renderImportCandidate();
}

function openImportDialog() {
  resetImportState();
  dom.importUrlInput.value = "";
  dom.importDialog.showModal();
  dom.importUrlInput.focus();
}

async function loadImportCandidates() {
  const sourceUrl = String(dom.importUrlInput.value || "").trim();
  if (!sourceUrl) {
    alert("Enter a URL first.");
    return;
  }

  dom.btnImportLoad.disabled = true;
  const oldLabel = dom.btnImportLoad.textContent;
  dom.btnImportLoad.textContent = "Loading...";
  try {
    const result = await api("/api/import-url/candidates", {
      method: "POST",
      body: JSON.stringify({ url: sourceUrl }),
    });
    state.importSourceUrl = String(result?.sourceUrl || sourceUrl);
    state.importMetadata = result?.metadata || {};
    state.importCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
    state.importCandidateIndex = state.importCandidates.length ? 0 : -1;
    if (!state.importCandidates.length) {
      alert("No importable images were found on that page.");
    }
    renderImportCandidate();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    dom.btnImportLoad.textContent = oldLabel;
    dom.btnImportLoad.disabled = false;
  }
}

async function confirmImportCandidate() {
  const candidate = currentImportCandidate();
  if (!candidate) return;

  dom.btnImportConfirm.disabled = true;
  const oldLabel = dom.btnImportConfirm.textContent;
  dom.btnImportConfirm.textContent = "Importing...";
  try {
    const result = await api("/api/import-url/import", {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: state.importSourceUrl,
        imageUrl: candidate.url,
        metadata: state.importMetadata || {},
      }),
    });
    dom.importDialog.close();
    await refreshFromDisk();
    const itemId = String(result?.itemId || "");
    if (itemId) {
      openEditor(itemId);
    }
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    dom.btnImportConfirm.textContent = oldLabel;
    dom.btnImportConfirm.disabled = false;
  }
}

async function purgeCurrentItemFromArchive() {
  const id = getCurrentEditorId();
  const item = getCurrentEditorItem();
  if (!id || !item) return;
  const priorSequence = [...state.editorSequenceIds];
  const priorIndex = state.editorIndex;

  const displayTitle = String(item.title || "").trim() || "(title unknown)";
  const ok = confirm(`Purge this item from the active archive?\n\n${displayTitle}\n\nThis moves the file into the purged folder.`);
  if (!ok) return;

  dom.btnPurgeItem.disabled = true;
  const oldLabel = dom.btnPurgeItem.textContent;
  dom.btnPurgeItem.textContent = "Purging...";
  try {
    await api(`/api/items/${encodeURIComponent(id)}/purge`, {
      method: "POST",
      body: JSON.stringify({ metadata: collectEditorPayload() }),
    });
    await refreshFromDisk();

    const nextSequence = priorSequence.filter((seqId) => seqId !== id && !!getItemById(seqId));
    if (!nextSequence.length) {
      state.editorSequenceIds = [];
      state.editorIndex = -1;
      dom.dialog.close();
      return;
    }

    state.editorSequenceIds = nextSequence;
    state.editorIndex = Math.max(0, Math.min(priorIndex, nextSequence.length - 1));
    const nextItem = getCurrentEditorItem();
    if (nextItem) {
      fillEditor(nextItem);
    } else {
      dom.dialog.close();
    }
  } catch (err) {
    alert(`Purge failed: ${err.message}`);
  } finally {
    dom.btnPurgeItem.textContent = oldLabel;
    dom.btnPurgeItem.disabled = false;
  }
}

function attachEvents() {
  renderSidebarState();
  loadUiPrefs();
  resetEditorImage();

  dom.form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCurrentMetadata({ mode: "light" }).catch((err) => {
      alert(`Save failed: ${err.message}`);
    });
  });

  dom.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditorWithSave().catch((err) => {
      alert(`Save failed: ${err.message}`);
    });
  });

  dom.dialog.addEventListener("click", (event) => {
    if (event.target !== dom.dialog) return;
    closeEditorWithSave().catch((err) => {
      alert(`Save failed: ${err.message}`);
    });
  });

  dom.dialog.addEventListener("close", () => {
    resetEditorImage();
  });

  dom.editorImage.addEventListener("load", () => {
    hideEditorImageLoading();
  });

  dom.editorImage.addEventListener("error", () => {
    resetEditorImage();
  });

  dom.btnPrev.addEventListener("click", async () => {
    try {
      await goToPrevInEditor();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  });

  dom.btnNext.addEventListener("click", async () => {
    try {
      await goToNextInEditor();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  });

  dom.tags.addEventListener("input", () => {
    renderTagSuggestions();
  });

  dom.title.addEventListener("input", () => {
    updateEditorHeadline();
    updateEditorSlidePreviewText();
  });

  dom.artist.addEventListener("input", () => {
    updateEditorSlidePreviewText();
  });

  dom.medium.addEventListener("input", () => {
    updateEditorSlidePreviewText();
  });

  dom.year.addEventListener("input", () => {
    updateEditorSlidePreviewText();
  });

  dom.size.addEventListener("input", () => {
    updateEditorSlidePreviewText();
  });

  dom.tags.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTagFromInput();
      return;
    }
    if (event.key === "Backspace" && !dom.tags.value.trim() && state.editorTags.length) {
      removeEditorTag(state.editorTags[state.editorTags.length - 1]);
    }
  });

  dom.tags.addEventListener("blur", () => {
    addTagFromInput();
  });

  dom.tagSuggestions.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-tag]");
    if (!chip) return;
    insertTagSuggestion(chip.dataset.tag);
  });

  dom.editorTags.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove-tag]");
    if (!btn) return;
    removeEditorTag(btn.dataset.removeTag);
  });

  document.addEventListener("keydown", (event) => {
    if (dom.importDialog.open) {
      const key = event.key.toLowerCase();
      if (key === "arrowleft") {
        event.preventDefault();
        stepImportCandidate(-1);
        return;
      }
      if (key === "arrowright") {
        event.preventDefault();
        stepImportCandidate(1);
        return;
      }
    }

    if (!dom.dialog.open) return;

    const tag = String(event.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return;
    }

    const key = event.key.toLowerCase();
    const code = String(event.code || "");
    const isPurgeKey = key === "delete" || key === "backspace" || code === "Delete" || code === "Backspace";
    if (isPurgeKey) {
      event.preventDefault();
      purgeCurrentItemFromArchive().catch((err) => {
        alert(`Purge failed: ${err.message}`);
      });
      return;
    }

    const isPrev = key === "arrowleft" || key === "a" || key === "w";
    const isNext = key === "arrowright" || key === "d" || key === "s";
    if (!isPrev && !isNext) return;

    event.preventDefault();
    const run = isPrev ? goToPrevInEditor : goToNextInEditor;
    run().catch((err) => {
      alert(`Save failed: ${err.message}`);
    });
  });

  dom.editorInSlideshow.addEventListener("change", () => {
    const itemId = getCurrentEditorId();
    if (!itemId) return;

    const selected = dom.editorInSlideshow.checked;
    toggleItemInCurrentSlideshow(itemId, selected)
      .then(() => {
        syncArchiveSelectionUI();
        renderSlides();
        const current = getCurrentEditorItem();
        if (current) fillEditor(current);
      })
      .catch((err) => {
        dom.editorInSlideshow.checked = !selected;
        alert(`Slideshow update failed: ${err.message}`);
      });
  });

  dom.search.addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderArchive();
  });

  dom.filterYear.addEventListener("change", (e) => {
    state.filters.year = e.target.value;
    render();
  });

  dom.filterArtist.addEventListener("change", (e) => {
    state.filters.artist = e.target.value;
    render();
  });

  dom.filterMedium.addEventListener("change", (e) => {
    state.filters.medium = e.target.value;
    render();
  });

  dom.filterTag.addEventListener("change", (e) => {
    state.filters.tag = e.target.value;
    render();
  });

  dom.sortBy.addEventListener("change", (e) => {
    state.filters.sortBy = e.target.value;
    renderArchive();
  });

  dom.sortDir.addEventListener("change", (e) => {
    state.filters.sortDir = e.target.value;
    renderArchive();
  });

  dom.clearFilters.addEventListener("click", () => {
    state.filters.search = "";
    state.filters.year = "";
    state.filters.artist = "";
    state.filters.medium = "";
    state.filters.tag = "";
    dom.search.value = "";
    render();
  });

  dom.btnToggleSidebar.addEventListener("click", () => {
    toggleSidebar();
  });

  dom.archiveSize.addEventListener("input", (event) => {
    applyArchiveSize(event.target.value);
    saveUiPrefs();
  });

  dom.btnImportUrl.addEventListener("click", () => {
    openImportDialog();
  });

  dom.importDialog.addEventListener("cancel", () => {
    resetImportState();
  });

  dom.importDialog.addEventListener("close", () => {
    resetImportState();
  });

  dom.btnImportLoad.addEventListener("click", () => {
    loadImportCandidates().catch((err) => {
      alert(`Import failed: ${err.message}`);
    });
  });

  dom.importUrlInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadImportCandidates().catch((err) => {
      alert(`Import failed: ${err.message}`);
    });
  });

  dom.btnImportPrev.addEventListener("click", () => stepImportCandidate(-1));
  dom.btnImportNext.addEventListener("click", () => stepImportCandidate(1));

  dom.btnImportCancel.addEventListener("click", () => {
    dom.importDialog.close();
    resetImportState();
  });

  dom.importPreviewImage.addEventListener("load", () => {
    const current = currentImportCandidate();
    if (!current) return;
    const width = Number(dom.importPreviewImage.naturalWidth || 0);
    const height = Number(dom.importPreviewImage.naturalHeight || 0);
    if (width > 0 && height > 0) {
      state.importCandidateDimensions[current.url] = { width, height };
    }
    updateImportPreviewCaption();
  });

  dom.importPreviewImage.addEventListener("error", () => {
    updateImportPreviewCaption();
  });

  dom.btnImportConfirm.addEventListener("click", () => {
    confirmImportCandidate().catch((err) => {
      alert(`Import failed: ${err.message}`);
    });
  });

  dom.btnPurgeItem.addEventListener("click", () => {
    purgeCurrentItemFromArchive().catch((err) => {
      alert(`Purge failed: ${err.message}`);
    });
  });

  dom.splitHandle.addEventListener("mousedown", (event) => {
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    document.body.classList.add("split-resizing");

    const onMove = (moveEvent) => {
      const rect = dom.split.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      applySplitWidth(pct);
    };

    const onUp = () => {
      document.body.classList.remove("split-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveUiPrefs();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  dom.archiveGrid.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    if (target.dataset.action === "toggle-select") return;

    if (target.dataset.action === "edit") {
      openEditor(target.dataset.id);
    }
  });

  dom.archiveGrid.addEventListener("change", (event) => {
    const target = event.target.closest("[data-action='toggle-select']");
    if (!target) return;

    const id = target.dataset.id;
    const selected = target.checked;

    toggleItemInCurrentSlideshow(id, selected)
      .then(() => {
        syncArchiveSelectionUI();
        renderSlides();
      })
      .catch((err) => {
        target.checked = !selected;
        alert(`Slideshow update failed: ${err.message}`);
      });
  });

  dom.slidesList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;
    if (action === "edit") {
      openEditor(target.dataset.id, getCurrentSlides());
      return;
    }

    const index = Number(target.dataset.index);
    const run = async () => {
      if (action === "remove-slide") await removeSlide(index);
    };

    run().catch((err) => alert(`Slide update failed: ${err.message}`));
  });

  dom.slidesList.addEventListener("dragstart", (event) => {
    const slide = event.target.closest(".slide-item");
    if (!slide) return;
    state.dragSlideIndex = Number(slide.dataset.slideIndex);
    slide.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(state.dragSlideIndex));
    }
  });

  dom.slidesList.addEventListener("dragover", (event) => {
    const slide = event.target.closest(".slide-item");
    if (!slide) {
      clearDropMarkers();
      return;
    }
    event.preventDefault();
    clearDropMarkers();

    const rect = slide.getBoundingClientRect();
    const isBefore = event.clientY < rect.top + rect.height / 2;
    if (isBefore) {
      slide.classList.add("drop-before");
      slide.dataset.dropPos = "before";
    } else {
      slide.classList.add("drop-after");
      slide.dataset.dropPos = "after";
    }
  });

  dom.slidesList.addEventListener("dragleave", (event) => {
    const slide = event.target.closest(".slide-item");
    if (!slide) return;
    if (!slide.contains(event.relatedTarget)) {
      slide.classList.remove("drop-before");
      slide.classList.remove("drop-after");
      delete slide.dataset.dropPos;
    }
  });

  dom.slidesList.addEventListener("drop", (event) => {
    const slide = event.target.closest(".slide-item");
    if (!slide) return;
    event.preventDefault();
    const slideIndex = Number(slide.dataset.slideIndex);
    const toIndex = (slide.dataset.dropPos === "after" ? slideIndex + 1 : slideIndex);
    const fromIndex = state.dragSlideIndex;
    state.dragSlideIndex = -1;
    clearDropMarkers();
    reorderSlides(fromIndex, toIndex).catch((err) => alert(`Slide reorder failed: ${err.message}`));
  });

  dom.slidesList.addEventListener("dragend", () => {
    state.dragSlideIndex = -1;
    dom.slidesList.querySelectorAll(".slide-item").forEach((el) => el.classList.remove("dragging"));
    clearDropMarkers();
  });

  dom.slideshowSelect.addEventListener("change", (event) => {
    const id = event.target.value;
    setCurrentSlideshow(id)
      .then(() => refreshFromDisk())
      .catch((err) => alert(`Could not switch slideshow: ${err.message}`));
  });

  dom.slideshowActionSelect.addEventListener("change", (event) => {
    const action = event.target.value;
    event.target.value = "";

    if (!action) return;

    if (action === "new") {
      const name = prompt("Name for new slideshow:", "New Slideshow");
      if (name === null) return;
      createSlideshow(name).catch((err) => alert(`Could not create slideshow: ${err.message}`));
      return;
    }

    if (action === "rename") {
      const show = getCurrentSlideshow();
      if (!show) return;
      const name = prompt("Rename slideshow:", show.name || "Untitled Slideshow");
      if (name === null) return;
      renameCurrentSlideshow(name).catch((err) => alert(`Could not rename slideshow: ${err.message}`));
      return;
    }

    if (action === "delete") {
      const show = getCurrentSlideshow();
      if (!show) return;
      const ok = confirm(`Delete slideshow \"${show.name}\"? This cannot be undone.`);
      if (!ok) return;
      deleteCurrentSlideshow().catch((err) => alert(`Could not delete slideshow: ${err.message}`));
    }
  });

  dom.btnPreview.addEventListener("click", () => openPdfExport(false));
  dom.btnPdf.addEventListener("click", () => openPdfExport(true));
}

async function bootstrap() {
  attachEvents();
  await refreshFromDisk();
}

bootstrap().catch((err) => {
  alert(`Startup failed: ${err.message}`);
});
