#!/usr/bin/env python
"""Turn a text-based PDF novel into a reflowable EPUB (PyMuPDF + Pillow).

  python tools/pdf2epub.py in.pdf out.epub --title "Book title" --author "Name" [--illustrator "Name"] [--series "Series"] [--lang en]

What it does
  * re-joins hard-wrapped lines into paragraphs (by vertical spacing), merges paragraphs split across pages
  * keeps italics/bold, turns superscript markers + page-bottom notes into real footnotes
  * splits chapters (pages that only say "Chapter N", "Prologue", "Epilogue", "Afterword", ...) into their own files + a table of contents
  * pages with pictures: each picture is rendered as an image, in reading order
  * cover = first page
Run it only on files you own.
"""
import argparse, io, re, sys, uuid, zipfile, html
import pymupdf
from PIL import Image

HEAD_RE = re.compile(r'^(chapter\s+\d+|prologue|epilogue|afterword|interlude|intermission|postscript|foreword|introduction)\b.{0,40}$', re.I)
END_PUNCT = tuple('.!?…”"’\'）)」』─—-~。！？♪♡')
BODY_MIN, FOOT_MAX_SIZE, SUP_MAX_SIZE = 10.8, 10.6, 8.5


def esc(s):
    return html.escape(s, quote=False)


def tidy(s):
    s = re.sub(r'─+', '—', s)           # box-drawing dashes -> em dash
    s = re.sub(r'\.{3}', '…', s)         # ... -> …
    s = s.replace(' ', ' ')
    return re.sub(r'[ \t]{2,}', ' ', s)


def span_html(text, flags, font):
    t = esc(tidy(text))
    if not t.strip():
        return t
    bold = bool(flags & 16) or 'bold' in font.lower()
    ital = bool(flags & 2) or 'italic' in font.lower() or 'oblique' in font.lower()
    if ital: t = f'<i>{t}</i>'
    if bold: t = f'<b>{t}</b>'
    return t


def merge_tags(s):
    # </i><i> and </b><b> produced by adjacent spans
    prev = None
    while prev != s:
        prev = s
        s = s.replace('</i><i>', '').replace('</b><b>', '').replace('</i> <i>', ' ').replace('</b> <b>', ' ')
    return s


class Book:
    def __init__(self):
        self.images = []        # (name, bytes)
        self.chapters = []      # dict(title, body[list of html], notes[list of html], front)
        self.note_id = 0

    def add_image(self, data):
        name = f'img{len(self.images) + 1:04d}.jpg'
        self.images.append((name, data))
        return name


def render_clip(page, rect, dpi=170, max_w=1500):
    pix = page.get_pixmap(clip=rect, dpi=dpi, alpha=False)
    im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=86, optimize=True)
    return out.getvalue(), im.size


def convert(pdf, title, author, illustrator, series, lang):
    doc = pymupdf.open(pdf)
    book = Book()
    cur = {'title': 'Front Matter', 'body': [], 'notes': [], 'front': True}
    book.chapters.append(cur)
    cover = None
    para = None            # list of html strings (lines) for the paragraph being built
    last_bottom = None     # y-bottom of last body line on the previous page
    pending_scene = False

    def flush():
        nonlocal para
        if para:
            text = merge_tags(' '.join(para)).strip()
            if text:
                cur['body'].append(f'<p>{text}</p>')
        para = None

    for pno, page in enumerate(doc):
        d = page.get_text('dict')
        blocks = sorted(d['blocks'], key=lambda b: b['bbox'][1])
        rect = page.rect
        has_text = any(b['type'] == 0 and any(s['text'].strip() for l in b['lines'] for s in l['spans']) for b in blocks)
        imgs = [b for b in blocks if b['type'] == 1 and (b['bbox'][2] - b['bbox'][0]) > 40 and (b['bbox'][3] - b['bbox'][1]) > 40]

        if pno == 0:  # cover: whole first page
            data, _ = render_clip(page, rect, dpi=150)
            cover = data
            continue

        # page with neither text nor an image object: vector artwork -> render the page itself
        if not has_text and not imgs:
            flush()
            data, _ = render_clip(page, rect)
            if Image.open(io.BytesIO(data)).convert('L').getextrema()[0] > 235:
                continue  # blank page
            cur['body'].append(f'<div class="pic"><img src="../images/{book.add_image(data)}" alt=""/></div>')
            last_bottom = None
            continue

        # chapter heading page?
        page_text = ' '.join(s['text'] for b in blocks if b['type'] == 0 for l in b['lines'] for s in l['spans']).strip()
        if has_text and not imgs and HEAD_RE.match(page_text) and len(page_text.split()) <= 6:
            flush()
            cur = {'title': tidy(page_text), 'body': [f'<h1>{esc(tidy(page_text))}</h1>'], 'notes': [], 'front': False}
            book.chapters.append(cur)
            last_bottom = None
            pending_scene = False
            continue

        # gather items in reading order
        items = []   # ('line', top, bottom, html, sup_numbers) | ('img', top, rect) | ('note', top, num, html)
        for b in blocks:
            if b['type'] == 1:
                if b in imgs:
                    items.append(('img', b['bbox'][1], pymupdf.Rect(b['bbox'])))
                continue
            for l in b['lines']:
                spans = [s for s in l['spans'] if s['text'] != '']
                if not spans or not ''.join(s['text'] for s in spans).strip():
                    continue
                top, bottom = l['bbox'][1], l['bbox'][3]
                size = max(s['size'] for s in spans)
                if size <= FOOT_MAX_SIZE and top > rect.height * 0.88:
                    items.append(('note', top, spans))
                    continue
                parts, sups = [], []
                for s in spans:
                    if s['size'] <= SUP_MAX_SIZE and s['text'].strip().isdigit():
                        sups.append(s['text'].strip())
                        parts.append('\x00SUP%s\x00' % s['text'].strip())
                    else:
                        parts.append(span_html(s['text'], s['flags'], s['font']))
                items.append(('line', top, bottom, ''.join(parts), sups, spans[0]['bbox'][0]))
        items.sort(key=lambda it: it[1])

        # footnotes of this page (in order)
        notes = []
        for it in items:
            if it[0] != 'note':
                continue
            spans = it[2]
            first = spans[0]['text'].strip()
            rest = ''.join(span_html(s['text'], s['flags'], s['font']) for s in (spans[1:] if first.isdigit() else spans))
            if first.isdigit():
                notes.append([first, rest.strip()])
            elif notes:
                notes[-1][1] += ' ' + rest.strip()
        note_ids = {}
        for num, text in notes:
            book.note_id += 1
            note_ids[num] = book.note_id
            cur['notes'].append((book.note_id, num, merge_tags(text)))

        first_line = True
        prev_top = None
        for it in items:
            if it[0] == 'note':
                continue
            if it[0] == 'img':
                flush()
                if pending_scene:
                    pending_scene = False
                data, _ = render_clip(page, it[2])
                cur['body'].append(f'<div class="pic"><img src="../images/{book.add_image(data)}" alt=""/></div>')
                prev_top = None
                first_line = False
                last_bottom = None
                continue
            _, top, bottom, h, sups, x0 = it
            for n in sups:
                nid = note_ids.get(n)
                tag = (f'<sup><a epub:type="noteref" id="r{nid}" href="#fn{nid}">{n}</a></sup>' if nid else f'<sup>{n}</sup>')
                h = h.replace('\x00SUP%s\x00' % n, tag, 1)
            h = re.sub(r'\x00SUP(\d+)\x00', r'<sup>\1</sup>', h)

            new_para, scene = True, False
            if prev_top is not None:
                gap = top - prev_top
                if gap < 19:
                    new_para = False
                elif gap > 44:
                    scene = True
            elif first_line and last_bottom is not None and para:
                # page boundary: continue paragraph if the previous page was full and the sentence is unfinished
                prev_txt = re.sub(r'<[^>]+>', '', para[-1]).rstrip()
                cur_txt = re.sub(r'<[^>]+>', '', h).lstrip()
                if (last_bottom > rect.height * 0.86 and prev_txt and not prev_txt.endswith(END_PUNCT)
                        and cur_txt and cur_txt[0] not in '“"「『(（─—'):
                    new_para = False
            if first_line and last_bottom is not None and last_bottom < rect.height * 0.80 and not ('page' in cur and False):
                scene = scene or pending_scene is False and new_para  # short previous page -> scene change
            if new_para:
                flush()
                if scene and cur['body'] and not cur['body'][-1].startswith('<hr') and not cur['body'][-1].startswith('<h1'):
                    cur['body'].append('<hr class="scene"/>')
                para = [h]
            else:
                para = (para or []) + [h]
            prev_top = top
            first_line = False
            last_bottom = bottom
        pending_scene = False

    flush()

    # drop empty chapters; first real chapter gets the cover/front matter separately
    chapters = [c for c in book.chapters if c['body'] or c['notes']]
    return book, chapters, cover


CSS = """body{font-family:serif;line-height:1.6;margin:0 4%;}
h1{font-size:1.5em;text-align:center;margin:2.5em 0 1.5em;}
p{margin:0 0 .85em;text-indent:0;}
hr.scene{border:0;text-align:center;margin:1.6em 0;}
hr.scene:after{content:"\\2756";}
.pic{text-align:center;margin:1em 0;page-break-inside:avoid;}
.pic img{max-width:100%;height:auto;}
sup{font-size:.7em;line-height:0;}
sup a{text-decoration:none;}
.notes{border-top:1px solid #888;margin-top:2.5em;padding-top:.6em;font-size:.85em;}
.notes p{margin:0 0 .4em;}
"""


def xhtml(title, body, lang):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}" xml:lang="{lang}">'
            f'<head><meta charset="utf-8"/><title>{esc(title)}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head>'
            f'<body>{body}</body></html>')


def write_epub(path, book, chapters, cover, title, author, illustrator, series, lang):
    uid = 'urn:uuid:' + str(uuid.uuid4())
    files = []
    toc = []
    for i, c in enumerate(chapters, 1):
        name = f'text/ch{i:03d}.xhtml'
        body = '\n'.join(c['body'])
        if c['notes']:
            body += '\n<div class="notes">' + ''.join(
                f'<p id="fn{nid}" epub:type="footnote"><a href="#r{nid}">{num}.</a> {text}</p>' for nid, num, text in c['notes']) + '</div>'
        if c['front'] and not c['body'][:1] == []:
            c['title'] = 'Illustrations & Credits'
        files.append((name, xhtml(c['title'], body, lang)))
        toc.append((name, c['title']))

    items = ['<item id="css" href="styles/book.css" media-type="text/css"/>',
             '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
             '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
             '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
             '<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>']
    spine = ['<itemref idref="cover" linear="no"/>']
    for i, (name, _) in enumerate(files, 1):
        items.append(f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="c{i}"/>')
    for i, (name, _) in enumerate(book.images, 1):
        items.append(f'<item id="i{i}" href="images/{name}" media-type="image/jpeg"/>')

    meta = [f'<dc:identifier id="uid">{uid}</dc:identifier>', f'<dc:title>{esc(title)}</dc:title>',
            f'<dc:creator>{esc(author)}</dc:creator>', f'<dc:language>{lang}</dc:language>',
            '<meta name="cover" content="cover-img"/>']
    if illustrator:
        meta.append(f'<dc:contributor>{esc(illustrator)}</dc:contributor>')
    if series:
        meta.append(f'<meta property="belongs-to-collection" id="series">{esc(series)}</meta>')
    opf = ('<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' + ''.join(meta) + '</metadata>'
           '<manifest>' + ''.join(items) + '</manifest><spine toc="ncx">' + ''.join(spine) + '</spine></package>')

    nav = ('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
           '<head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>'
           + ''.join(f'<li><a href="{n}">{esc(t)}</a></li>' for n, t in toc) + '</ol></nav></body></html>')
    ncx = ('<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head>'
           f'<meta name="dtb:uid" content="{uid}"/></head><docTitle><text>{esc(title)}</text></docTitle><navMap>'
           + ''.join(f'<navPoint id="n{i}" playOrder="{i}"><navLabel><text>{esc(t)}</text></navLabel><content src="{n}"/></navPoint>'
                     for i, (n, t) in enumerate(toc, 1)) + '</navMap></ncx>')
    cover_x = xhtml(title, '<div class="pic"><img src="../images/cover.jpg" alt="Cover"/></div>', lang)

    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml',
                   '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
                   compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/nav.xhtml', nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/toc.ncx', ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/styles/book.css', CSS, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/text/cover.xhtml', cover_x, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/images/cover.jpg', cover or b'', compress_type=zipfile.ZIP_STORED)
        for name, content in files:
            z.writestr('OEBPS/' + name, content, compress_type=zipfile.ZIP_DEFLATED)
        for name, data in book.images:
            z.writestr('OEBPS/images/' + name, data, compress_type=zipfile.ZIP_STORED)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf'); ap.add_argument('out')
    ap.add_argument('--title', required=True); ap.add_argument('--author', default='Unknown')
    ap.add_argument('--illustrator', default=''); ap.add_argument('--series', default=''); ap.add_argument('--lang', default='en')
    a = ap.parse_args()
    book, chapters, cover = convert(a.pdf, a.title, a.author, a.illustrator, a.series, a.lang)
    write_epub(a.out, book, chapters, cover, a.title, a.author, a.illustrator, a.series, a.lang)
    print(f'{a.out}: {len(chapters)} sections, {len(book.images)} images, {book.note_id} footnotes')
    for c in chapters:
        print('  -', c['title'], f"({len(c['body'])} blocks, {len(c['notes'])} notes)")


if __name__ == '__main__':
    main()
