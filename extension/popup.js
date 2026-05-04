const VERSION = '0.1.0';
const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_MAX_TOTAL_CHARS = 60000;
const UNSUPPORTED_SCHEMES = ['chrome://', 'edge://', 'brave://', 'about:', 'file:', 'chrome-extension:', 'devtools:', 'view-source:'];

const outputEl = document.getElementById('markdown-output');
const statusEl = document.getElementById('status');

document.getElementById('export-current-tab').addEventListener('click', () => exportTabs('currentTab'));
document.getElementById('export-current-window').addEventListener('click', () => exportTabs('currentWindow'));
document.getElementById('export-all-windows').addEventListener('click', () => exportTabs('allWindows'));
document.getElementById('copy-markdown').addEventListener('click', copyMarkdown);
document.getElementById('download-markdown').addEventListener('click', downloadMarkdown);
document.getElementById('help-button').addEventListener('click', () => document.getElementById('help-panel').classList.toggle('hidden'));

function setStatus(message) { statusEl.textContent = message; }

function getExportOptions() {
  return {
    exportMode: document.getElementById('export-mode').value,
    maxChars: Number(document.getElementById('max-chars').value) || DEFAULT_MAX_CHARS,
    maxTotalChars: Number(document.getElementById('max-total-chars').value) || DEFAULT_MAX_TOTAL_CHARS,
    minLineLength: Number(document.getElementById('min-line-length').value) || 25,
    maxLineLength: Number(document.getElementById('max-line-length').value) || 500,
    maxKeyLines: Number(document.getElementById('max-key-lines').value) || 12,
    dedupeLines: document.getElementById('dedupe-lines').checked,
    applyLineFilter: document.getElementById('apply-line-filter').checked,
    maxHeadings: 10
  };
}

async function getTabsForMode(mode) {
  if (mode === 'currentTab') return chrome.tabs.query({ active: true, currentWindow: true });
  if (mode === 'currentWindow') return chrome.tabs.query({ currentWindow: true });
  return chrome.tabs.query({});
}

function isSupportedUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return '(unknown)'; }
}

async function extractPageData(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const metaNode = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (clone) clone.querySelectorAll('script, style, noscript, svg, canvas, iframe, nav, footer, aside, form, select, option, input, button').forEach((el) => el.remove());
      const primaryBlocks = Array.from(document.querySelectorAll('main, article, section, [role="main"], p, li, h1, h2, h3')).map((el) => (el.innerText || '').trim()).filter(Boolean);
      const pageText = clone ? (clone.innerText || '') : (document.body ? document.body.innerText || '' : '');
      const combinedText = [primaryBlocks.join('\n'), pageText, document.documentElement ? (document.documentElement.innerText || '') : ''].filter(Boolean).join('\n\n');
      return { title: document.title || '', url: location.href || '', metaDescription: metaNode ? metaNode.content || '' : '', pageText: combinedText };
    }
  });
  return results && results[0] && results[0].result ? results[0].result : { title: '', url: '', metaDescription: '', pageText: '' };
}

function cleanText(text) {
  return safeCleanText(text, getExportOptions());
}

function safeCleanText(text, options) {
  const base = (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');

  const lines = base.split('\n');
  const filtered = [];
  let prev = '';
  for (const line of lines) {
    if (!line) { filtered.push(''); prev = ''; continue; }
    if (options.applyLineFilter && (line.length < options.minLineLength || line.length > options.maxLineLength)) continue;
    if (options.dedupeLines && line === prev) continue;
    filtered.push(line);
    prev = line;
    if (options.applyLineFilter && filtered.filter(Boolean).length >= options.maxKeyLines) break;
  }
  return filtered.join('\n').trim();
}

function buildMarkdown(results, metadata) {
  const lines = [
    '# Browser Context Pack',
    '',
    `Generated: ${metadata.generatedAt}`,
    `Extension: Browser Context Pull v${VERSION}`,
    `Mode: ${metadata.modeLabel}`,
    `Total tabs: ${metadata.totalTabs}`,
    `Readable tabs: ${metadata.readableTabs}`,
    `Skipped tabs: ${metadata.skippedTabs}`,
    `Max chars per tab: ${metadata.options.maxChars}`,
    `Max total chars: ${metadata.options.maxTotalChars}`,
    '',
    '## Tab Index',
    ''
  ];

  results.forEach((r, i) => lines.push(`${i + 1}. [${r.title || '(Untitled Tab)'}](${r.url || ''})`));
  lines.push('', '---', '');

  results.forEach((r, i) => {
    lines.push(`# Tab ${i + 1}: ${r.title || '(Untitled Tab)'}`, '', `URL: ${r.url || '(No URL)'}`, `Site: ${r.site}`, `Status: ${r.status}`, '');
    if (r.status === 'skipped') {
      lines.push(`Reason: ${r.reason}`, '', '---', '');
      return;
    }
    lines.push('## Page Signals', '', `Description: ${r.metaDescription || '(none)'}`, '');
    if (metadata.options.exportMode === 'rawReadable') {
      lines.push('## Visible Page Text', '', r.pageText || 'Body text skipped because total output character budget was reached.', '');
    }
    lines.push('---', '');
  });
  return lines.join('\n');
}

async function exportTabs(mode) {
  const options = getExportOptions();
  const modeLabel = options.exportMode === 'urlsOnly' ? 'URLs only' : 'Compact Context';
  const tabs = await getTabsForMode(mode);
  setStatus(`Found ${tabs.length} tabs.`);
  const results = [];
  let readableTabs = 0;
  let skippedTabs = 0;
  let totalCharsUsed = 0;

  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const title = tab.title || '(Untitled Tab)';
    const url = tab.url || '';
    const site = getDomain(url);
    setStatus(`Exporting ${i + 1} / ${tabs.length}...`);

    if (!isSupportedUrl(url)) {
      skippedTabs += 1;
      results.push({ title, url, site, status: 'skipped', reason: 'unsupported browser/internal URL.' });
      continue;
    }

    if (options.exportMode === 'urlsOnly') {
      readableTabs += 1;
      results.push({ title, url, site, status: 'readable', metaDescription: '', pageText: '' });
      continue;
    }

    try {
      const extracted = await extractPageData(tab.id);
      let cleaned = safeCleanText(extracted.pageText, options);
      if (cleaned.length > options.maxChars) cleaned = cleaned.slice(0, options.maxChars);
      if (totalCharsUsed + cleaned.length > options.maxTotalChars) {
        cleaned = '';
      } else {
        totalCharsUsed += cleaned.length;
      }
      readableTabs += 1;
      results.push({ title: extracted.title || title, url: extracted.url || url, site, status: 'readable', metaDescription: safeCleanText(extracted.metaDescription, options), pageText: cleaned });
    } catch (error) {
      skippedTabs += 1;
      results.push({ title, url, site, status: 'skipped', reason: error && error.message ? error.message : 'could not read page content.' });
    }
  }

  outputEl.value = buildMarkdown(results, { generatedAt: new Date().toISOString(), modeLabel, totalTabs: tabs.length, readableTabs, skippedTabs, options });
  setStatus(`Done. Readable: ${readableTabs}. Skipped: ${skippedTabs}.`);
}

async function copyMarkdown() {
  const markdown = outputEl.value.trim();
  if (!markdown) return setStatus('Nothing to copy yet.');
  await navigator.clipboard.writeText(markdown);
  setStatus('Copied Markdown to clipboard.');
}

function downloadMarkdown() {
  const markdown = outputEl.value.trim();
  if (!markdown) return setStatus('Nothing to download yet.');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `browser-context-pack-${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}.md`;
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  setStatus(`Downloaded ${filename}`);
}
