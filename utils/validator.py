import re

ARXIV_PATTERNS = [
    r'arxiv\.org/abs/(\d{4}\.\d{4,5})',
    r'arxiv\.org/pdf/(\d{4}\.\d{4,5})',
    r'^(\d{4}\.\d{4,5})$'
]

def validate_input(input_type, value):
    if input_type == 'file':
        if not value:
            return {'valid': False, 'message': 'No file selected.'}
        ext = value.rsplit('.', 1)[-1].lower() if '.' in value else ''
        if ext != 'pdf':
            return {
                'valid': False,
                'message': f'Only PDF files are accepted. You uploaded a .{ext} file. Please upload a research paper in PDF format.'
            }
        return {'valid': True}

    elif input_type == 'link':
        if not value:
            return {'valid': False, 'message': 'No URL provided.'}

        is_arxiv = any(re.search(p, value) for p in ARXIV_PATTERNS)
        if not is_arxiv:
            return {
                'valid': False,
                'message': (
                    'Only arXiv links are supported right now. '
                    'Please provide a link like https://arxiv.org/abs/2301.07041 '
                    'or paste an arXiv paper ID directly (e.g. 2301.07041).'
                )
            }
        return {'valid': True}

    return {'valid': False, 'message': 'Unknown input type.'}
