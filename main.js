import './style.css';
import { signUp, signIn, signOut, getSession, onAuthStateChange } from './auth.js';
import {
  PLANS,
  getProfile, getEffectivePlan, getRemaining,
  canAiSearch, canManualSearch, getMaxDomains,
  incrementGuestAi, incrementGuestManual, getGuestUsage,
  incrementAiSession, incrementManualSession,
} from './quota.js';
import { generateDomains } from './gemini.js';
import { supabase } from './lib/supabase.js';

// ============================================
// State
// ============================================
let currentSession = null;
let currentProfile = null;
let isRunning = false;
let foundDomains   = [];
let checkedDomains = [];
let sessionLogs    = [];
let selectedSuffixes = [];
let totalCheckedGlobal = 0;
let totalFoundGlobal   = 0;

const $ = id => document.getElementById(id);

// ============================================
// Init
// ============================================
async function init() {
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);

  loadSavedSettings();

  currentSession = await getSession();
  if (currentSession) {
    await onSessionReady(currentSession);
  } else {
    renderGuestUI();
  }

  onAuthStateChange(async (session) => {
    currentSession = session;
    if (session) {
      await onSessionReady(session);
    } else {
      currentProfile = null;
      renderGuestUI();
    }
  });

  bindEvents();
}

async function onSessionReady(session) {
  try { currentProfile = await getProfile(session.user.id); } catch (e) { currentProfile = null; }
  renderAuthUI(session);
  updateQuotaDisplay();
  // Show upgrade notice based on plan
  updatePlanNotice();
}

// ============================================
// Settings
// ============================================
function loadSavedSettings() {
  if (localStorage.getItem('keywords'))           $('keywords').value           = localStorage.getItem('keywords');
  if (localStorage.getItem('promptInstructions')) $('promptInstructions').value = localStorage.getItem('promptInstructions');
  if (localStorage.getItem('batchSize'))          $('batchSize').value          = localStorage.getItem('batchSize');
  if (localStorage.getItem('targetCount')) {
    $('targetCount').value = localStorage.getItem('targetCount');
    $('targetDisplay').textContent = localStorage.getItem('targetCount');
  }
  try {
    const saved = JSON.parse(localStorage.getItem('selectedSuffixes'));
    if (Array.isArray(saved)) {
      selectedSuffixes = saved;
      document.querySelectorAll('.pill').forEach(p => {
        if (selectedSuffixes.includes(p.dataset.value)) p.classList.add('active');
      });
    }
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem('keywords',           $('keywords').value);
  localStorage.setItem('promptInstructions', $('promptInstructions').value);
  localStorage.setItem('batchSize',          $('batchSize').value);
  localStorage.setItem('targetCount',        $('targetCount').value);
  $('targetDisplay').textContent = $('targetCount').value;
}

// ============================================
// UI Rendering
// ============================================
function renderGuestUI() {
  $('guestActions').classList.remove('hidden');
  $('userActions').classList.add('hidden');
  $('guestNotice').classList.remove('hidden');
  $('quotaNotice').classList.add('hidden');
  $('manualGate').classList.add('hidden'); // Allow guests to see the form without banner
  const heroSection = $('heroSection');
  if (heroSection) heroSection.classList.remove('hidden');
  updateQuotaDisplay();
}

function renderAuthUI(session) {
  $('guestActions').classList.add('hidden');
  $('userActions').classList.remove('hidden');
  $('guestNotice').classList.add('hidden');
  $('manualGate').classList.add('hidden');
  const heroSection = $('heroSection');
  if (heroSection) heroSection.classList.add('hidden');
  $('userEmailDisplay').textContent = session.user.email;
  updateQuotaDisplay();
  updatePlanNotice();
}

function updatePlanNotice() {
  if (!currentProfile) return;
  const rem = getRemaining(currentProfile);
  const plan = getEffectivePlan(currentProfile);

  if (plan === 'free' || plan === 'starter' || plan === 'hustler') {
    $('quotaNotice').classList.remove('hidden');
    const aiLeft = rem.ai === '∞' ? 'unlimited' : rem.ai;
    $('quotaNoticeText').textContent = `${aiLeft} AI hunt${aiLeft !== 1 ? 's' : ''} remaining (${PLANS[plan].label} plan)`;
  } else {
    $('quotaNotice').classList.add('hidden');
  }
}

function updateQuotaDisplay() {
  if (!currentSession || !currentProfile) {
    const { ai, manual } = getGuestUsage();
    const aiLeft = Math.max(0, PLANS.guest.ai_per_month - ai);
    const manLeft = Math.max(0, PLANS.guest.manual_per_month - manual);
    $('headerAiQuota').textContent   = `${aiLeft} AI left`;
    $('headerManualQuota').textContent = `${manLeft} manual`;
    $('manualCountBadge').textContent  = `${manLeft} sessions left`;
    $('guestNotice').querySelector('strong').textContent =
      aiLeft > 0 ? `${aiLeft} free AI search remaining` : 'All free searches used';
    return;
  }
  const rem  = getRemaining(currentProfile);
  const plan = getEffectivePlan(currentProfile);

  $('headerAiQuota').textContent     = `${rem.ai} AI left`;
  $('headerManualQuota').textContent = `${rem.manual} manual`;
  $('manualCountBadge').textContent  = `${rem.manual} sessions left`;

  // Cap batchSize to plan's ai_max
  const aiMax = PLANS[plan]?.ai_max || 40;
  if (parseInt($('batchSize').value) > aiMax) {
    $('batchSize').value = aiMax;
    saveSettings();
  }
  $('batchSize').max = aiMax;
}

function updateStatus(text, cls = 'running') {
  $('statusText').textContent = text;
  $('statusText').className   = `status-value ${cls}`;
}

function setRunning(mode) {
  isRunning = !!mode;
  const off = isRunning;
  ['keywords','promptInstructions','batchSize','targetCount','manualDomains']
    .forEach(id => { if ($(id)) $(id).disabled = off; });
  const sg = $('suffixGroup');
  if (sg) { sg.style.pointerEvents = off ? 'none' : 'auto'; sg.style.opacity = off ? '0.6' : '1'; }

  if (mode === 'ai') {
    $('startAiBtn').style.display   = 'none';
    $('stopAiBtn').style.display    = 'block';
  } else if (mode === 'manual') {
    $('startManualBtn').style.display = 'none';
    $('stopManualBtn').style.display  = 'block';
  } else {
    $('startAiBtn').style.display     = 'block';
    $('stopAiBtn').style.display      = 'none';
    $('startManualBtn').style.display = 'block';
    $('stopManualBtn').style.display  = 'none';
  }
}

// ============================================
// Log & Results
// ============================================
function startLog(domain) {
  const list = $('logList');
  if (list.querySelector('.log-empty')) list.innerHTML = '';

  const item = document.createElement('div');
  item.className    = 'log-item checking';
  item.dataset.domain = domain;
  item.innerHTML    = `<span>${domain}.com</span><span class="log-checking">CHECKING...</span>`;
  list.prepend(item);
  return item;
}

function updateLog(item, domain, status) {
  if (!item) return;
  sessionLogs.push({ domain, status });
  totalCheckedGlobal++;
  $('totalChecked').textContent = totalCheckedGlobal;

  const filter = $('logFilter').value;
  if (filter !== 'all' && filter !== status) {
    item.remove();
    return;
  }
  item.className = 'log-item';
  item.dataset.status = status;
  item.innerHTML = `<span>${domain}.com</span><span class="log-${status}">${status.toUpperCase()}</span>`;
}

function addChip(domain) {
  foundDomains.push(domain);
  totalFoundGlobal++;
  $('foundCount').textContent = foundDomains.length;
  $('totalFound').textContent = totalFoundGlobal;

  const container = $('foundChips');
  if (container.querySelector('.chips-empty')) container.innerHTML = '';
  const chip = document.createElement('div');
  chip.className   = 'domain-chip';
  chip.textContent = `${domain}.com`;
  container.appendChild(chip);
}

function renderLogs() {
  const filter   = $('logFilter').value;
  const filtered = filter === 'all' ? sessionLogs : sessionLogs.filter(l => l.status === filter);
  $('logList').innerHTML = '';
  if (!filtered.length) { $('logList').innerHTML = '<div class="log-empty">No results match the filter.</div>'; return; }
  filtered.slice().reverse().forEach(l => {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerHTML = `<span>${l.domain}.com</span><span class="log-${l.status}">${l.status.toUpperCase()}</span>`;
    $('logList').appendChild(item);
  });
}

function downloadLog() {
  if (!sessionLogs.length) return alert('No logs to export.');
  const filter = $('logFilter').value;
  const data   = filter === 'all' ? sessionLogs : sessionLogs.filter(l => l.status === filter);
  let txt = `JunoverseAI Domain Report\nGenerated: ${new Date().toLocaleString()}\n\n`;
  data.forEach(l => { txt += `${l.domain}.com — ${l.status.toUpperCase()}\n`; });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  a.download = `JunoverseAI-${new Date().toISOString().slice(0,16).replace(/T|:/g,'-')}.txt`;
  a.click();
}

// ============================================
// Cloudflare DoH — client-side DNS check
// ============================================
async function checkDomainDNS(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain + '.com')}&type=NS`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!res.ok) return 'error';
    const d = await res.json();
    return d.Status === 3 ? 'available' : 'taken';
  } catch { return 'error'; }
}

// ============================================
// AI Hunt
// ============================================
async function startAiHunt() {
  const keywords = $('keywords').value.trim();
  if (!keywords) return alert('Please enter at least one keyword.');

  if (!canAiSearch(currentProfile)) {
    if (!currentSession) openModal('signup');
    else { alert('AI search quota reached. Upgrade your plan!'); document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' }); }
    return;
  }

  // For guests, increment before calling
  if (!currentSession) incrementGuestAi();

  setRunning('ai');
  foundDomains   = [];
  checkedDomains = [];
  sessionLogs    = [];
  $('foundChips').innerHTML = '<div class="chips-empty">Available domains will appear here as green chips</div>';
  $('logList').innerHTML    = '<div class="log-empty">Starting AI hunt...</div>';

  await runAiLoop();
}

const SEARCH_QUOTES = [
  "A great domain is your digital real estate.",
  "Your brand is your promise to your customer.",
  "The right name is the beginning of a great story.",
  "Domains are the bedrock of the internet.",
  "Good names are taken, great names are created.",
  "Your domain name is your first impression.",
  "A memorable name is worth a thousand marketing dollars.",
  "Keep it short, make it memorable.",
  "A strong brand creates trust.",
  "Invest in your name; it's the only thing that lasts.",
  "The best domains are easy to say and easy to spell.",
  "Your name is your digital identity.",
  "Branding is what people say about you when you're not in the room.",
  "A single word can define a generation.",
  "Own your niche, own your name.",
  "Don't compromise on your cornerstone.",
  "A premium domain signals authority.",
  "First they see the name, then they see the vision.",
  "Simple, bold, and definitive.",
  "Your domain is the front door to your business.",
  "Great brands communicate instantly.",
  "Think global, name wisely.",
  "Clarity beats cleverness in naming.",
  "The internet isn't written in ink, but domains are permanent.",
  "A good name opens doors.",
  "Your digital presence starts here.",
  "Find a name that scales with your ambition.",
  "The right domain sparks curiosity.",
  "Your brand is an asset, treat it like one.",
  "Visionaries secure their digital footprint.",
  "A domain isn't just an address, it's a statement.",
  "Make it stick in their minds."
];

async function runAiLoop() {
  if (!isRunning) return;

  const target    = parseInt($('targetCount').value) || 5;
  const planMaxDomains = getMaxDomains(currentProfile, 'ai');
  const batchSize = Math.min(parseInt($('batchSize').value) || 15, planMaxDomains === Infinity ? 100 : planMaxDomains);

  try {
    const randomQuote = SEARCH_QUOTES[Math.floor(Math.random() * SEARCH_QUOTES.length)];
    updateStatus(randomQuote);

    const domains = await generateDomains({
      keywords:           $('keywords').value,
      batchSize,
      promptInstructions: $('promptInstructions').value,
      selectedSuffixes,
      checkedDomains:     checkedDomains.slice(-50),
    }, currentSession);

    // Increment session counter for auth users
    if (currentSession && currentProfile) {
      await incrementAiSession(currentSession.user.id, currentProfile);
      currentProfile = await getProfile(currentSession.user.id);
      updateQuotaDisplay();
    }

    for (const domain of domains) {
      if (!isRunning) return;
      if (checkedDomains.includes(domain)) continue;
      checkedDomains.push(domain);

      updateStatus(`Checking ${domain}.com via DNS...`);
      const logEl = startLog(domain);
      const status = await checkDomainDNS(domain);
      updateLog(logEl, domain, status);

      if (status === 'available') {
        addChip(domain);
        if (foundDomains.length >= target) {
          updateStatus(`🎉 Target reached! Found ${foundDomains.length} domain${foundDomains.length !== 1 ? 's' : ''}.`, 'idle');
          setRunning(false);
          return;
        }
      }
      await sleep(120);
    }

    if (isRunning && foundDomains.length < target) {
      // Check quota before next batch
      if (!canAiSearch(currentProfile)) {
        updateStatus('Quota used up. Upgrade for more!', 'idle');
        setRunning(false);
        updatePlanNotice();
        return;
      }
      updateStatus('Batch done. Generating next batch...');
      await sleep(1200);
      runAiLoop();
    }

  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('quota_exceeded')) {
      updateStatus('Quota reached. Upgrade to continue!', 'idle');
      document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
    } else {
      updateStatus(`Error: ${msg}`, 'idle');
    }
    setRunning(false);
  }
}

// ============================================
// Manual Check
// ============================================
async function startManualCheck() {
  if (!canManualSearch(currentProfile)) {
    if (!currentSession) {
      alert('Free guest limit reached. Please sign up to get 3 manual checks!');
      openModal('signup');
    } else {
      alert('Manual check quota reached. Upgrade your plan!');
      document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
    }
    return;
  }

  const manualMax = getMaxDomains(currentProfile, 'manual');
  const raw = $('manualDomains').value || '';
  let domains = raw.split('\n')
    .map(d => d.trim().toLowerCase().replace(/\.com$/i,'').replace(/[^a-z0-9-]/g,''))
    .filter(Boolean);

  // Cap to plan limit
  if (manualMax !== Infinity && domains.length > manualMax) {
    domains = domains.slice(0, manualMax);
    alert(`Your plan allows max ${manualMax} domains per session. Checking first ${manualMax}.`);
  }
  if (!domains.length) return alert('Enter at least one domain.');

  setRunning('manual');
  sessionLogs = [];
  foundDomains = [];
  $('foundChips').innerHTML = '<div class="chips-empty">Available domains will appear here as green chips</div>';
  $('logList').innerHTML    = '';

  if (!currentSession) {
    incrementGuestManual();
  } else {
    await incrementManualSession(currentSession.user.id, currentProfile);
    currentProfile = await getProfile(currentSession.user.id);
  }
  updateQuotaDisplay();

  for (let i = 0; i < domains.length; i++) {
    if (!isRunning) break;
    updateStatus(`Checking ${i + 1}/${domains.length}: ${domains[i]}.com`);
    const logEl = startLog(domains[i]);
    const status = await checkDomainDNS(domains[i]);
    updateLog(logEl, domains[i], status);
    if (status === 'available') addChip(domains[i]);
    await sleep(100);
  }

  if (isRunning) { updateStatus(`Done. Checked ${domains.length} domains.`, 'idle'); setRunning(false); }
}

// ============================================
// Coupon
// ============================================
async function applyCoupon() {
  if (!currentSession) { openModal('signin'); return; }

  const code = $('couponInput').value.trim().toUpperCase();
  if (!code) return;

  const btn = $('applyCouponBtn');
  const msg = $('couponMsg');
  btn.disabled     = true;
  btn.textContent  = 'Applying...';
  msg.className    = 'coupon-msg hidden';

  try {
    const { data, error } = await supabase.functions.invoke('apply-coupon', {
      body: { code },
      headers: { Authorization: `Bearer ${currentSession.access_token}` },
    });

    if (error || data?.error) {
      const errText = data?.error || error?.message || 'Invalid coupon';
      msg.textContent = `❌ ${errText}`;
      msg.className   = 'coupon-msg error';
    } else {
      msg.textContent = `✅ Coupon applied! You now have ${PLANS[data.plan]?.label || data.plan} plan access.`;
      msg.className   = 'coupon-msg success';
      $('couponInput').value = '';
      // Refresh profile
      currentProfile = await getProfile(currentSession.user.id);
      updateQuotaDisplay();
      updatePlanNotice();
    }
  } catch (err) {
    msg.textContent = `❌ ${err.message}`;
    msg.className   = 'coupon-msg error';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Apply';
    msg.classList.remove('hidden');
  }
}

// ============================================
// Auth Modal
// ============================================
function openModal(tab = 'signin') {
  $('modalOverlay').classList.remove('hidden');
  switchModalTab(tab);
}
function closeModal() { $('modalOverlay').classList.add('hidden'); }
function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b.dataset.modalTab === tab));
  $('signinPane').classList.toggle('hidden', tab !== 'signin');
  $('signupPane').classList.toggle('hidden', tab !== 'signup');
}

async function handleSignIn() {
  const btn = $('signinBtn'), msg = $('signinMsg');
  msg.className = 'form-msg hidden';
  btn.disabled = true; btn.textContent = 'Signing in...';
  try { await signIn($('signinEmail').value.trim(), $('signinPassword').value); closeModal(); }
  catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

async function handleSignUp() {
  const btn = $('signupBtn'), msg = $('signupMsg');
  msg.className = 'form-msg hidden';
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    const { session } = await signUp($('signupEmail').value.trim(), $('signupPassword').value);
    if (session) closeModal();
    else { msg.textContent = '✅ Check your email to confirm your account, then sign in.'; msg.className = 'form-msg success'; }
  } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
  finally { btn.disabled = false; btn.textContent = 'Create Free Account'; }
}

// ============================================
// Theme
// ============================================
function updateThemeIcon(theme) {
  const moon = document.querySelector('.icon-moon'), sun = document.querySelector('.icon-sun');
  if (theme === 'dark') { sun.style.display = 'block'; moon.style.display = 'none'; }
  else { sun.style.display = 'none'; moon.style.display = 'block'; }
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

// ============================================
// Events
// ============================================
function bindEvents() {
  $('themeToggleBtn').addEventListener('click', toggleTheme);

  // Tabs
  document.querySelectorAll('.segment').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  // Modal
  $('modalOverlay').addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });
  $('closeModalBtn').addEventListener('click', closeModal);
  document.querySelectorAll('.modal-tab').forEach(tab => tab.addEventListener('click', () => switchModalTab(tab.dataset.modalTab)));
  $('openSigninBtn').addEventListener('click', () => openModal('signin'));
  $('openSignupBtn').addEventListener('click', () => openModal('signup'));
  $('signupFromNoticeBtn').addEventListener('click', () => openModal('signup'));
  $('signupFromManualBtn').addEventListener('click', () => openModal('signup'));

  const pricingBtn = $('pricingSignupBtn');
  if (pricingBtn) pricingBtn.addEventListener('click', () => openModal('signup'));

  // Auth
  $('signinBtn').addEventListener('click', handleSignIn);
  $('signupBtn').addEventListener('click', handleSignUp);
  $('signOutBtn').addEventListener('click', async () => { await signOut(); });

  // Upgrade link in notice
  const upgradeBtn = $('upgradeBtn');
  if (upgradeBtn) upgradeBtn.addEventListener('click', () => document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' }));

  // AI Hunt
  $('startAiBtn').addEventListener('click', startAiHunt);
  $('stopAiBtn').addEventListener('click',  () => { isRunning = false; setRunning(false); updateStatus('Stopped', 'idle'); });

  // Manual
  $('startManualBtn').addEventListener('click', startManualCheck);
  $('stopManualBtn').addEventListener('click',  () => { isRunning = false; setRunning(false); updateStatus('Stopped', 'idle'); });

  // Suffix pills
  $('suffixGroup').addEventListener('click', e => {
    if (!e.target.classList.contains('pill')) return;
    const val = e.target.dataset.value;
    if (selectedSuffixes.includes(val)) { selectedSuffixes = selectedSuffixes.filter(s => s !== val); e.target.classList.remove('active'); }
    else { selectedSuffixes.push(val); e.target.classList.add('active'); }
    localStorage.setItem('selectedSuffixes', JSON.stringify(selectedSuffixes));
  });

  // Auto-save
  ['keywords','promptInstructions','batchSize','targetCount'].forEach(id => {
    if ($(id)) $(id).addEventListener('input', saveSettings);
  });

  // Log controls
  $('logFilter').addEventListener('change', renderLogs);
  $('downloadLogBtn').addEventListener('click', downloadLog);

  // Coupon
  $('applyCouponBtn').addEventListener('click', applyCoupon);
  $('couponInput').addEventListener('keydown', e => { if (e.key === 'Enter') applyCoupon(); });

  // Keyboard shortcuts for modal
  $('signinPassword').addEventListener('keydown', e => { if (e.key === 'Enter') handleSignIn(); });
  $('signupPassword').addEventListener('keydown', e => { if (e.key === 'Enter') handleSignUp(); });

  // Payment modal
  const closePayBtn = $('closePaymentBtn');
  if (closePayBtn) closePayBtn.addEventListener('click', () => $('paymentModal').classList.add('hidden'));
  $('paymentModal').addEventListener('click', e => { if (e.target === $('paymentModal')) $('paymentModal').classList.add('hidden'); });

  // Copy wallet address
  const copyBtn = $('copyWalletBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText('TWE9mGmJ3eUN4qkKBpPhNRKx63LSD7ZrxW');
    copyBtn.textContent = '✅ Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });
}

// ============================================
// Utils
// ============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// Payment Modal (USDT)
// ============================================
function openPaymentModal(planName, price, period) {
  $('payPlanTitle').textContent  = `Get ${planName} — $${price}`;
  $('payPlanPeriod').textContent = `${period} · Pay with USDT (TRC20)`;
  $('payAmount').textContent     = `$${price} USDT`;
  $('paymentModal').classList.remove('hidden');
}
window.openPaymentModal = openPaymentModal; // expose for inline onclick

init();
