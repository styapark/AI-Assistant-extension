// background.js
let currentAbortController = null;
let isGenerating = false;
let keepAliveInterval = null;

function startKeepAlive() {
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo(); // Dummy call untuk mencegah SW sleep
    }, 20000); // Setiap 20 detik
  }
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_GENERATE') {
    generateAIResponse(message.promptText);
    sendResponse({ status: 'STARTED' });
  } else if (message.type === 'STOP_GENERATE') {
    stopAIResponse(); // <--- Hentikan AI saat sinyal stop diterima
    sendResponse({ status: 'STOPPED' });
  }
  return true;
});

// Fungsi pembatalan request
function stopAIResponse() {
  if (currentAbortController) {
    currentAbortController.abort(); // Hentikan koneksi HTTP fetch
    currentAbortController = null;
  }
  isGenerating = false;

  chrome.storage.local.get(['currentResponse'], (data) => {
    const existingText = data.currentResponse || '';
    const updatedText = existingText + "\n\n🛑 [Proccess cancelled by user]";
    chrome.storage.local.set({
      isGenerating: false,
      currentResponse: updatedText
    });
  });
}

async function generateAIResponse(promptText) {
  if (isGenerating) stopAIResponse();

  isGenerating = true;
  startKeepAlive();
  currentAbortController = new AbortController();

  const settings = await chrome.storage.local.get({
    baseUrl: 'http://localhost:8001/v1',
    apiKey: 'lm-studio',
    modelName: 'qwen2.5-coder-7b-instruct',
    systemPrompt: 'Anda adalah pakar Application Security dan Code Reviewer senior. Analisis input web page/code dan berikan temuan kerentanan, PoC payload, dan solusi remediasi secara terstruktur. Jangan membahas selain security software, selain itu jawab "jawaban tidak tersedia".',
    temperature: 0.2,
    lastPrompt: '',
    lastResponse: '',
    chatLogs: []
  });

  const endpoint = `${settings.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey}`;
  }

  const payload = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: settings.systemPrompt },
      { role: 'user', content: promptText }
    ],
    temperature: settings.temperature,
    stream: true
  };


  try {
    await chrome.storage.local.set({ isGenerating: true, stampFirstThinking: Date.now(), currentResponse: 'Thinking...' });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: currentAbortController.signal // Pasang signal AbortController
    });

    if (!response.ok) {
      const errText = await response.text();
      await chrome.storage.local.set({
        isGenerating: false,
        currentResponse: `❌ Error HTTP ${response.status}:\n${errText}`
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = "";
    let lastSave = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.replace('data: ', '');
          if (dataStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (fullText=='') chrome.storage.local.set({ stampFirstResponse: Date.now() });
            fullText += delta;

            const now = Date.now();
            if (now - lastSave > 100) {
              lastSave = now;
              chrome.storage.local.set({ currentResponse: fullText, lastResponse: fullText, stampLastResponse: now });
            }
          } catch (e) {}
        }
      }
    }

    if (isGenerating) {
      await chrome.storage.local.set({
        isGenerating: false,
        currentResponse: fullText || '⚠️ Response is empty from AI services.'
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Success! Request is cancelled by user.');
    } else {
      let failureNotice = `❌ Failed connect to Server:\n${err.message}`;
      if (err.message.includes('Failed to fetch')) {
        failureNotice = '❌ Server Offline: Pastikan LM Studio berjalan di http://localhost:8001 dan Enable CORS dicentang!';
      }
      await chrome.storage.local.set({
        isGenerating: false,
        currentResponse: failureNotice
      });
    }
  } finally {
    isGenerating = false;
    currentAbortController = null;
    stopKeepAlive();
  }
}

// Tambahkan listener untuk membersihkan state jika Service Worker hendak di-suspend
chrome.runtime.onSuspend.addListener(() => {
  if (isGenerating) {
    chrome.storage.local.set({
      isGenerating: false,
      currentResponse: '⚠️ Disconnected: Service Worker tertidur atau koneksi terputus.'
    });
  }
});
