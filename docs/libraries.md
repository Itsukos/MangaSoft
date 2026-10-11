# Libraries

MangaSoft has four sections. Each one has its own folders, set in **Settings**, and its own page in the menu.
A folder can only belong to one section.

## Manga

Add folders under **Settings, Library folders**.

```
Manga/
  One Piece/
    Chapter 001/001.jpg, 002.jpg ...    image folders
    One Piece - c002.cbz                archives
  Berserk/Vol 01/Ch 001/...             nested volumes work too
  Some Oneshot.cbz                      a loose archive is one series
```

- Supported: `.cbz`, `.zip`, and folders of images. `.cbr`, `.rar` and PDF are not supported.
- File names such as `Title - c012 (v02) - p034.png` are split into chapters and volumes automatically.
- Covers, banners, descriptions, genres, authors and scores come from AniList, with MangaDex as a backup.
  The order is configurable and each provider can be turned off.

### Volumes that are not split into chapters

Open the volume and press the scissors button, then **Auto-detect chapters**. MangaSoft runs OCR over the pages
looking for "Chapter N" title pages. It takes a couple of minutes per volume and runs in the background.
Suggestions go into a queue you confirm. You can fix numbers, nudge a start page, or add and remove starts by
tapping a page. Missing chapters are flagged. Saved splits persist.

Detection is English only for now. The OCR language data downloads once, about 5 MB.

### Fixing a wrong match

Open the series and use **Fix metadata**. Pick another AniList or MangaDex result, paste a link, or edit fields by
hand. Edited fields are marked and survive refreshes. Each field can be handed back to the provider, or you can
reset all edits.

## Anime

Add folders under **Settings, Anime section**.

```
Anime/
  Show Name/
    [Group] Show Name - 01 [1080p].mkv
    Show Name S01E02.mkv
    Season 2/Show Name S02E01.mkv       becomes its own entry
    Specials/                           joins the parent show
  Movie.mkv                             a loose file is a one-file series
```

File names like `[Group] Show - 05 [1080p].mkv`, `Show.S02E05.mkv` and `Show 5x05.mkv` are understood.
See [anime.md](anime.md) for playback details.

## Light novels

Add folders under **Settings, Light novel section**.

```
Light Novels/
  Series Name/
    Series Name - Volume 01.epub
    Series Name - Volume 02.epub
    Spin Off/
      Side Story.epub
  Standalone Novel.epub
```

- Each `.epub` is one volume. A series folder is one series, and a loose `.epub` is its own series.
- The volume number is read from the file name (`Volume 3`, `Vol. 3`, `v03`).
- Cover, title and author are read from the EPUB. Details are matched against AniList's novel entries.
- The reader has themes, fonts, size, width and line height settings, a table of contents, and remembers where you
  stopped in each volume. The theme and font choices are per device.

### Turning a PDF into an EPUB

`tools/pdf2epub.py` converts text-based PDFs into reflowable EPUBs, with chapters, illustrations and footnotes.
It needs Python with PyMuPDF and Pillow:

```
pip install pymupdf pillow
python tools/pdf2epub.py book.pdf book.epub --title "Title" --author "Author"
```

It is tuned for novel layouts with simple text pages. Scanned PDFs without a text layer are not supported.

## Doujin

Add folders under **Settings, Doujin section**. This library is kept completely apart from manga and has no
AniList tracking.

- Details come from nhentai's public API, in the background. A gallery number in the name (`#123456` or
  `[123456]`) is an exact match. Otherwise it searches by the title and artist parsed from
  `[Circle (Artist)] Title (Parody) [English]`.
- If nothing is found you still get artist, circle, parody and language from the file name.
- Browse by artist, circle, parody, language or tag.
- An optional PIN hides the section, its covers and its pages until it is entered on that device. It is a privacy
  lock for people on your network, not strong security, and restarting the server locks every device again.
- An optional nhentai API key raises the lookup limit. You do not need one.

## Rescanning

- **One series:** on its page, **Rescan files**.
- **One library folder:** Settings, the folder's own **Scan** button.
- **Everything:** **Rescan**. The server also rescans on its own now and then.
- Renamed files keep their progress and manual chapter splits. A renamed series folder keeps its id, match, edits
  and progress.
- If a library folder cannot be read (a NAS or drive that is offline), its series are left alone instead of
  being removed.
