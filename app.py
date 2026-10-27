from flask import Flask, request, jsonify, render_template, send_file
import os
import io
import re
import uuid
from utils.validator import validate_input
from utils.pdf_processor import process_pdf
from utils.arxiv_fetcher import fetch_arxiv_paper
from werkzeug.utils import secure_filename
from utils.rag_pipeline import RAGPipeline, is_valid_doc_id
from utils.pdf_generator import generate_pdf

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB limit
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

rag = RAGPipeline()
rag.cleanup_cache()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process', methods=['POST'])
def process():
    try:
        rag.cleanup_cache()
        doc_id = str(uuid.uuid4())
        input_type = request.form.get('input_type')  # 'file' or 'link'

        if input_type == 'file':
            if 'file' not in request.files:
                return jsonify({'error': 'No file provided.'}), 400
            file = request.files['file']
            validation = validate_input('file', file.filename)
            if not validation['valid']:
                return jsonify({'error': validation['message']}), 400

            safe_name = secure_filename(file.filename) or 'upload.pdf'
            filepath = os.path.join(UPLOAD_FOLDER, safe_name)
            file.save(filepath)
            try:
                text, metadata = process_pdf(filepath, file.filename)
            finally:
                if os.path.exists(filepath):
                    os.remove(filepath)

        elif input_type == 'link':
            url = request.form.get('url', '').strip()
            validation = validate_input('link', url)
            if not validation['valid']:
                return jsonify({'error': validation['message']}), 400

            text, metadata = fetch_arxiv_paper(url)

        else:
            return jsonify({'error': 'Invalid input type.'}), 400

        result = rag.run(text, metadata, doc_id=doc_id)
        return jsonify({'success': True, 'data': result, 'doc_id': doc_id})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/ask', methods=['POST'])
def ask():
    try:
        data = request.get_json() or {}
        doc_id = data.get('doc_id')
        if not is_valid_doc_id(doc_id):
            return jsonify({'error': 'Invalid document ID format.', 'expired': True}), 400

        question = data.get('question', '').strip()
        chat_history = data.get('chat_history', []) or data.get('history', [])
        if not question:
            return jsonify({'error': 'Question cannot be empty.'}), 400

        try:
            answer = rag.answer_question(doc_id, question, chat_history=chat_history)
            return jsonify({'answer': answer})
        except FileNotFoundError:
            return jsonify({'error': 'This document expired. Please upload it again.', 'expired': True}), 404

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/download', methods=['POST'])
def download():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided.'}), 400
        pdf_bytes = generate_pdf(data)
        title = data.get('title') or (data.get('metadata') or {}).get('title') or 'document'
        return send_file(
            io.BytesIO(pdf_bytes),
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f"{title}_analysis.pdf"
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/quiz', methods=['POST'])
def quiz():
    try:
        data = request.get_json() or {}
        doc_id = data.get('doc_id')
        if not is_valid_doc_id(doc_id):
            return jsonify({'error': 'Invalid document ID format.', 'expired': True}), 400

        previous_questions = data.get('previous_questions', [])
        try:
            questions = rag.generate_quiz(doc_id, previous_questions=previous_questions)
            return jsonify({'success': True, 'questions': questions})
        except FileNotFoundError:
            return jsonify({'error': 'This document expired. Please upload it again.', 'expired': True}), 404

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/delete-doc', methods=['POST'])
def delete_doc():
    try:
        data = request.get_json() or {}
        doc_id = data.get('doc_id')
        if is_valid_doc_id(doc_id):
            rag.delete_doc(doc_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
