# Slide Library

Lightweight local app for course slides:
- Drop image files into a designated folder
- Import image/page URLs directly (preview page candidates with next/prev, then import selected)
- Search/filter/sort images by metadata
- Edit labels/metadata in the GUI
- Build a slideshow and export directly to PDF (server-side generation)

## Folder-based workflow

Your designated image folders are:
- `/Users/grunskm/slide_archive/data/library`
- `/Users/grunskm/slide_archive/data/excursions_library`

Workflow:
1. Drag/copy image files into either designated folder (subfolders are supported).
2. Start the app server.
3. The library is loaded automatically when the app opens.
4. Use `Search/Filters` in the header to show/hide the left search panel when needed.
5. Use dropdown filters (Year ranges, Artist, Medium, Tag). Options update live as you choose other criteria.
6. Use the `Image Size` slider in the archive header to shrink thumbnails (max is the default current size).
7. Click `Edit` (or click a thumbnail) to open the combined large preview + metadata editor.
8. Editor fields auto-suggest existing phrases from your archive; tags are multi-value chips (add with Enter/comma or click suggestions, remove with `x`).
9. Use `Prev` / `Next` to move through images quickly while labeling (both save before moving).
10. In the archive grid, check an image to add it to the current slideshow (uncheck to remove).
11. Use the slideshow dropdown to switch decks, and the `Actions` menu to `New`, `Rename`, or `Delete` (with confirmation).
12. Drag slides in the slideshow panel to reorder; use `X` to remove.
13. Click `Preview` to open the generated PDF, or `Export PDF` to download it directly.

## Run

```bash
cd /Users/grunskm/slide_archive
npm install
npm start
```

Then open:
- [http://127.0.0.1:5173](http://127.0.0.1:5173)

## Data storage

- Image files stay on disk in:
  - `/Users/grunskm/slide_archive/data/library`
  - `/Users/grunskm/slide_archive/data/excursions_library`
- Metadata is stored per archive in:
  - `/Users/grunskm/slide_archive/data/archive.json`
  - `/Users/grunskm/slide_archive/data/excursions_archive.json`
- Global slideshow structure is stored in:
  - `/Users/grunskm/slide_archive/data/slideshows.json`
- Cached preview thumbnails are generated in `/Users/grunskm/slide_archive/data/thumbs` as new images are detected.
- Purged files are moved to:
  - `/Users/grunskm/slide_archive/data/purged`
  - `/Users/grunskm/slide_archive/data/excursions_purged`
- Purge metadata is logged in:
  - `/Users/grunskm/slide_archive/data/purged_archive.json`
  - `/Users/grunskm/slide_archive/data/excursions_purged_archive.json`

## Notes

- Supported extensions: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.svg`, `.tif`, `.tiff`, `.avif`
- Missing/deleted files are automatically excluded from slideshow state on refresh.
