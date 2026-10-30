let currentTab = 'file';
let selectedFile = null;
let currentResultData = null;
let qaHistory = [];
let chatHistory = [];
let currentView = 'document'; // 'document' or 'quiz'

function saveDocToStorage(data) {
  try {
    localStorage.setItem('paperlens_current_doc', JSON.stringify(data));
  } catch (e) {
    console.warn('Could not save document to localStorage:', e);
  }
}

function saveChatToStorage() {
  try {
    localStorage.setItem('paperlens_chat_history', JSON.stringify(chatHistory));
    localStorage.setItem('paperlens_qa_history', JSON.stringify(qaHistory));
  } catch (e) {
    console.warn('Could not save chat to localStorage:', e);
  }
}

function clearSessionStorage() {
  try {
    localStorage.removeItem('paperlens_current_doc');
    localStorage.removeItem('paperlens_chat_history');
    localStorage.removeItem('paperlens_qa_history');
    clearQuizStorage();
  } catch (e) {
    console.warn('Could not clear localStorage:', e);
  }
}

let quizQuestions = [];
let quizCurrentIndex = 0;
let quizBatchScore = 0;
let quizTotalCorrect = 0;
let quizTotalQuestions = 0;
let quizPreviousQuestions = [];
let quizOptionSelected = false;
let quizSelectedOptionIndex = null;

function saveQuizProgress() {
  try {
    if (quizQuestions && quizQuestions.length > 0 && quizCurrentIndex < quizQuestions.length) {
      const state = {
        quizQuestions,
        quizCurrentIndex,
        quizBatchScore,
        quizTotalCorrect,
        quizTotalQuestions,
        quizPreviousQuestions,
        quizOptionSelected,
        quizSelectedOptionIndex,
        activeInQuestionBox: !document.getElementById('quizQuestionBox')?.classList.contains('hidden')
      };
      localStorage.setItem('paperlens_quiz_progress', JSON.stringify(state));
    }
  } catch (e) {
    console.warn('Could not save quiz progress:', e);
  }
}

function clearQuizStorage() {
  try {
    localStorage.removeItem('paperlens_quiz_progress');
  } catch (e) {
    console.warn('Could not clear quiz progress:', e);
  }
}

function getSavedQuizProgress() {
  try {
    const raw = localStorage.getItem('paperlens_quiz_progress');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.quizQuestions) && parsed.quizQuestions.length > 0) {
      return parsed;
    }
  } catch (e) {
    console.warn('Could not parse quiz progress:', e);
  }
  return null;
}

// ─── Tab switching ───
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  hideError();
}

// ─── File drag & drop ───
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

function setFile(file) {
  selectedFile = file;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('filePreview').classList.remove('hidden');
  hideError();
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  document.getElementById('filePreview').classList.add('hidden');
}

// ─── Error helpers ───
function showError(msg, target = 'errorBanner', msgId = 'errorMsg') {
  document.getElementById(msgId).textContent = msg;
  document.getElementById(target).classList.remove('hidden');
}
function hideError(target = 'errorBanner') {
  document.getElementById(target).classList.add('hidden');
}

// CHANGED: turns model text into clean bullets (strips ** and splits lines)
function renderText(el, text) {
  el.innerHTML = '';
  const lines = (text || '').replace(/\*\*/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const bulletRe = /^([-*•]|\d+[.)])\s+/;
  let ul = null;
  lines.forEach(line => {
    if (bulletRe.test(line)) {
      if (!ul) {
        ul = document.createElement('ul');
        ul.style.margin = '0';
        ul.style.paddingLeft = '1.2rem';
        ul.style.listStyle = 'disc';
        el.appendChild(ul);
      }
      const li = document.createElement('li');
      li.textContent = line.replace(bulletRe, '');
      ul.appendChild(li);
    } else {
      ul = null;
      const p = document.createElement('p');
      p.style.margin = '0 0 6px';
      p.textContent = line;
      el.appendChild(p);
    }
  });
}

// ─── Main analyze ───
async function analyze() {
  hideError();
  const btn = document.getElementById('analyzeBtn');
  const btnText = document.getElementById('btnText');
  const spinner = document.getElementById('btnSpinner');

  const formData = new FormData();

  if (currentTab === 'file') {
    if (!selectedFile) { showError('Please select a PDF file to upload.'); return; }
    formData.append('input_type', 'file');
    formData.append('file', selectedFile);
  } else {
    const url = document.getElementById('arxivUrl').value.trim();
    if (!url) { showError('Please enter an arXiv link or paper ID.'); return; }
    formData.append('input_type', 'link');
    formData.append('url', url);
  }

  // Loading state
  btn.disabled = true;
  btnText.textContent = 'Analyzing…';
  spinner.classList.remove('hidden');

  try {
    const res = await fetch('/process', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || 'Something went wrong. Please try again.');
      return;
    }

    if (data.doc_id && data.data && !data.data.doc_id) {
      data.data.doc_id = data.doc_id;
    }
    renderResults(data.data);

  } catch (err) {
    showError('Network error. Make sure the server is running.');
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Analyze Paper';
    spinner.classList.add('hidden');
  }
}

// ─── Render results ───
function renderResults(data, isRestore = false) {
  currentResultData = data;
  saveDocToStorage(data);

  if (!isRestore) {
    chatHistory = [];
    qaHistory = [];
    saveChatToStorage();
    clearQuizStorage();
    quizQuestions = [];
    quizCurrentIndex = 0;
    quizBatchScore = 0;
    quizTotalCorrect = 0;
    quizTotalQuestions = 0;
    quizPreviousQuestions = [];
    quizOptionSelected = false;
    quizSelectedOptionIndex = null;
  }

  const meta = data.metadata || {};
  const isPaper = Boolean(data.is_paper ?? meta.is_paper);

  const resultsHead = document.querySelector('.results-head');
  const cardsGrid = document.querySelector('.cards-grid');
  const abstractBox = document.getElementById('abstractBox');
  const refsSection = document.getElementById('refsSection');

  if (!isPaper) {
    // Hide abstract, cards, and references
    if (abstractBox) abstractBox.classList.add('hidden');
    if (resultsHead) resultsHead.classList.add('hidden');
    if (cardsGrid) cardsGrid.classList.add('hidden');
    if (refsSection) refsSection.classList.add('hidden');

    // Show only the title (file name) and Q&A
    const srcEl = document.getElementById('paperSource');
    if (srcEl) srcEl.textContent = '';
    const authEl = document.getElementById('paperAuthors');
    if (authEl) authEl.textContent = '';
    const titleEl = document.getElementById('paperTitle');
    if (titleEl) titleEl.textContent = (selectedFile ? selectedFile.name : meta.title) || meta.title || 'Untitled';
  } else {
    // Show sections for research papers
    if (resultsHead) resultsHead.classList.remove('hidden');
    if (cardsGrid) cardsGrid.classList.remove('hidden');

    const srcEl = document.getElementById('paperSource');
    if (srcEl) srcEl.textContent = meta.source || '';
    const titleEl = document.getElementById('paperTitle');
    if (titleEl) titleEl.textContent = meta.title || 'Untitled';
    const authEl = document.getElementById('paperAuthors');
    if (authEl) authEl.textContent = meta.authors || '';
    const absEl = document.getElementById('abstractText');
    if (absEl) absEl.textContent = meta.abstract || 'No abstract available.';

    if (!meta.abstract) {
      if (abstractBox) abstractBox.classList.add('hidden');
    } else {
      if (abstractBox) abstractBox.classList.remove('hidden');
    }

    // Result cards
    const keys = ['summary', 'methodology', 'dataset', 'results', 'limitations'];
    keys.forEach(k => {
      const el = document.getElementById(`res-${k}`);
      if (el) renderText(el, data[k] || 'Not found in the paper.');
    });

    // References
    const refsList = document.getElementById('refsList');
    if (refsList) {
      refsList.innerHTML = '';
      const refs = meta.references || [];
      if (refs.length === 0) {
        if (refsSection) refsSection.classList.add('hidden');
      } else {
        if (refsSection) refsSection.classList.remove('hidden');
        refs.forEach((ref, i) => {
          const li = document.createElement('li');
          li.textContent = `[${i + 1}] ${ref}`;
          refsList.appendChild(li);
        });
      }
    }
  }

  // Render chat thread
  renderChatThread(!isRestore);

  document.getElementById('landingSection')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.add('hidden');
  document.getElementById('quizSection')?.classList.add('hidden');
  document.getElementById('resultsSection')?.classList.remove('hidden');
  document.getElementById('headerNav')?.classList.remove('hidden');

  currentView = 'document';
  updateHeaderNavButtons();

  if (!isRestore) {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#document');
    } else {
      window.location.hash = 'document';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ─── Chat Thread Helpers ───
function scrollChatToBottom(smooth = true) {
  const thread = document.getElementById('chatThread');
  if (!thread) return;
  setTimeout(() => {
    if (smooth) {
      thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
  }, 10);
}

function renderChatThread(shouldScroll = true) {
  const thread = document.getElementById('chatThread');
  const clearBtn = document.getElementById('clearChatBtn');
  if (!thread) return;

  if (!chatHistory || chatHistory.length === 0) {
    thread.innerHTML = `
      <div class="chat-empty" id="chatEmpty">
        <p>Ask anything about this document to start the conversation.</p>
      </div>
    `;
    if (clearBtn) clearBtn.classList.add('hidden');
    return;
  }

  if (clearBtn) clearBtn.classList.remove('hidden');
  thread.innerHTML = '';

  let assistantCount = 0;
  chatHistory.forEach(msg => {
    if (msg.role === 'user') {
      const row = document.createElement('div');
      row.className = 'chat-row chat-row-user';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble-user';
      bubble.textContent = msg.content;
      row.appendChild(bubble);
      thread.appendChild(row);
    } else {
      assistantCount++;
      const ansId = `chatAnswer_${assistantCount}`;
      const row = document.createElement('div');
      row.className = 'chat-row chat-row-assistant';

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble-assistant';

      const head = document.createElement('div');
      head.className = 'chat-bubble-head';

      const sender = document.createElement('span');
      sender.className = 'chat-bubble-sender';
      sender.textContent = 'Answer';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn chat-copy-btn';
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = function() { copyCard(ansId, this); };

      head.appendChild(sender);
      head.appendChild(copyBtn);

      const textEl = document.createElement('div');
      textEl.className = 'chat-bubble-text';
      textEl.id = ansId;
      renderText(textEl, msg.content);

      bubble.appendChild(head);
      bubble.appendChild(textEl);
      row.appendChild(bubble);
      thread.appendChild(row);
    }
  });

  if (shouldScroll) {
    scrollChatToBottom(false);
  }
}

function showThinkingBubble() {
  const thread = document.getElementById('chatThread');
  if (!thread) return;

  const existing = document.getElementById('thinkingRow');
  if (existing) existing.remove();

  const empty = document.getElementById('chatEmpty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'chat-row chat-row-assistant';
  row.id = 'thinkingRow';
  row.innerHTML = `
    <div class="chat-bubble-thinking">
      <span>Thinking</span>
      <span class="thinking-dots">
        <span></span><span></span><span></span>
      </span>
    </div>
  `;
  thread.appendChild(row);
  scrollChatToBottom(true);
}

function removeThinkingBubble() {
  const row = document.getElementById('thinkingRow');
  if (row) row.remove();
}

function clearChat() {
  chatHistory = [];
  qaHistory = [];
  saveChatToStorage();
  renderChatThread(false);
  hideError('qaError');
}

function handleQaKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askQuestion();
  }
}

// ─── Q&A ───
async function askQuestion() {
  hideError('qaError');
  const docId = currentResultData?.doc_id || currentResultData?.metadata?.doc_id;
  if (!docId) {
    alert("This document expired. Please upload it again.");
    resetApp();
    return;
  }

  const input = document.getElementById('qaInput');
  if (!input) return;
  const question = input.value.trim();
  if (!question) return;

  // Clear input immediately upon sending
  input.value = '';

  const btn = document.getElementById('qaBtn');
  if (btn) btn.disabled = true;

  const thread = document.getElementById('chatThread');
  const empty = document.getElementById('chatEmpty');
  if (empty) empty.remove();

  const clearBtn = document.getElementById('clearChatBtn');
  if (clearBtn) clearBtn.classList.remove('hidden');

  // Append user bubble to thread
  const userRow = document.createElement('div');
  userRow.className = 'chat-row chat-row-user';
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble-user';
  userBubble.textContent = question;
  userRow.appendChild(userBubble);
  thread.appendChild(userRow);

  // Show thinking bubble
  showThinkingBubble();

  // Send the last ~6 messages as context
  const historyToSend = chatHistory.slice(-6);

  try {
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId, question, chat_history: historyToSend })
    });
    const data = await res.json();

    removeThinkingBubble();

    if (!res.ok || data.error) {
      if (res.status === 404 || data.expired) {
        alert("This document expired. Please upload it again.");
        resetApp();
        return;
      }
      showError(data.error || 'Could not get an answer. Try again.', 'qaError', 'qaErrorMsg');
      return;
    }

    // Save to conversation histories
    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: data.answer });
    qaHistory.push({ question: question, answer: data.answer });
    saveChatToStorage();

    // Render assistant answer bubble
    const assistantCount = chatHistory.filter(m => m.role === 'assistant').length;
    const ansId = `chatAnswer_${assistantCount}`;

    const ansRow = document.createElement('div');
    ansRow.className = 'chat-row chat-row-assistant';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble-assistant';

    const head = document.createElement('div');
    head.className = 'chat-bubble-head';

    const sender = document.createElement('span');
    sender.className = 'chat-bubble-sender';
    sender.textContent = 'Answer';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn chat-copy-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = function() { copyCard(ansId, this); };

    head.appendChild(sender);
    head.appendChild(copyBtn);

    const textEl = document.createElement('div');
    textEl.className = 'chat-bubble-text';
    textEl.id = ansId;
    renderText(textEl, data.answer);

    bubble.appendChild(head);
    bubble.appendChild(textEl);
    ansRow.appendChild(bubble);
    thread.appendChild(ansRow);

    scrollChatToBottom(true);

  } catch (err) {
    removeThinkingBubble();
    showError('Could not get an answer. Try again.', 'qaError', 'qaErrorMsg');
  } finally {
    if (btn) btn.disabled = false;
    input.focus();
  }
}

// ─── Enter key on Q&A input ───
document.getElementById('qaInput')?.addEventListener('keydown', handleQaKey);

// ─── Copy helper ───
async function copyCard(targetId, btn) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const text = (el.innerText || el.textContent || '').trim();
  if (!text || text === '—') return;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    btn._copyTimeout = setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
      btn._copyTimeout = null;
    }, 1500);
  } catch (err) {
    console.error('Copy failed:', err);
  }
}

// ─── Download PDF ───
async function downloadPdf() {
  const btn = document.getElementById('downloadPdfBtn');
  const originalText = btn ? btn.textContent : 'Download PDF';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
  }

  try {
    const title = document.getElementById('paperTitle').textContent || (currentResultData?.metadata?.title) || 'Document';
    const payload = {
      title: title,
      authors: currentResultData?.metadata?.authors || '',
      abstract: currentResultData?.metadata?.abstract || '',
      summary: currentResultData?.summary || '',
      methodology: currentResultData?.methodology || '',
      dataset: currentResultData?.dataset || '',
      results: currentResultData?.results || '',
      limitations: currentResultData?.limitations || '',
      is_paper: Boolean(currentResultData?.is_paper ?? currentResultData?.metadata?.is_paper),
      qa_history: qaHistory
    };

    const res = await fetch('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error('Failed to generate PDF');
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'document'}_analysis.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Download PDF failed:', err);
    alert('Could not generate PDF. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

// ─── Header Navigation Buttons State ───
function updateHeaderNavButtons() {
  const quizBtn = document.getElementById('headerQuizBtn');
  const quizText = document.getElementById('headerQuizBtnText');
  const quizIcon = document.getElementById('headerQuizIcon');

  if (currentView === 'quiz') {
    if (quizBtn) {
      quizBtn.classList.add('active');
      quizBtn.title = 'Back to document';
    }
    if (quizText) quizText.textContent = 'Back to document';
    if (quizIcon) {
      quizIcon.innerHTML = '<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>';
    }
  } else {
    if (quizBtn) {
      quizBtn.classList.remove('active');
      quizBtn.title = 'Take Quiz';
    }
    if (quizText) quizText.textContent = 'Take Quiz';
    if (quizIcon) {
      quizIcon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>';
    }
  }
}

// ─── Separate View Switching (Document ↔ Quiz) ───
function openQuizView(updateHash = true) {
  if (!currentResultData) return;
  currentView = 'quiz';

  document.getElementById('resultsSection')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.add('hidden');
  document.getElementById('landingSection')?.classList.add('hidden');
  document.getElementById('quizSection')?.classList.remove('hidden');
  document.getElementById('headerNav')?.classList.remove('hidden');

  updateHeaderNavButtons();

  if (updateHash && window.location.hash !== '#quiz') {
    window.location.hash = 'quiz';
  }

  // Setup quiz view state
  const saved = getSavedQuizProgress();
  const isMidQuiz = quizQuestions && quizQuestions.length > 0 && quizCurrentIndex < quizQuestions.length;

  if (isMidQuiz && !document.getElementById('quizQuestionBox')?.classList.contains('hidden')) {
    document.getElementById('quizStartBox')?.classList.add('hidden');
    document.getElementById('quizResultBox')?.classList.add('hidden');
    document.getElementById('quizQuestionBox')?.classList.remove('hidden');
    document.getElementById('exitQuizBtn')?.classList.remove('hidden');
    renderQuizQuestion();
    if (quizOptionSelected && quizSelectedOptionIndex !== null) {
      applySelectedOptionUI(quizSelectedOptionIndex);
    }
  } else if (saved) {
    document.getElementById('quizQuestionBox')?.classList.add('hidden');
    document.getElementById('quizResultBox')?.classList.add('hidden');
    document.getElementById('quizStartBox')?.classList.remove('hidden');
    document.getElementById('quizFreshStart')?.classList.add('hidden');
    document.getElementById('quizResumeBox')?.classList.remove('hidden');
    document.getElementById('exitQuizBtn')?.classList.add('hidden');

    const resumeMeta = document.getElementById('quizResumeMeta');
    if (resumeMeta) {
      const qNum = saved.quizCurrentIndex + 1;
      const total = saved.quizQuestions.length;
      resumeMeta.textContent = `You have an unfinished quiz in progress (Question ${qNum} of ${total}).`;
    }
  } else {
    // Fresh start
    document.getElementById('quizQuestionBox')?.classList.add('hidden');
    document.getElementById('quizResultBox')?.classList.add('hidden');
    document.getElementById('quizStartBox')?.classList.remove('hidden');
    document.getElementById('quizFreshStart')?.classList.remove('hidden');
    document.getElementById('quizResumeBox')?.classList.add('hidden');
    document.getElementById('exitQuizBtn')?.classList.add('hidden');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToDocumentView(updateHash = true) {
  currentView = 'document';

  document.getElementById('quizSection')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.add('hidden');
  document.getElementById('landingSection')?.classList.add('hidden');
  document.getElementById('resultsSection')?.classList.remove('hidden');
  document.getElementById('headerNav')?.classList.remove('hidden');

  updateHeaderNavButtons();

  if (updateHash && window.location.hash !== '#document') {
    window.location.hash = 'document';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleHeaderQuiz() {
  if (currentView === 'quiz') {
    handleQuizBack();
  } else {
    openQuizView(true);
  }
}

function handleHeaderAsk() {
  if (currentView === 'quiz') {
    saveQuizProgress();
    goToDocumentView(true);
    setTimeout(() => {
      scrollToSection('ask-section');
    }, 80);
  } else {
    scrollToSection('ask-section');
  }
}

function handleQuizBack() {
  const isQuizInProgress = quizQuestions && quizQuestions.length > 0 && quizCurrentIndex < quizQuestions.length && !document.getElementById('quizQuestionBox')?.classList.contains('hidden');
  if (isQuizInProgress) {
    promptExitQuiz();
  } else {
    goToDocumentView(true);
  }
}

// ─── Exit Modal ───
function promptExitQuiz() {
  saveQuizProgress();
  const modal = document.getElementById('exitQuizModal');
  if (modal) modal.classList.remove('hidden');
}

function closeExitModal() {
  const modal = document.getElementById('exitQuizModal');
  if (modal) modal.classList.add('hidden');
}

function confirmExitQuiz() {
  closeExitModal();
  saveQuizProgress();
  goToDocumentView(true);
}

function handleModalBackdropClick(e) {
  if (e.target.id === 'exitQuizModal') {
    closeExitModal();
  }
}

// ─── Resume & Start Over ───
function resumeQuiz() {
  const saved = getSavedQuizProgress();
  if (!saved) {
    startQuiz();
    return;
  }

  quizQuestions = saved.quizQuestions;
  quizCurrentIndex = saved.quizCurrentIndex;
  quizBatchScore = saved.quizBatchScore;
  quizTotalCorrect = saved.quizTotalCorrect;
  quizTotalQuestions = saved.quizTotalQuestions;
  quizPreviousQuestions = saved.quizPreviousQuestions || [];
  quizOptionSelected = saved.quizOptionSelected || false;
  quizSelectedOptionIndex = saved.quizSelectedOptionIndex ?? null;

  document.getElementById('quizStartBox')?.classList.add('hidden');
  document.getElementById('quizResultBox')?.classList.add('hidden');
  document.getElementById('quizQuestionBox')?.classList.remove('hidden');
  document.getElementById('exitQuizBtn')?.classList.remove('hidden');

  renderQuizQuestion();
  if (quizOptionSelected && quizSelectedOptionIndex !== null) {
    applySelectedOptionUI(quizSelectedOptionIndex);
  }
  saveQuizProgress();
}

function startOverQuiz() {
  clearQuizStorage();
  quizQuestions = [];
  quizCurrentIndex = 0;
  quizBatchScore = 0;
  quizTotalCorrect = 0;
  quizTotalQuestions = 0;
  quizPreviousQuestions = [];
  quizOptionSelected = false;
  quizSelectedOptionIndex = null;
  startQuiz();
}

// ─── Quiz Execution ───
async function fetchQuizBatch(isMore = false) {
  const docId = currentResultData?.doc_id || currentResultData?.metadata?.doc_id;
  if (!docId) {
    alert("This document expired. Please upload it again.");
    resetApp();
    return;
  }

  const btn = isMore ? document.getElementById('moreQuestionsBtn') : document.getElementById('startQuizBtn');
  const btnText = isMore ? document.getElementById('moreQuestionsBtnText') : document.getElementById('startQuizBtnText');
  const spinner = isMore ? document.getElementById('moreQuizSpinner') : document.getElementById('quizSpinner');
  const originalText = isMore ? '5 more questions' : 'Start quiz';

  hideError('quizError');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = isMore ? 'Loading 5 more…' : 'Generating quiz…';
  if (spinner) spinner.classList.remove('hidden');

  try {
    const res = await fetch('/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId, previous_questions: quizPreviousQuestions })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      if (res.status === 404 || data.expired) {
        alert("This document expired. Please upload it again.");
        resetApp();
        return;
      }
      showError(data.error || 'Could not generate quiz. Please try again.', 'quizError', 'quizErrorMsg');
      return;
    }

    if (!data.questions || !data.questions.length) {
      showError('No questions could be generated from this document.', 'quizError', 'quizErrorMsg');
      return;
    }

    quizQuestions = data.questions;
    quizQuestions.forEach(q => {
      if (q.question && !quizPreviousQuestions.includes(q.question)) {
        quizPreviousQuestions.push(q.question);
      }
    });

    quizCurrentIndex = 0;
    quizBatchScore = 0;
    quizOptionSelected = false;
    quizSelectedOptionIndex = null;

    document.getElementById('quizStartBox').classList.add('hidden');
    document.getElementById('quizResultBox').classList.add('hidden');
    document.getElementById('quizQuestionBox').classList.remove('hidden');
    document.getElementById('exitQuizBtn')?.classList.remove('hidden');

    renderQuizQuestion();
    saveQuizProgress();

  } catch (err) {
    showError('Network error while generating quiz. Please try again.', 'quizError', 'quizErrorMsg');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = originalText;
    if (spinner) spinner.classList.add('hidden');
  }
}

function startQuiz() {
  fetchQuizBatch(false);
}

function fetchMoreQuestions() {
  fetchQuizBatch(true);
}

function renderQuizQuestion() {
  if (quizCurrentIndex >= quizQuestions.length) {
    showQuizResults();
    return;
  }

  const q = quizQuestions[quizCurrentIndex];

  document.getElementById('quizProgress').textContent = `Question ${quizCurrentIndex + 1} of ${quizQuestions.length}`;
  const liveScoreEl = document.getElementById('quizLiveScore');
  if (quizTotalQuestions > 0) {
    liveScoreEl.textContent = `Total score: ${quizTotalCorrect}/${quizTotalQuestions}`;
  } else {
    liveScoreEl.textContent = '';
  }

  document.getElementById('quizQuestionText').textContent = q.question;

  const grid = document.getElementById('quizOptionsGrid');
  grid.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

  q.options.forEach((optText, idx) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-option';
    btn.type = 'button';
    btn.onclick = () => selectQuizOption(idx);

    const letter = document.createElement('span');
    letter.className = 'quiz-opt-letter';
    letter.textContent = letters[idx] || '';

    const text = document.createElement('span');
    text.className = 'quiz-opt-text';
    text.textContent = optText;

    btn.appendChild(letter);
    btn.appendChild(text);
    grid.appendChild(btn);
  });

  const nextBtn = document.getElementById('quizNextBtn');
  if (quizCurrentIndex === quizQuestions.length - 1) {
    nextBtn.textContent = 'See results →';
  } else {
    nextBtn.textContent = 'Next →';
  }

  if (quizOptionSelected && quizSelectedOptionIndex !== null) {
    applySelectedOptionUI(quizSelectedOptionIndex);
  } else {
    document.getElementById('quizExplanation').classList.add('hidden');
    document.getElementById('quizActions').classList.add('hidden');
  }
}

function applySelectedOptionUI(selectedIndex) {
  const q = quizQuestions[quizCurrentIndex];
  if (!q) return;
  const options = document.querySelectorAll('.quiz-option');
  options.forEach(opt => opt.disabled = true);

  if (selectedIndex === q.correct_index) {
    if (options[selectedIndex]) {
      options[selectedIndex].classList.add('correct');
    }
  } else {
    if (options[selectedIndex]) {
      options[selectedIndex].classList.add('wrong');
    }
    if (options[q.correct_index]) {
      options[q.correct_index].classList.add('correct');
    }
  }

  document.getElementById('quizExplanationText').textContent = q.explanation || `The correct answer is ${q.options[q.correct_index]}.`;
  document.getElementById('quizExplanation').classList.remove('hidden');
  document.getElementById('quizActions').classList.remove('hidden');
}

function selectQuizOption(selectedIndex) {
  if (quizOptionSelected) return;
  quizOptionSelected = true;
  quizSelectedOptionIndex = selectedIndex;

  const q = quizQuestions[quizCurrentIndex];
  quizTotalQuestions++;
  if (selectedIndex === q.correct_index) {
    quizBatchScore++;
    quizTotalCorrect++;
  }

  applySelectedOptionUI(selectedIndex);

  const liveScoreEl = document.getElementById('quizLiveScore');
  liveScoreEl.textContent = `Total score: ${quizTotalCorrect}/${quizTotalQuestions}`;

  saveQuizProgress();
}

function nextQuizQuestion() {
  quizCurrentIndex++;
  quizOptionSelected = false;
  quizSelectedOptionIndex = null;
  if (quizCurrentIndex < quizQuestions.length) {
    renderQuizQuestion();
    saveQuizProgress();
  } else {
    showQuizResults();
  }
}

function showQuizResults() {
  // Clear saved quiz state as soon as the final result is shown
  clearQuizStorage();
  quizQuestions = [];

  document.getElementById('quizQuestionBox').classList.add('hidden');
  document.getElementById('quizResultBox').classList.remove('hidden');
  document.getElementById('exitQuizBtn')?.classList.add('hidden');

  document.getElementById('quizBatchScore').textContent = `Score: ${quizBatchScore}/5`;

  const pct = quizTotalQuestions > 0 ? Math.round((quizTotalCorrect / quizTotalQuestions) * 100) : 0;
  document.getElementById('quizRunningTotal').textContent = `Running total: ${quizTotalCorrect}/${quizTotalQuestions} (${pct}%)`;

  let levelTitle = '';
  let levelDesc = '';
  const levelCard = document.getElementById('quizLevelCard');

  if (pct >= 80) {
    levelTitle = '80%+ · Strong understanding';
    levelDesc = 'You have a strong understanding of the concepts and can apply your knowledge with confidence.';
    levelCard.style.borderLeftColor = '#16A34A';
  } else if (pct >= 50) {
    levelTitle = '50–79% · Fair understanding';
    levelDesc = 'You have a fair understanding of the concepts, but some areas need more practice and revision.';
    levelCard.style.borderLeftColor = '#2C6BED';
  } else {
    levelTitle = 'Below 50% · Needs revision';
    levelDesc = 'You may need to revisit the key concepts and spend more time strengthening your understanding.';
    levelCard.style.borderLeftColor = '#DC2626';
  }

  document.getElementById('quizLevelTitle').textContent = levelTitle;
  document.getElementById('quizLevelDesc').textContent = levelDesc;
}

// ─── Reset ───
function resetApp() {
  const oldDocId = currentResultData?.doc_id || currentResultData?.metadata?.doc_id;
  if (oldDocId) {
    try {
      fetch('/delete-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: oldDocId })
      });
    } catch (e) {
      console.warn('Could not delete old doc on server:', e);
    }
  }

  clearSessionStorage();
  clearQuizStorage();
  currentResultData = null;
  qaHistory = [];
  chatHistory = [];
  currentView = 'document';
  renderChatThread(false);

  // Reset quiz
  quizQuestions = [];
  quizCurrentIndex = 0;
  quizBatchScore = 0;
  quizTotalCorrect = 0;
  quizTotalQuestions = 0;
  quizPreviousQuestions = [];
  quizOptionSelected = false;
  quizSelectedOptionIndex = null;

  document.getElementById('quizQuestionBox')?.classList.add('hidden');
  document.getElementById('quizResultBox')?.classList.add('hidden');
  document.getElementById('quizStartBox')?.classList.remove('hidden');
  document.getElementById('quizFreshStart')?.classList.remove('hidden');
  document.getElementById('quizResumeBox')?.classList.add('hidden');
  document.getElementById('quizExplanation')?.classList.add('hidden');
  document.getElementById('quizActions')?.classList.add('hidden');
  document.getElementById('exitQuizBtn')?.classList.add('hidden');
  closeExitModal();
  hideError('quizError');

  const startBtn = document.getElementById('startQuizBtn');
  if (startBtn) startBtn.disabled = false;
  const startText = document.getElementById('startQuizBtnText');
  if (startText) startText.textContent = 'Start quiz';
  const startSpin = document.getElementById('quizSpinner');
  if (startSpin) startSpin.classList.add('hidden');
  const moreBtn = document.getElementById('moreQuestionsBtn');
  if (moreBtn) moreBtn.disabled = false;
  const moreText = document.getElementById('moreQuestionsBtnText');
  if (moreText) moreText.textContent = '5 more questions';
  const moreSpin = document.getElementById('moreQuizSpinner');
  if (moreSpin) moreSpin.classList.add('hidden');

  document.getElementById('quizSection')?.classList.add('hidden');
  document.getElementById('resultsSection')?.classList.add('hidden');
  document.getElementById('headerNav')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.remove('hidden');
  clearFile();
  const arxivInput = document.getElementById('arxivUrl');
  if (arxivInput) arxivInput.value = '';
  const qaInput = document.getElementById('qaInput');
  if (qaInput) qaInput.value = '';
  hideError();
  hideError('qaError');

  // Show the hidden sections again
  document.getElementById('abstractBox')?.classList.remove('hidden');
  document.querySelector('.results-head')?.classList.remove('hidden');
  document.querySelector('.cards-grid')?.classList.remove('hidden');
  document.getElementById('refsSection')?.classList.remove('hidden');

  // Reset copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    btn.textContent = 'Copy';
    btn.classList.remove('copied');
  });

  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', (window.location.pathname || '') + (window.location.search || ''));
  } else {
    window.location.hash = '';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Landing ↔ Upload navigation ───
function startAnalysis() {
  document.getElementById('landingSection')?.classList.add('hidden');
  document.getElementById('quizSection')?.classList.add('hidden');
  document.getElementById('resultsSection')?.classList.add('hidden');
  document.getElementById('headerNav')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goHome() {
  clearSessionStorage();
  clearQuizStorage();
  quizQuestions = [];
  quizCurrentIndex = 0;
  quizBatchScore = 0;
  quizTotalCorrect = 0;
  quizTotalQuestions = 0;
  quizPreviousQuestions = [];
  quizOptionSelected = false;
  quizSelectedOptionIndex = null;
  currentView = 'document';
  closeExitModal();

  document.getElementById('quizSection')?.classList.add('hidden');
  document.getElementById('inputSection')?.classList.add('hidden');
  document.getElementById('resultsSection')?.classList.add('hidden');
  document.getElementById('headerNav')?.classList.add('hidden');
  document.getElementById('landingSection')?.classList.remove('hidden');

  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', (window.location.pathname || '') + (window.location.search || ''));
  } else {
    window.location.hash = '';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Header Navigation Scroll ───
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' });
  }
}

// ─── Hash Navigation (Back / Forward button support) ───
window.addEventListener('hashchange', () => {
  if (!currentResultData) return;
  const hash = window.location.hash;
  if (hash === '#quiz' && currentView !== 'quiz') {
    openQuizView(false);
  } else if ((hash === '#document' || !hash) && currentView !== 'document') {
    goToDocumentView(false);
  }
});

// ─── Session Restoration on Page Refresh ───
function initSessionRestore() {
  try {
    const savedDoc = localStorage.getItem('paperlens_current_doc');
    if (!savedDoc) return;
    const docData = JSON.parse(savedDoc);
    if (!docData) return;

    const savedChat = localStorage.getItem('paperlens_chat_history');
    if (savedChat) {
      chatHistory = JSON.parse(savedChat) || [];
    }
    const savedQa = localStorage.getItem('paperlens_qa_history');
    if (savedQa) {
      qaHistory = JSON.parse(savedQa) || [];
    }

    renderResults(docData, true);

    const hash = window.location.hash;
    if (hash === '#quiz') {
      const savedQuiz = getSavedQuizProgress();
      if (savedQuiz) {
        quizQuestions = savedQuiz.quizQuestions;
        quizCurrentIndex = savedQuiz.quizCurrentIndex;
        quizBatchScore = savedQuiz.quizBatchScore;
        quizTotalCorrect = savedQuiz.quizTotalCorrect;
        quizTotalQuestions = savedQuiz.quizTotalQuestions;
        quizPreviousQuestions = savedQuiz.quizPreviousQuestions || [];
        quizOptionSelected = savedQuiz.quizOptionSelected || false;
        quizSelectedOptionIndex = savedQuiz.quizSelectedOptionIndex ?? null;

        openQuizView(false);

        // If quiz was active in question box when refreshed, restore the question directly
        if (savedQuiz.activeInQuestionBox && quizQuestions.length > 0 && quizCurrentIndex < quizQuestions.length) {
          document.getElementById('quizStartBox')?.classList.add('hidden');
          document.getElementById('quizResultBox')?.classList.add('hidden');
          document.getElementById('quizQuestionBox')?.classList.remove('hidden');
          document.getElementById('exitQuizBtn')?.classList.remove('hidden');
          renderQuizQuestion();
          if (quizOptionSelected && quizSelectedOptionIndex !== null) {
            applySelectedOptionUI(quizSelectedOptionIndex);
          }
        }
      } else {
        openQuizView(false);
      }
    } else {
      goToDocumentView(false);
      if (!hash && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#document');
      }
    }
  } catch (e) {
    console.warn('Failed to restore session from localStorage:', e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSessionRestore);
} else {
  initSessionRestore();
}