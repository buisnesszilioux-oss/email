import React, { useState, useEffect, useRef } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { Moon, Sun, Upload, Send, StopCircle, Sparkles, Download, FileText, Image as ImageIcon, HelpCircle } from 'lucide-react';
import GmailGuide from './components/GmailGuide.jsx';

const DAILY_LIMIT = 500;
const DELAY_MS = 10000; // 10 seconds = safe Gmail rate

export default function App() {
  const [dark, setDark] = useState(true);
  const [recipients, setRecipients] = useState([]);
  const [senderEmail, setSenderEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [subject, setSubject] = useState('');
  const [baseMsg, setBaseMsg] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [images, setImages] = useState([]);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0, failed: 0 });
  const [logs, setLogs] = useState([]);
  const [showGuide, setShowGuide] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [dailyCount, setDailyCount] = useState(() => {
    const stored = JSON.parse(localStorage.getItem('dailyEmailCount') || '{}');
    const today = new Date().toDateString();
    return stored.date === today ? stored.count : 0;
  });
  const stopRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const updateDailyCount = (n) => {
    const today = new Date().toDateString();
    setDailyCount(n);
    localStorage.setItem('dailyEmailCount', JSON.stringify({ date: today, count: n }));
  };

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
    });

  const handleSpreadsheet = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv') {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => validateAndSet(res.data),
        error: (err) => alert('Parse error: ' + err.message),
      });
    } else if (['xlsx', 'xls'].includes(ext)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const wb = XLSX.read(ev.target.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);
        validateAndSet(data);
      };
      reader.readAsBinaryString(file);
    } else {
      alert('Use .csv, .xlsx or .xls');
    }
  };

  const validateAndSet = (data) => {
    const cleaned = data
      .map((r) => ({
        Name: r.Name || r.name || '',
        Email: (r.Email || r.email || '').trim(),
        Company: r.Company || r.company || '',
      }))
      .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.Email));
    if (!cleaned.length) {
      alert('No valid rows. Required columns: Name, Email, Company');
      return;
    }
    setRecipients(cleaned);
  };

  const aiImprove = async () => {
    if (!baseMsg.trim()) return alert('Enter a base message first');
    let key = localStorage.getItem('GROQ_KEY');
    if (!key) {
      key = prompt('Enter Groq API key (free at console.groq.com):');
      if (!key) return;
      localStorage.setItem('GROQ_KEY', key);
    }
    setAiLoading(true);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: 'Improve cold email templates. Keep {Name} and {Company} placeholders. Be concise, friendly, professional.' },
            { role: 'user', content: `Improve:\n\n${baseMsg}` },
          ],
          temperature: 0.7,
        }),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) {
        setBaseMsg(data.choices[0].message.content.trim());
      } else {
        alert('AI error: ' + (data.error?.message || JSON.stringify(data)));
        if (data.error) localStorage.removeItem('GROQ_KEY');
      }
    } catch (e) {
      alert('AI failed: ' + e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const personalize = (tmpl, r) =>
    tmpl.replace(/\{Name\}/g, r.Name).replace(/\{Company\}/g, r.Company);

  const startSend = async () => {
    if (!senderEmail || !appPassword) return alert('Enter Gmail + app password');
    if (!subject.trim()) return alert('Enter a subject');
    if (!baseMsg.trim()) return alert('Enter a message');
    if (!pdfFile) return alert('PDF attachment is mandatory');
    if (!recipients.length) return alert('No recipients');

    const remaining = DAILY_LIMIT - dailyCount;
    if (remaining <= 0) {
      return alert(`❌ Daily limit reached (${DAILY_LIMIT}/day). Resets at midnight.`);
    }

    const toSend = recipients.slice(0, remaining);
    if (toSend.length < recipients.length) {
      if (!confirm(`⚠️ Only $${remaining} emails left in today's quota. Send first $${remaining}?`)) return;
    }

    setSending(true);
    stopRef.current = false;
    setProgress({ sent: 0, total: toSend.length, failed: 0 });
    setLogs([]);

    const pdfB64 = await fileToBase64(pdfFile);
    const imgB64 = await Promise.all(
      images.map(async (f) => ({ filename: f.name, content: await fileToBase64(f) }))
    );

    let sent = 0, failed = 0;
    let currentDaily = dailyCount;

    for (let i = 0; i < toSend.length; i++) {
      if (stopRef.current) {
        addLog({ email: '-', status: 'STOPPED', msg: 'User stopped', time: new Date().toISOString() });
        break;
      }
      const r = toSend[i];
      const finalMsg = `Hi $${r.Name} from $${r.Company},\n\n${personalize(baseMsg, r)}`;
      try {
        const res = await fetch('/api/send-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderEmail, appPassword,
            to: r.Email,
            subject: personalize(subject, r),
            text: finalMsg,
            pdf: { filename: pdfFile.name, content: pdfB64 },
            images: imgB64,
          }),
        });
        const data = await res.json();
        if (data.success) {
          sent++;
          currentDaily++;
          updateDailyCount(currentDaily);
          addLog({ email: r.Email, status: 'SUCCESS', msg: `Sent ($${currentDaily}/$${DAILY_LIMIT})`, time: new Date().toISOString() });
        } else {
          failed++;
          addLog({ email: r.Email, status: 'FAILED', msg: data.error || 'Unknown', time: new Date().toISOString() });
        }
      } catch (e) {
        failed++;
        addLog({ email: r.Email, status: 'FAILED', msg: e.message, time: new Date().toISOString() });
      }
      setProgress({ sent, total: toSend.length, failed });

      if (i < toSend.length - 1 && !stopRef.current) {
        const jitter = DELAY_MS + Math.floor(Math.random() * 2000) - 1000;
        await new Promise((res) => setTimeout(res, jitter));
      }
    }
    setSending(false);
  };

  const addLog = (l) => setLogs((prev) => [...prev, l]);
  const stopSend = () => { stopRef.current = true; };

  const exportLogs = () => {
    if (!logs.length) return alert('No logs to export');
    const csv = Papa.unparse(logs);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `email-logs-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const pct = progress.total ? Math.round(((progress.sent + progress.failed) / progress.total) * 100) : 0;
  const quotaPct = Math.min((dailyCount / DAILY_LIMIT) * 100, 100);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Send className="w-6 h-6 text-blue-500" /> Bulk Email Sender
          </h1>
          <div className="flex gap-2">
            <button onClick={() => setShowGuide(true)} className="p-2 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">
              <HelpCircle className="w-5 h-5" />
            </button>
            <button onClick={() => setDark(!dark)} className="p-2 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">
              {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <section className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">1. Sender Settings</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <input type="email" placeholder="your@gmail.com" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900" />
            <input type="password" placeholder="Gmail App Password (16 chars)" value={appPassword} onChange={(e) => setAppPassword(e.target.value)}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900" />
          </div>
          <button onClick={() => setShowGuide(true)} className="mt-2 text-sm text-blue-500 hover:underline">
            How to get Gmail App Password →
          </button>
        </section>

        <section className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
          <h2 className="text-lg font-semibold mb-4">2. Upload Recipients (CSV/Excel)</h2>
          <p className="text-sm text-gray-500 mb-2">Required columns: <code>Name, Email, Company</code></p>
          <label className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg cursor-pointer hover:bg-blue-600 w-fit">
            <Upload className="w-4 h-4" /> Choose File
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleSpreadsheet} className="hidden" />
          </label>
          {recipients.length > 0 && (
            <div className="mt-4 max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 dark:bg-gray-700 sticky top-0">
                  <tr><th className="p-2 text-left">Name</th><th className="p-2 text-left">Email</th><th className="p-2 text-left">Company</th></tr>
                </thead>
                <tbody>
                  {recipients.map((r, i) => (
                    <tr key={i} className="border-t border-gray-200 dark:border-gray-700">
                      <td className="p-2">{r.Name}</td><td className="p-2">{r.Email}</td><td className="p-2">{r.Company}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-sm text-gray-500">{recipients.length} valid recipients loaded</p>
        </section>

        <section className="bg-white dark:bg-gray-800 p-6 roun