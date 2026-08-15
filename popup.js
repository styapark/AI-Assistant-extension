// popup.js
let isServerOnline = false;

document.addEventListener('DOMContentLoaded', async () => {
  // get manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('name').innerText = manifest.name;
  document.getElementById('version').innerText = `v${manifest.version}`;

  const statusBadge = document.getElementById('statusBadge');

  // Tab switcher
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // Quick Action Buttons
  const btnPageAudit = document.getElementById('btnPageAudit');
  const btnXssCheck = document.getElementById('btnXssCheck');
  const btnFormAudit = document.getElementById('btnFormAudit');
  const btnSecHeaders = document.getElementById('btnSecHeaders');

  // User UX
  const userPromptInput = document.getElementById('userPrompt');
  const responseOutput = document.getElementById('responseOutput');
  const btnSend = document.getElementById('btnSend');
  const btnCancel = document.getElementById('btnCancel');
  const btnClear = document.getElementById('btnClear');
  const btnDownloadTxt = document.getElementById('btnDownloadTxt');
  const btnDownloadJson = document.getElementById('btnDownloadJson');

  // Settings
  const baseUrlInput = document.getElementById('baseUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const modelNameInput = document.getElementById('modelName');
  const btnFetchModels = document.getElementById('btnFetchModels');
  const systemPromptInput = document.getElementById('systemPrompt');
  const tempInput = document.getElementById('temperature');
  const tempVal = document.getElementById('tempVal');
  const btnSaveSettings = document.getElementById('btnSaveSettings');


  // Load awal
  const data = await chrome.storage.local.get({
    draftPrompt: '',
    lastPrompt: '',
    stampLastPrompt: 0,
    stampFirstThinking: 0,
    firstResponse: '',
    stampFirstResponse: 0,
    lastResponse: '',
    stampLastResponse: 0,
    currentResponse: 'Silakan pilih aksi atau ketik prompt di atas...',
    baseUrl: 'http://localhost:8001/v1',
    apiKey: 'lm-studio',
    isGenerating: false,
    modelName: 'qwen2.5-coder-7b-instruct',
    systemPrompt: 'Anda adalah pakar Application Security & Code Reviewer senior. Analisis input web page/code dan berikan temuan kerentanan, PoC payload, dan solusi remediasi secara terstruktur. Jangan membahas selain security software, selain itu jawab "jawaban tidak tersedia".',
    temperature: 0.2,
    chatLogs: []
  });

  // get data settings
  baseUrlInput.value = data.baseUrl;
  apiKeyInput.value = data.apiKey;
  modelNameInput.value = data.modelName;
  systemPromptInput.value = data.systemPrompt;
  tempInput.value = data.temperature;
  tempVal.innerText = data.temperature;

  updateButtonStates(data.isGenerating);

  // Fungsi pengatur status tombol
  function updateButtonStates(isGenerating) {
    if (isGenerating) {
      // Saat AI sedang menjawab: matikan Send, aktifkan Batal (Warna Merah)
      btnSend.disabled = true;
      btnCancel.disabled = false;
      btnCancel.className = 'btn btn-danger';
    } else {
      // Saat AI idle / selesai: aktifkan Send, matikan Batal (Warna Abu-abu)
      btnSend.disabled = false;
      btnCancel.disabled = true;
      btnCancel.className = 'btn btn-secondary';
    }
  }

  userPromptInput.value = data.draftPrompt;
  responseOutput.innerText = data.currentResponse;

  // Cek Status Koneksi LM Studio secara Asynchronous
  async function checkHealth() {
    try {
      const res = await fetch(`${data.baseUrl}/models`, {
        headers: data.apiKey ? { 'Authorization': `Bearer ${data.apiKey}` } : {}
      });
      if (res.ok) {
        statusBadge.className = 'status-badge status-online';
        statusBadge.innerText = 'Online';
        isServerOnline = true;
      } else {
        statusBadge.className = 'status-badge status-offline';
        statusBadge.innerText = `HTTP ${res.status}`;
        isServerOnline = false;
      }
    } catch (e) {
      statusBadge.className = 'status-badge status-offline';
      statusBadge.innerText = 'Offline';
      isServerOnline = false;
    }
  }
  checkHealth();

  // Dengarkan Perubahan Storage (Gunakan RequestAnimationFrame)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.isGenerating) {
        updateButtonStates(changes.isGenerating.newValue);
      }
      if (changes.currentResponse) {
        requestAnimationFrame(() => {
          responseOutput.innerText = changes.currentResponse.newValue;
          responseOutput.scrollTop = responseOutput.scrollHeight;
        });
      }
    }
  });

  // Autosave Draft
  userPromptInput.addEventListener('input', () => {
    chrome.storage.local.set({ draftPrompt: userPromptInput.value });
  });

  // Tombol Hapus
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      userPromptInput.value = ''; // 1. Kosongkan teks di textarea
      chrome.storage.local.remove('draftPrompt'); // 2. Hapus draft di storage local
      userPromptInput.focus(); // 3. Fokuskan kembali kursor ke textarea
    });
  }

  // Tombol Batal
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      // Kirim pesan ke background.js untuk menghentikan fetch/stream
      chrome.runtime.sendMessage({ type: 'STOP_GENERATE' });
    });
  }

  // Tombol Kirim Prompt
  if (btnSend) {
    btnSend.addEventListener('click', () => {
      const text = userPromptInput.value.trim();
      if (text) {
        handleSendPrompt(text);
      }
    });
  }

  // DOM Extractor
  async function getActivePageDOM() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { url: '', content: '' };
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: window.location.href,
          title: document.title,
          htmlSnippet: document.body.innerText.substring(0, 3000),
          formsCount: document.forms.length
        })
      });
      return result;
    } catch (e) {
      return { url: tab.url || '', htmlSnippet: '' };
    }
  }

  // Event Listeners Quick Actions
  if (btnPageAudit) {
    btnPageAudit.addEventListener('click', async () => {
        const page = await getActivePageDOM();
        const prompt = `Analisis potensi celah keamanan pada halaman web berikut:\nURL: ${page.url}\nTitle: ${page.title}\n\nTeks Halaman:\n${page.htmlSnippet}\n\nBerikan rangkuman analisis risk assessment dan potensi kerentanan.`;
        userPromptInput.value = prompt;
        chrome.storage.local.set({ draftPrompt: prompt });
        handleSendPrompt(prompt);
      });
  }
  if (btnXssCheck) {
    btnXssCheck.addEventListener('click', async () => {
        const page = await getActivePageDOM();
        const prompt = `Buatkan 5 payload Cross-Site Scripting (XSS) kustom yang kontekstual untuk menguji halaman ini:\nURL: ${page.url}\nKonten: ${page.htmlSnippet}`;
        userPromptInput.value = prompt;
        chrome.storage.local.set({ draftPrompt: prompt });
        handleSendPrompt(prompt);
      });
  }
  if (btnFormAudit) {
    btnFormAudit.addEventListener('click', async () => {
      const page = await getActivePageDOM();
      const prompt = `Halaman ini memiliki ${page.formsCount} elemen form. Jelaskan skenario pengujian pentest (SQLi, CSRF, IDOR) untuk halaman ${page.url}.`;
      userPromptInput.value = prompt;
      chrome.storage.local.set({ draftPrompt: prompt });
      handleSendPrompt(prompt);
    });
  }
  if (btnSecHeaders) {
    btnSecHeaders.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const prompt = `Jelaskan daftar Security Headers standar (CSP, HSTS, X-Frame-Options) yang wajib diuji pada URL: ${tab ? tab.url : 'target web'}`;
      userPromptInput.value = prompt;
      chrome.storage.local.set({ draftPrompt: prompt });
      handleSendPrompt(prompt);
    });
  }

  // Fungsi aman untuk mengirim prompt
  async function handleSendPrompt(text) {
    if (!text) return;

    // 1. CEK DULU: Jika server Offline, cegah pengiriman & tampilkan error instant
    if (!isServerOnline) {
      const errorMsg = '❌ Failed: Server LM Studio sedang Offline. Pastikan LM Studio berjalan di port 8001 dan CORS diaktifkan!';
      responseOutput.innerText = errorMsg;
      await chrome.storage.local.set({ currentResponse: errorMsg, isGenerating: false });
      return;
    }

    // 2. Jika Online, set status loading awal
    const loadingMsg = '⏳ Connecting to AI engine...';
    responseOutput.innerText = loadingMsg;
    await chrome.storage.local.set({ currentResponse: loadingMsg, isGenerating: true, lastPrompt: text, stampLastPrompt: Date.now() });

    // 3. Kirim ke background.js
    chrome.runtime.sendMessage({
      type: 'START_GENERATE',
      promptText: text
    });
  }

  // Export Log ke Downloads
  function safeDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    chrome.downloads.download({
      url: blobUrl,
      filename: `LMStudio_Logs/${filename}`,
      saveAs: false
    }, () => {
      if (chrome.runtime.lastError) {
        alert('Gagal menyimpan file: ' + chrome.runtime.lastError.message);
      } else {
        console.log('File log berhasil disimpan ke folder Downloads, ID:', downloadId);
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    });
  }

  if (btnDownloadTxt) {
    btnDownloadTxt.addEventListener('click', async () => {
      const st = await chrome.storage.local.get(['currentResponse', 'draftPrompt']);
      const { chatLogs = [] } = await chrome.storage.local.get(['chatLogs']);
      if (!st.currentResponse || st.currentResponse.startsWith('⏳')) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');

      safeDownload(`PROMPT:\n${st.draftPrompt}\n\nRESPON:\n${st.currentResponse}`, `log_${ts}.txt`, 'text/plain');
    });
  }

  // Export Log ke JSON
  if (btnDownloadJson) {
    btnDownloadJson.addEventListener('click', async() => {
      const { chatLogs = [], modelName, stampLastPrompt, lastPrompt, stampFirstResponse, stampLastResponse, lastResponse } = await chrome.storage.local.get(['chatLogs','modelName','stampLastPrompt','lastPrompt','stampFirstResponse','stampLastResponse','lastResponse']);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');

      console.log(chatLogs, stampLastPrompt, lastPrompt, stampLastResponse, lastResponse);
      let exportData = [...chatLogs];
      if (exportData.length === 0 && lastPrompt) {
        chatLogs.push({
          id: Date.now(),
          timestamp: stampLastPrompt,
          model: modelName,
          prompt: lastPrompt,
          response: lastResponse,
          duration_response: (stampFirstResponse - stampLastPrompt) / 1000,
          duration_total: (stampLastResponse - stampLastPrompt) / 1000
        });
      }

      safeDownload(JSON.stringify(exportData, null, 2), `log_${ts}.json`, 'application/json');
    });
  }

  // fetch models
  if (btnFetchModels) {
    btnFetchModels.addEventListener('click', async () => {
      const st = await chrome.storage.local.get(['baseUrl', 'apiKey']);
      try {
        const url = `${st.baseUrl}/models`;
        const headers = {};
        if (apiKeyInput.value.trim()) {
          headers['Authorization'] = `Bearer ${st.apiKey}`;
        }
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data && data.data && data.data.length > 0) {
          modelNameInput.value = data.data[0].id;
          alert(`Model ditemukan: ${data.data[0].id}`);
        } else {
          alert('Gagal mengambil daftar model.');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });
  }

  // Save Settings
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      await chrome.storage.local.set({
        baseUrl: baseUrlInput.value.trim().replace(/\/$/, ''),
        apiKey: apiKeyInput.value.trim(),
        modelName: modelNameInput.value.trim(),
        systemPrompt: systemPromptInput.value,
        temperature: parseFloat(tempInput.value)
      });
      settingsNotice.innerText = 'Pengaturan berhasil disimpan!';
      setTimeout(() => { settingsNotice.innerText = ''; }, 2500);
      checkHealth();
    });
  }
});
