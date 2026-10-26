import os
import re
import fitz  # PyMuPDF

# lines we never want as title or author (stamps, permissions, headers)
NOISE_RE = re.compile(
    r'arxiv|permission|copyright|©|license|attribution|hereby|http|www\.|\bdoi\b|'
    r'proceedings|conference|workshop|preprint|submitted|under review',
    re.IGNORECASE
)
BAD_META_TITLE = re.compile(
    r'(\.docx?$|\.tex$|\.dvi$|\.pdf$|microsoft word|untitled|^arxiv)', re.IGNORECASE
)

ORG_WORDS = {
    'google', 'brain', 'research', 'university', 'institute', 'lab', 'labs',
    'laboratory', 'toronto', 'department', 'school', 'college', 'faculty',
    'center', 'centre', 'inc', 'corp', 'microsoft', 'openai', 'deepmind',
    'technologies', 'technology', 'engineering', 'science', 'sciences'
}
PARTICLES = {'van', 'der', 'de', 'von', 'da', 'di', 'la', 'le', 'bin', 'al', 'el', 'den'}
WORD_RE = re.compile(r"^[^\W\d_a-z][\w.'’\-]*$")  # starts with a capital letter
ABSTRACT_END = re.compile(r'^(\d+\.?\s*)?(introduction|keywords?|index terms)\b', re.IGNORECASE)


# ───────────────────────── TITLE ─────────────────────────

def title_from_layout(page):
    """Biggest horizontal text in top half of page 1 (skips rotated arXiv stamp)."""
    lines = []
    max_y = page.rect.height * 0.5
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            dx, dy = l.get("dir", (1, 0))
            if abs(dx) < 0.9:  # rotated
                continue
            spans = [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = ' '.join(' '.join(s["text"].strip() for s in spans).split())
            y0 = min(s["bbox"][1] for s in spans)
            if y0 > max_y or len(text) < 3 or NOISE_RE.search(text):
                continue
            size = max(s["size"] for s in spans)
            lines.append((y0, size, text))
    if not lines:
        return ""
    top = max(x[1] for x in lines)
    cand = sorted([x for x in lines if x[1] >= top - 1.0], key=lambda x: x[0])
    group = [cand[0]]
    for prev, cur in zip(cand, cand[1:]):
        if cur[0] - prev[0] <= top * 2.2:  # next line of the same title
            group.append(cur)
        else:
            break
    title = ' '.join(x[2] for x in group)
    return title if 4 <= len(title) <= 250 else ""


def title_from_metadata(doc):
    t = ' '.join(((doc.metadata or {}).get('title') or '').split())
    if len(t) < 6 or BAD_META_TITLE.search(t):
        return ""
    return t


def title_from_text(lines):
    for l in lines[:15]:
        if l.lower().startswith('abstract'):
            break
        if len(l) < 8 or NOISE_RE.search(l):
            continue
        if not l[0].isupper() or l.endswith('.'):
            continue
        return l
    return ""


def title_from_filename(name):
    base = os.path.splitext(os.path.basename(name or ''))[0]
    base = re.sub(r'[_\-]+', ' ', base).strip()
    return base or "Untitled Paper"


# ───────────────────────── AUTHORS ─────────────────────────

def _norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


def is_name(p):
    words = p.split()
    if not (2 <= len(words) <= 4):
        return False
    if set(re.findall(r'[a-z]+', p.lower())) & ORG_WORDS:
        return False
    for w in words:
        if w.lower() in PARTICLES:
            continue
        if not WORD_RE.match(w):
            return False
    if words[0].lower() in PARTICLES or words[-1].lower() in PARTICLES:
        return False
    return len(words[0]) >= 2 and len(words[-1]) >= 2


def extract_authors(lines, start, end):
    names, seen = [], set()
    for l in lines[start:end]:
        if '@' in l or NOISE_RE.search(l):
            continue
        cleaned = re.sub(r'[∗†‡*#§¶\d]', '', l).strip(' ,;')
        if not cleaned:
            continue
        for p in re.split(r',|;|\band\b|\s{2,}', cleaned):
            p = p.strip()
            if p and is_name(p) and p.lower() not in seen:
                seen.add(p.lower())
                names.append(p)
    return ', '.join(names[:12])


# ───────────────────────── MAIN ─────────────────────────

def process_pdf(filepath, original_name=None):
    doc = fitz.open(filepath)
    full_text = ""
    for page in doc:
        full_text += page.get_text()

    title = ""
    if len(doc) > 0:
        title = title_from_layout(doc[0]) or title_from_metadata(doc)
    doc.close()

    metadata = extract_metadata_from_text(full_text, title, original_name or filepath)
    return full_text, metadata


def is_research_paper(text):
    if not text:
        return False

    # arXiv links are always papers
    if re.search(r'https?://[^\s]*arxiv\.org|arxiv\.org/(?:abs|pdf)/', text, re.IGNORECASE):
        return True

    score = 0
    if re.search(r'\babstract\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\b(references|bibliography)\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\bintroduction\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\b(methods?|methodology|experiments?|experimental)\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\bconclusions?\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\[1\]|\bet\s+al\b', text, re.IGNORECASE):
        score += 1
    if re.search(r'\barxiv\b|\bdoi\b', text, re.IGNORECASE):
        score += 1

    return score >= 4


def extract_metadata_from_text(text, title="", fallback_name=""):
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    # title fallbacks: text guess -> file name
    if not title:
        title = title_from_text(lines)
    if not title:
        title = title_from_filename(fallback_name)

    authors = ""
    abstract = ""
    abs_idx = next(
        (i for i, l in enumerate(lines[:150]) if l.lower().startswith('abstract')), None
    )

    # authors: lines after the title, before the abstract
    end = abs_idx if abs_idx is not None else min(len(lines), 25)
    nt = _norm(title)
    start = 0
    for i, l in enumerate(lines[:end]):
        nl = _norm(l)
        if len(nl) >= 5 and nl in nt:
            start = i + 1
    authors = extract_authors(lines, start, end)

    if abs_idx is not None:
        first = re.sub(r'^abstract[\s:.\-–—]*', '', lines[abs_idx], flags=re.IGNORECASE)
        parts = [first] if first else []
        for nxt in lines[abs_idx + 1:abs_idx + 60]:
            if ABSTRACT_END.match(nxt):
                break
            parts.append(nxt)
        abstract = ' '.join(parts)
        abstract = re.split(r'\s*[∗†‡]', abstract)[0].strip()

    return {
        'title': title,
        'authors': authors,
        'abstract': abstract,
        'source': 'PDF Upload',
        'references': extract_references(text),
        'is_paper': is_research_paper(text)
    }


def extract_references(text):
    refs = []
    ref_section = re.split(r'\bReferences\b|\bBibliography\b', text, flags=re.IGNORECASE)
    if len(ref_section) > 1:
        raw_refs = ref_section[-1]
        entries = re.split(r'\[\d+\]|\n\d{1,3}\.\s', raw_refs)
        entries = entries[1:101]
        for idx, entry in enumerate(entries):
            cleaned = ' '.join(entry.split())
            cleaned = re.sub(r'\s+\d{1,2}$', '', cleaned)
            if idx == len(entries) - 1:
                m = re.match(r'(.*?\b(?:19|20)\d{2}\.)', cleaned)
                if m:
                    cleaned = m.group(1)
            if len(cleaned) > 20:
                refs.append(cleaned[:300])
    return refs