import requests
import re
import xml.etree.ElementTree as ET
import fitz
import io

ARXIV_API = "https://export.arxiv.org/api/query?id_list="

def extract_arxiv_id(url):
    patterns = [
        r'arxiv\.org/abs/(\d{4}\.\d{4,5}(?:v\d+)?)',
        r'arxiv\.org/pdf/(\d{4}\.\d{4,5}(?:v\d+)?)',
        r'^(\d{4}\.\d{4,5}(?:v\d+)?)$'
    ]
    for p in patterns:
        match = re.search(p, url)
        if match:
            return match.group(1)
    return None

def fetch_arxiv_paper(url):
    arxiv_id = extract_arxiv_id(url)
    if not arxiv_id:
        raise ValueError("Could not extract arXiv ID from the provided URL.")

    # Fetch metadata
    api_url = f"{ARXIV_API}{arxiv_id}"
    response = requests.get(api_url, timeout=10)
    response.raise_for_status()

    root = ET.fromstring(response.text)
    ns = {'atom': 'http://www.w3.org/2005/Atom'}
    entry = root.find('atom:entry', ns)

    if entry is None:
        raise ValueError(f"No paper found for arXiv ID: {arxiv_id}")

    title = entry.find('atom:title', ns).text.strip().replace('\n', ' ')
    abstract = entry.find('atom:summary', ns).text.strip().replace('\n', ' ')
    authors = [a.find('atom:name', ns).text for a in entry.findall('atom:author', ns)]

    # Fetch PDF content
    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    pdf_response = requests.get(pdf_url, timeout=30)
    pdf_response.raise_for_status()

    doc = fitz.open(stream=pdf_response.content, filetype="pdf")
    full_text = ""
    for page in doc:
        full_text += page.get_text()
    doc.close()

    from utils.pdf_processor import extract_references
    references = extract_references(full_text)

    metadata = {
        'title': title,
        'authors': ', '.join(authors[:5]),
        'abstract': abstract,
        'source': f'arXiv:{arxiv_id}',
        'arxiv_id': arxiv_id,
        'arxiv_url': f'https://arxiv.org/abs/{arxiv_id}',
        'references': references
    }

    return full_text, metadata
