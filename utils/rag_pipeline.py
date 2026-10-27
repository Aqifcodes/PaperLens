import os
import json
import pickle
import uuid
import time
from collections import OrderedDict
from dotenv import load_dotenv
load_dotenv()

import re
import requests
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

EMBED_MODEL = "all-MiniLM-L6-v2"
LLM_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
HEADERS = {
    "Authorization": f"Bearer {GEMINI_API_KEY}",
    "Content-Type": "application/json",
}

_embedder = SentenceTransformer(EMBED_MODEL)

CHUNK_SIZE = 300
CHUNK_OVERLAP = 50
TOP_K = 8
QA_TOP_K = 6

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'uploads')
MAX_CACHE_FILES = 50
MAX_CACHE_AGE_SEC = 24 * 3600  # 24 hours

def is_valid_doc_id(doc_id):
    if not doc_id or not isinstance(doc_id, str):
        return False
    try:
        u = uuid.UUID(doc_id, version=4)
        return str(u) == doc_id
    except (ValueError, TypeError, AttributeError):
        return False

LIMIT_PATTERN = re.compile(
    r'future work|we plan to|plan to extend|limitation|future research|in future|conclusion',
    re.IGNORECASE
)

# CHANGED: section keys in fixed order, used to build and parse the single call
SECTION_KEYS = ['summary', 'methodology', 'dataset', 'results', 'limitations']
SECTION_RE = re.compile(
    r'^\s*#{2,}\s*(SUMMARY|METHODOLOGY|DATASET|RESULTS|LIMITATIONS)\s*$',
    re.IGNORECASE | re.MULTILINE
)


class RAGPipeline:

    def __init__(self, mem_cache_size=5):
        self._doc_cache = OrderedDict()
        self._mem_cache_size = mem_cache_size
        self.upload_dir = UPLOAD_DIR
        os.makedirs(self.upload_dir, exist_ok=True)
        self.cleanup_cache()

    def get_doc(self, doc_id):
        if not is_valid_doc_id(doc_id):
            raise ValueError("Invalid document ID format.")

        if doc_id in self._doc_cache:
            self._doc_cache.move_to_end(doc_id)
            return self._doc_cache[doc_id]

        filepath = os.path.join(self.upload_dir, f"{doc_id}.pkl")
        if not os.path.exists(filepath):
            raise FileNotFoundError("This document expired. Please upload it again.")

        try:
            with open(filepath, 'rb') as f:
                doc_data = pickle.load(f)
            self._doc_cache[doc_id] = doc_data
            if len(self._doc_cache) > self._mem_cache_size:
                self._doc_cache.popitem(last=False)
            return doc_data
        except Exception as e:
            raise FileNotFoundError(f"Could not load document: {e}")

    def save_doc(self, doc_id, chunks, chunk_embeddings, metadata):
        if not is_valid_doc_id(doc_id):
            raise ValueError("Invalid document ID format.")

        doc_data = {
            'chunks': chunks,
            'embeddings': chunk_embeddings,
            'metadata': metadata,
            'created_at': time.time()
        }

        filepath = os.path.join(self.upload_dir, f"{doc_id}.pkl")
        with open(filepath, 'wb') as f:
            pickle.dump(doc_data, f)

        self._doc_cache[doc_id] = doc_data
        if len(self._doc_cache) > self._mem_cache_size:
            self._doc_cache.popitem(last=False)

    def delete_doc(self, doc_id):
        if not is_valid_doc_id(doc_id):
            return False
        self._doc_cache.pop(doc_id, None)
        filepath = os.path.join(self.upload_dir, f"{doc_id}.pkl")
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
                return True
        except OSError:
            pass
        return False

    def cleanup_cache(self):
        try:
            if not os.path.exists(self.upload_dir):
                return
            now = time.time()
            valid_files = []
            for fname in os.listdir(self.upload_dir):
                # Clean up legacy cache file if found
                if fname == '.rag_doc_cache.pkl':
                    try:
                        os.remove(os.path.join(self.upload_dir, fname))
                    except OSError:
                        pass
                    continue

                if not fname.endswith('.pkl'):
                    continue
                fpath = os.path.join(self.upload_dir, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if now - mtime > MAX_CACHE_AGE_SEC:
                        os.remove(fpath)
                        stem = fname[:-4]
                        self._doc_cache.pop(stem, None)
                    else:
                        valid_files.append((mtime, fpath, fname[:-4]))
                except OSError:
                    pass

            if len(valid_files) > MAX_CACHE_FILES:
                valid_files.sort(key=lambda x: x[0])  # oldest first
                excess = len(valid_files) - MAX_CACHE_FILES
                for i in range(excess):
                    _, fpath, stem = valid_files[i]
                    try:
                        os.remove(fpath)
                        self._doc_cache.pop(stem, None)
                    except OSError:
                        pass
        except Exception as e:
            print(f"Warning during cache cleanup: {e}")

    def embed(self, texts):
        return np.array(_embedder.encode(texts, show_progress_bar=False))

    def chunk_text(self, text):
        words = text.split()
        chunks = []
        for i in range(0, len(words), CHUNK_SIZE - CHUNK_OVERLAP):
            chunk = ' '.join(words[i:i + CHUNK_SIZE])
            if chunk.strip():
                chunks.append(chunk)
        return chunks

    def retrieve(self, query, chunks, chunk_embeddings, top_k=TOP_K):
        query_emb = self.embed([query])[0]
        scores = cosine_similarity([query_emb], chunk_embeddings)[0]
        top_indices = np.argsort(scores)[::-1][:top_k]
        return [chunks[i] for i in top_indices]

    def keyword_chunks(self, chunks, pattern, max_n=3):
        scored = [(len(pattern.findall(c)), i) for i, c in enumerate(chunks)]
        scored = [s for s in scored if s[0] > 0]
        scored.sort(key=lambda s: (-s[0], -s[1]))
        return [chunks[i] for _, i in scored[:max_n]]

    # CHANGED: max_tokens is now a parameter (the single call needs more room)
    def call_llm(self, prompt, max_tokens=4096, json_mode=False):
        payload = {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.4,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        last_err = None
        for attempt in range(4):
            try:
                response = requests.post(GEMINI_URL, headers=HEADERS, json=payload, timeout=180)
                if response.status_code == 400 and json_mode and attempt == 0:
                    payload.pop("response_format", None)
                    response = requests.post(GEMINI_URL, headers=HEADERS, json=payload, timeout=180)
                if response.status_code == 429:
                    last_err = "429 from Gemini (rate limit)"
                    time.sleep(15 * (attempt + 1))  # 15s, 30s, 45s, 60s
                    continue
                if response.status_code in (500, 502, 503, 504):
                    last_err = f"{response.status_code} from Gemini"
                    time.sleep(3 * (attempt + 1))
                    continue
                response.raise_for_status()
                result = response.json()
                content = result["choices"][0]["message"]["content"]
                if content is not None:
                    return content.strip()
                return ""
            except (KeyError, IndexError, AttributeError) as e:
                last_err = f"Unexpected response format ({e})"
                time.sleep(2 * (attempt + 1))
            except requests.exceptions.RequestException as e:
                last_err = str(e)
                time.sleep(3 * (attempt + 1))
        raise RuntimeError(f"Gemini is busy right now ({last_err}). Please try again in a minute.")

    # Used by Q&A only
    def build_qa_prompt(self, title, context, question, chat_history=None):
        history_text = ""
        if chat_history and isinstance(chat_history, list):
            formatted_msgs = []
            for m in chat_history[-6:]:
                role = "User" if m.get('role') in ('user', 'human') else "Assistant"
                text = (m.get('text') or m.get('content') or '').strip()
                if text:
                    formatted_msgs.append(f"{role}: {text}")
            if formatted_msgs:
                history_text = "\nRecent Conversation History:\n" + "\n".join(formatted_msgs) + "\n"

        return f"""You are a research assistant. Answer the user's question using only the document excerpts below. You may use the recent conversation history to understand follow-up questions or requests for clarification.
Rules:
- Use plain text, no markdown, no asterisks
- Use short bullet points starting with "- ", one per line
- Max 5 bullets, each under 25 words
- Only state what the authors say, do not make things up
- If the answer is only partly in the excerpts, give what you can
- If the user asks for a simpler explanation, clarification, or follow-up, explain concisely based on the excerpts
- Say "Not found in the document" only if nothing in the excerpts is relevant
- Broad questions (like "what problem does it solve") can be answered by stating the problem first, then what the authors propose to fix it

Document: {title}

Context:
{context}
{history_text}
Question: {question}

Answer:"""

    # CHANGED: one prompt that asks for all 5 sections, each with its own excerpts
    def build_combined_prompt(self, title, sections):
        blocks = []
        for key, query, context in sections:
            blocks.append(
                f"=== SECTION: {key.upper()} ===\n"
                f"Question: {query}\n\n"
                f"Excerpts:\n{context}"
            )
        all_blocks = '\n\n'.join(blocks)

        return f"""You are a research assistant. Answer 5 questions about one paper.
Each section below has its own question and its own excerpts. Answer each section using only its excerpts.

Rules for every section:
- Use plain text, no markdown, no asterisks
- Use short bullet points starting with "- ", one per line
- Max 5 bullets, each under 25 words
- Only state what the authors say, do not infer
- If the excerpts of a section don't contain the answer, write "Not found in the paper" for that section

Output format, exactly this, nothing before or after:
## SUMMARY
- bullet
## METHODOLOGY
- bullet
## DATASET
- bullet
## RESULTS
- bullet
## LIMITATIONS
- bullet

Paper: {title}

{all_blocks}

Now write the 5 sections in the output format:"""

    # CHANGED: splits the single reply into the 5 sections
    def parse_sections(self, reply):
        parts = SECTION_RE.split(reply)
        found = {}
        # parts = [before, NAME, text, NAME, text, ...]
        for i in range(1, len(parts) - 1, 2):
            name = parts[i].strip().lower()
            body = parts[i + 1].strip()
            if name in SECTION_KEYS and body:
                found[name] = body
        return {k: found.get(k, "Not found in the paper") for k in SECTION_KEYS}

    def run(self, text, metadata, doc_id=None):
        if not doc_id:
            doc_id = str(uuid.uuid4())

        chunks = self.chunk_text(text)
        if not chunks:
            raise ValueError("Could not extract text from the document.")

        chunk_embeddings = self.embed(chunks)
        self.save_doc(doc_id, chunks, chunk_embeddings, metadata)

        is_paper = metadata.get('is_paper')
        if is_paper is None:
            is_paper = bool(metadata.get('arxiv_id') or metadata.get('arxiv_url') or 'arxiv' in str(metadata.get('source', '')).lower())
        metadata['is_paper'] = is_paper
        metadata['doc_id'] = doc_id

        if not is_paper:
            return {
                'doc_id': doc_id,
                'metadata': metadata,
                'is_paper': False,
                'summary': '',
                'methodology': '',
                'dataset': '',
                'results': '',
                'limitations': '',
                'total_chunks': len(chunks)
            }

        queries = {
            'summary': "What is this paper about? What is the main contribution?",
            'methodology': "What model architecture, method, and training setup was used?",
            'dataset': "Which datasets, corpora, or benchmarks were used for training and evaluation?",
            'results': "What are the main numeric results and comparisons to baselines?",
            'limitations': "What future work, limitations, or next steps do the authors mention in the conclusion?"
        }

        # same retrieval as before, just no LLM call per section
        sections = []
        for key in SECTION_KEYS:
            query = queries[key]
            context_chunks = self.retrieve(query, chunks, chunk_embeddings)
            if key == 'limitations':
                extra = self.keyword_chunks(chunks, LIMIT_PATTERN)
                context_chunks = extra + [c for c in context_chunks if c not in extra]
            context = '\n\n'.join(context_chunks)
            sections.append((key, query, context))

        prompt = self.build_combined_prompt(metadata.get('title', ''), sections)
        reply = self.call_llm(prompt, max_tokens=6000)  # the only Gemini call per paper
        results = self.parse_sections(reply)

        return {
            'doc_id': doc_id,
            'metadata': metadata,
            'is_paper': True,
            'summary': results['summary'],
            'methodology': results['methodology'],
            'dataset': results['dataset'],
            'results': results['results'],
            'limitations': results['limitations'],
            'total_chunks': len(chunks)
        }

    def answer_question(self, doc_id, question, chat_history=None):
        doc = self.get_doc(doc_id)
        chunks = doc['chunks']
        chunk_embeddings = doc['embeddings']
        metadata = doc['metadata']

        retrieval_query = question
        if chat_history and isinstance(chat_history, list):
            prev_user_queries = [m.get('text', '') or m.get('content', '') for m in chat_history if m.get('role') in ('user', 'human')]
            if prev_user_queries:
                last_user_q = prev_user_queries[-1].strip()
                if len(question.split()) < 6 or any(w in question.lower() for w in ['it', 'that', 'this', 'more', 'again', 'second', 'first', 'third', 'these', 'those', 'explain', 'simplify']):
                    retrieval_query = f"{last_user_q} {question}"

        context_chunks = self.retrieve(retrieval_query, chunks, chunk_embeddings, top_k=QA_TOP_K)
        abstract = (metadata.get('abstract') or '').strip()
        if abstract:
            context_chunks = ["Abstract: " + abstract] + context_chunks
        context = '\n\n'.join(context_chunks)
        prompt = self.build_qa_prompt(metadata.get('title', ''), context, question, chat_history=chat_history)
        return self.call_llm(prompt)

    def generate_quiz(self, doc_id, previous_questions=None):
        doc = self.get_doc(doc_id)
        chunks = doc['chunks']
        metadata = doc['metadata']

        n = len(chunks)
        valid_prev = []
        if previous_questions and isinstance(previous_questions, list):
            valid_prev = [str(q).strip() for q in previous_questions if str(q).strip()]

        batch_idx = len(valid_prev) // 5

        # If document has <= 15 chunks, provide all of them so Gemini has full context
        if n <= 15:
            selected_chunks = chunks
        else:
            # Sample 12 chunks spread across the document, shifting offset by batch_idx so each batch examines different portions
            num_sample = min(n, 12)
            step = (n - 1) / (num_sample - 1)
            offset = (batch_idx * 3) % n
            indices = [int(round((i * step + offset) % n)) for i in range(num_sample)]
            indices = sorted(list(dict.fromkeys(indices)))
            selected_chunks = [chunks[i] for i in indices]

        context = "\n\n---\n\n".join(selected_chunks)
        title = (self._metadata.get('title') or 'the document') if hasattr(self, '_metadata') and self._metadata else 'the document'

        prev_text = ""
        if valid_prev:
            prev_text = (
                "\nPreviously asked questions:\n"
                + "\n".join(f"- {q}" for q in valid_prev[-20:])
                + "\n\nPlease create 5 NEW questions covering different details, terminology, findings, or sections of the document. "
                "Do not repeat the exact questions above. If the document is concise, ask about deeper specifics, definitions, or implications of the material.\n"
            )

        prompt = f"""You are an educational assessment expert. Create exactly 5 multiple choice questions (MCQs) testing understanding of {title} using the document excerpts below.{prev_text}
Rules:
- Generate exactly 5 questions.
- Each question must have exactly 4 distinct options.
- Exactly 1 option must be the correct answer.
- Provide a concise 1-line explanation of why the correct answer is right.
- Ensure questions are factual, clear, and based directly on the excerpts.
- Return ONLY a valid JSON object with a "questions" key containing the list of 5 question objects.

JSON schema:
{{
  "questions": [
    {{
      "question": "Question text?",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correct_index": 0,
      "explanation": "One line explanation here."
    }}
  ]
}}

Document Excerpts:
{context}

JSON Output:"""

        questions = []
        try:
            reply = self.call_llm(prompt, max_tokens=4096, json_mode=True)
            questions = self.parse_quiz(reply)
            if not questions and valid_prev:
                raise ValueError("Empty question batch on follow-up")
        except Exception:
            # Fallback attempt with relaxed prompt if follow-up constraints caused an empty or invalid reply
            fallback_prompt = f"""You are an educational assessment expert. Create exactly 5 multiple choice questions (MCQs) testing understanding of {title} from the excerpts below.
Rules:
- Generate exactly 5 questions.
- Each question must have 4 distinct options.
- Exactly 1 option must be the correct answer (correct_index 0-3).
- Provide a concise 1-line explanation.
- Return ONLY a valid JSON object with a "questions" key containing the list of 5 question objects.

Document Excerpts:
{context}

JSON Output:"""
            reply = self.call_llm(fallback_prompt, max_tokens=4096, json_mode=True)
            questions = self.parse_quiz(reply)

        if not questions:
            raise ValueError("Could not parse quiz JSON from model response.")

        return questions[:5]

    def parse_quiz(self, reply):
        if not reply or not isinstance(reply, str):
            raise ValueError("Could not parse quiz JSON from model response.")

        text = reply.strip()

        # 1. Extract from markdown code fences if present
        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
        if fence_match:
            extracted = fence_match.group(1).strip()
        else:
            extracted = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
            extracted = re.sub(r"\s*```$", "", extracted).strip()

        # Helper to clean comments & trailing commas
        def clean_json_str(s):
            s = re.sub(r'//.*?\n', '\n', s)
            s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
            s = re.sub(r',\s*([\]}])', r'\1', s)
            return s

        # Helper to recover valid question objects from truncated JSON
        def extract_partial_questions(s):
            results = []
            for m in re.finditer(r'\{\s*"question"\s*:', s):
                start_idx = m.start()
                depth = 0
                in_str = False
                esc = False
                end_idx = -1
                for i in range(start_idx, len(s)):
                    c = s[i]
                    if esc:
                        esc = False
                        continue
                    if c == '\\':
                        esc = True
                        continue
                    if c == '"':
                        in_str = not in_str
                        continue
                    if not in_str:
                        if c == '{':
                            depth += 1
                        elif c == '}':
                            depth -= 1
                            if depth == 0:
                                end_idx = i
                                break
                if end_idx != -1:
                    snippet = s[start_idx:end_idx+1]
                    try:
                        obj = json.loads(snippet)
                        if isinstance(obj, dict) and 'question' in obj:
                            results.append(obj)
                    except Exception:
                        try:
                            obj = json.loads(clean_json_str(snippet))
                            if isinstance(obj, dict) and 'question' in obj:
                                results.append(obj)
                        except Exception:
                            pass
            return results

        data = None
        # Attempt 1: parse extracted or raw text directly
        for candidate in [extracted, text]:
            try:
                data = json.loads(candidate)
                break
            except Exception:
                try:
                    data = json.loads(clean_json_str(candidate))
                    break
                except Exception:
                    pass

        # Attempt 2: find substring starting with [ and ending with ]
        if data is None:
            for candidate in [extracted, text]:
                start = candidate.find('[')
                end = candidate.rfind(']')
                if start != -1 and end > start:
                    sub = candidate[start:end+1]
                    try:
                        data = json.loads(sub)
                        break
                    except Exception:
                        try:
                            data = json.loads(clean_json_str(sub))
                            break
                        except Exception:
                            pass

        # Attempt 3: find substring starting with { and ending with }
        if data is None:
            for candidate in [extracted, text]:
                start = candidate.find('{')
                end = candidate.rfind('}')
                if start != -1 and end > start:
                    sub = candidate[start:end+1]
                    try:
                        data = json.loads(sub)
                        break
                    except Exception:
                        try:
                            data = json.loads(clean_json_str(sub))
                            break
                        except Exception:
                            pass

        # Attempt 4: Extract completed question objects from truncated JSON
        if data is None:
            recovered = extract_partial_questions(text) or extract_partial_questions(extracted)
            if recovered:
                data = recovered

        # If data is a dict, look for a list in its keys / values
        if isinstance(data, dict):
            for key in ['questions', 'quiz', 'items', 'mcqs', 'results']:
                if key in data and isinstance(data[key], list) and len(data[key]) > 0:
                    data = data[key]
                    break
            else:
                for val in data.values():
                    if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                        data = val
                        break
                else:
                    dict_vals = [v for v in data.values() if isinstance(v, dict) and ('question' in v or 'options' in v)]
                    if dict_vals:
                        data = dict_vals

        validated = []
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                q = str(item.get("question", "")).strip()

                opts = item.get("options") or item.get("choices")
                if isinstance(opts, dict):
                    opts = [opts[k] for k in sorted(opts.keys())]
                elif isinstance(opts, str):
                    opts = [o.strip() for o in opts.split('\n') if o.strip()]
                elif not isinstance(opts, list):
                    opt_keys = [k for k in item if re.match(r'^(?:option|choice)[\s_]?[a-d1-4]$', k, re.I)]
                    if opt_keys:
                        opts = [item[k] for k in sorted(opt_keys)]

                if not q or not isinstance(opts, list) or len(opts) < 2:
                    continue

                opts_clean = [str(o).strip() for o in opts if str(o).strip()]
                while len(opts_clean) < 4:
                    opts_clean.append(f"Option {len(opts_clean) + 1}")
                opts_clean = opts_clean[:4]

                c_idx = item.get("correct_index")
                if c_idx is not None and isinstance(c_idx, int) and 0 <= c_idx < 4:
                    correct_index = c_idx
                elif "answer" in item or "correct_answer" in item:
                    ans_str = str(item.get("answer") or item.get("correct_answer")).strip()
                    if ans_str in opts_clean:
                        correct_index = opts_clean.index(ans_str)
                    elif ans_str.upper() in ["A", "B", "C", "D"]:
                        correct_index = ["A", "B", "C", "D"].index(ans_str.upper())
                    elif ans_str.isdigit() and 0 <= int(ans_str) < 4:
                        correct_index = int(ans_str)
                    else:
                        correct_index = 0
                else:
                    correct_index = 0

                exp = str(item.get("explanation", "")).strip()
                if not exp:
                    exp = f"The correct answer is {opts_clean[correct_index]}."

                validated.append({
                    "question": q,
                    "options": opts_clean,
                    "correct_index": correct_index,
                    "explanation": exp
                })

        # Fallback 1: Attempt to recover question objects from raw text if validated is empty
        if not validated:
            recovered = extract_partial_questions(text) or extract_partial_questions(extracted)
            if recovered:
                for item in recovered:
                    if not isinstance(item, dict):
                        continue
                    q = str(item.get("question", "")).strip()
                    opts = item.get("options") or item.get("choices")
                    if isinstance(opts, dict):
                        opts = [opts[k] for k in sorted(opts.keys())]
                    if not q or not isinstance(opts, list) or len(opts) < 2:
                        continue
                    opts_clean = [str(o).strip() for o in opts if str(o).strip()]
                    while len(opts_clean) < 4:
                        opts_clean.append(f"Option {len(opts_clean) + 1}")
                    opts_clean = opts_clean[:4]
                    c_idx = item.get("correct_index", 0)
                    if not isinstance(c_idx, int) or not (0 <= c_idx < 4):
                        c_idx = 0
                    exp = str(item.get("explanation", f"The correct answer is {opts_clean[c_idx]}.")).strip()
                    validated.append({
                        "question": q,
                        "options": opts_clean,
                        "correct_index": c_idx,
                        "explanation": exp
                    })

        # Fallback 2: Plaintext / Markdown parser if JSON decoding produced nothing
        if not validated:
            raw = text
            q_blocks = re.split(r'\n(?=(?:[0-9]+\.|\*{0,2}Question\s*[0-9]+[:\.]?\*{0,2}))', '\n' + raw)
            for block in q_blocks:
                block = block.strip()
                if not block:
                    continue
                lines = [l.strip() for l in block.split('\n') if l.strip()]
                if not lines:
                    continue
                q_line = re.sub(r'^(?:[0-9]+\.|\*{0,2}Question\s*[0-9]+[:\.]?\*{0,2})\s*', '', lines[0]).strip()
                opt_matches = []
                exp = ""
                corr = 0
                for l in lines[1:]:
                    m = re.match(r'^(?:[A-Da-d][\.\)]|[\-\*])\s*(.*)$', l)
                    if m:
                        opt_matches.append(m.group(1).strip())
                    elif re.match(r'^(?:Answer|Correct(?:\s*Answer)?)\s*:\s*(.*)$', l, re.I):
                        ans_val = re.sub(r'^(?:Answer|Correct(?:\s*Answer)?)\s*:\s*', '', l, flags=re.I).strip()
                        if ans_val.upper() in ["A", "B", "C", "D"]:
                            corr = ["A", "B", "C", "D"].index(ans_val.upper())
                    elif re.match(r'^(?:Explanation)\s*:\s*(.*)$', l, re.I):
                        exp = re.sub(r'^(?:Explanation)\s*:\s*', '', l, flags=re.I).strip()

                if q_line and len(opt_matches) >= 2:
                    while len(opt_matches) < 4:
                        opt_matches.append(f"Option {len(opt_matches) + 1}")
                    opt_matches = opt_matches[:4]
                    if not exp:
                        exp = f"The correct answer is {opt_matches[corr]}."
                    validated.append({
                        "question": q_line,
                        "options": opt_matches,
                        "correct_index": corr,
                        "explanation": exp
                    })

        if not validated:
            raise ValueError("Could not parse quiz JSON from model response.")

        return validated[:5]