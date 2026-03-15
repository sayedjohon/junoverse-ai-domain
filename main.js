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
let currentPlanOrder = { plan: '', price: 0, period: '' }; // for payment modal
let currentUserRole  = 'user'; // admin state

const $ = id => document.getElementById(id);

// ============================================
// Init & Typing Animation
// ============================================
const brainstormPrompts = [
  "What's the domain for or what's the purpose of your domain??",
  "A catchy 2-word name for a marketing agency",
  "A futuristic AI startup name",
  "Short, memorable SaaS brand name",
  "A modern fitness app name",
  "Eco-friendly fashion brand",
  "Innovative tech consultancy name",
  "Next-gen finance platform",
  "A creative design studio",
  "Health and wellness marketplace",
  "Smart home automation brand",
  "A snappy name for a delivery service",
  "B2B software solutions brand"
];
let typingIdx = 0;
let charIdx = 0;
let typingForward = true;
let typingTimeout = null;

function typePlaceholder() {
  const textarea = $('keywords');
  if (!textarea || document.activeElement === textarea || textarea.value) {
    if (textarea && document.activeElement === textarea) {
      textarea.setAttribute('placeholder', "");
    }
    return;
  }
  
  const currentPrompt = brainstormPrompts[typingIdx];
  
  if (typingForward) {
    textarea.setAttribute('placeholder', currentPrompt.substring(0, charIdx));
    charIdx++;
    if (charIdx > currentPrompt.length) {
      typingForward = false;
      typingTimeout = setTimeout(typePlaceholder, 2000);
      return;
    }
  } else {
    textarea.setAttribute('placeholder', currentPrompt.substring(0, charIdx));
    charIdx--;
    if (charIdx < 0) {
      typingForward = true;
      typingIdx = (typingIdx + 1) % brainstormPrompts.length;
      typingTimeout = setTimeout(typePlaceholder, 500);
      return;
    }
  }
  typingTimeout = setTimeout(typePlaceholder, typingForward ? 50 : 30);
}

// 
// Init
//
async function init() {
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);

  const textarea = $('keywords');
  if (textarea) {
    // Shuffle all elements EXCEPT the first one to ensure the primary question shows first
    const itemsToShuffle = brainstormPrompts.slice(1);
    itemsToShuffle.sort(() => Math.random() - 0.5);
    brainstormPrompts.splice(1, itemsToShuffle.length, ...itemsToShuffle);
    
    textarea.addEventListener('focus', () => {
      clearTimeout(typingTimeout);
      textarea.setAttribute('placeholder', "");
    });
    textarea.addEventListener('blur', () => {
      if (!textarea.value) {
        clearTimeout(typingTimeout);
        typePlaceholder();
      }
    });
    if (!textarea.value && document.activeElement !== textarea) {
      typePlaceholder();
    }
  }

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

  renderPricingGrid();
  bindEvents();
}

async function onSessionReady(session) {
  try { 
    currentProfile = await getProfile(session.user.id);
  } catch (e) { 
    currentProfile = null; 
  }
  
  currentUserRole = currentProfile ? (currentProfile.role || 'user') : 'user';
  
  if (session.user.email === 'sayedjohonedu@gmail.com') {
    currentUserRole = 'super_admin';
  }
  
  if (currentUserRole === 'admin' || currentUserRole === 'super_admin') {
    $('adminBtn').classList.remove('hidden');
    if (currentUserRole === 'super_admin') {
      $('tabAdminTeam').classList.remove('hidden');
      $('tabAdminRevenue').classList.remove('hidden');
      $('tabAdminPlans').classList.remove('hidden');
    }
  }
  renderAuthUI(session);
  updateQuotaDisplay();
  updatePlanNotice();
  // Load notifications
  await fetchNotifications(session);
}

// ============================================
// Settings
// ============================================
function loadSavedSettings() {
  if (localStorage.getItem('keywords'))           $('keywords').value           = localStorage.getItem('keywords');
  if (localStorage.getItem('batchSize'))          $('batchSize').value          = localStorage.getItem('batchSize');
  if (localStorage.getItem('targetCount')) {
    $('targetCount').value = localStorage.getItem('targetCount');
    $('targetDisplay').textContent = localStorage.getItem('targetCount');
  }
  // (suffix pills removed — brainstorm ideas now inject directly into promptInstructions)
}

function saveSettings() {
  localStorage.setItem('keywords',           $('keywords').value);
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
  if ($('guestNotice')) $('guestNotice').classList.remove('hidden');
  if ($('quotaNotice')) $('quotaNotice').classList.add('hidden');
  if ($('manualGate')) $('manualGate').classList.add('hidden');
  const heroSection = $('heroSection');
  if (heroSection) heroSection.classList.remove('hidden');
  const advancedSettings = $('advancedSettings');
  if (advancedSettings) advancedSettings.classList.add('hidden');
  // Reset admin state
  currentUserRole = 'user';
  $('adminBtn').classList.add('hidden');
  $('tabAdminTeam').classList.add('hidden');
  $('tabAdminRevenue').classList.add('hidden');
  $('tabAdminPlans').classList.add('hidden');
  updateQuotaDisplay();
}

function renderAuthUI(session) {
  $('guestActions').classList.add('hidden');
  $('userActions').classList.remove('hidden');
  $('guestNotice').classList.add('hidden');
  $('manualGate').classList.add('hidden');
  const heroSection = $('heroSection');
  if (heroSection) heroSection.classList.remove('hidden');
  $('userEmailDisplay').textContent = session.user.email;
  updateQuotaDisplay();
  updatePlanNotice();
}

function updatePlanNotice() {
  if (!currentProfile) return;
  const rem = getRemaining(currentProfile);
  const plan = getEffectivePlan(currentProfile);

  if (plan === 'free' || plan === 'starter' || plan === 'hustler') {
    if ($('quotaNotice')) $('quotaNotice').classList.add('hidden');
    const aiLeft = rem.ai === '∞' ? 'unlimited' : rem.ai;
    if ($('quotaNoticeText')) $('quotaNoticeText').textContent = `${aiLeft} AI hunt${aiLeft !== 1 ? 's' : ''} remaining (${PLANS[plan].label} plan)`;
  } else {
    $('quotaNotice').classList.add('hidden');
  }
}

function updateQuotaDisplay() {
  if (!currentSession || !currentProfile) {
    const { ai, manual } = getGuestUsage();
    $('headerAiQuota').textContent   = `0 AI search`;
    $('headerManualQuota').textContent = `Max 1 manual`;
    $('manualCountBadge').textContent  = `Guest: 1 check max`;
    $('guestNotice').querySelector('strong').textContent = 'Daily Free AI searches inside!';
    $('guestNotice').querySelector('p').textContent = 'Sign up for free to unlock your 3 daily AI Hunts and check more domains at once.';
    return;
  }
  const rem  = getRemaining(currentProfile);
  const plan = getEffectivePlan(currentProfile);

  $('headerAiQuota').textContent     = `${rem.ai} AI left`;
  $('headerManualQuota').textContent = `${rem.manual} manual`;
  $('manualCountBadge').textContent  = `${rem.manual} sessions left`;

  // Enforce visibility of advanced settings
  const advancedSettings = $('advancedSettings');
  if (advancedSettings) {
    if (plan === 'guest' || plan === 'free') {
      advancedSettings.classList.add('hidden');
    } else {
      advancedSettings.classList.remove('hidden');
    }
  }

  // Cap batchSize to plan's ai_max
  const aiMax = PLANS[plan]?.ai_max || 15;
  const uiAiMax = aiMax === Infinity ? 9999 : aiMax;
  if (parseInt($('batchSize').value) > uiAiMax) {
    $('batchSize').value = uiAiMax;
    saveSettings();
  }
  $('batchSize').max = uiAiMax;

  // Cap targetCount to plan's target_max
  const targetMax = PLANS[plan]?.target_max || 5;
  const uiTargetMax = targetMax === Infinity ? 9999 : targetMax;
  if (parseInt($('targetCount').value) > uiTargetMax) {
    $('targetCount').value = uiTargetMax;
    if ($('targetDisplay')) $('targetDisplay').textContent = uiTargetMax;
    saveSettings();
  }
  if ($('targetCount')) $('targetCount').max = uiTargetMax;
}

function updateStatus(text, cls = 'running') {
  $('statusText').textContent = text;
  $('statusText').className   = `status-value ${cls}`;
}

function setRunning(mode) {
  isRunning = !!mode;
  const off = isRunning;
  ['keywords','batchSize','targetCount','manualDomains']
    .forEach(id => { if ($(id)) $(id).disabled = off; });
  const sg = $('suffixGroup');
  if (sg) { sg.style.pointerEvents = off ? 'none' : 'auto'; sg.style.opacity = off ? '0.6' : '1'; }

  if (mode === 'ai') {
    $('startAiBtn').style.display   = 'none';
    $('stopAiBtn').style.display    = 'flex';
  } else if (mode === 'manual') {
    $('startManualBtn').style.display = 'none';
    $('stopManualBtn').style.display  = 'block';
  } else {
    $('startAiBtn').style.display     = 'flex';
    $('stopAiBtn').style.display      = 'none';
    $('startManualBtn').style.display = 'block';
    $('stopManualBtn').style.display  = 'none';
  }
  
  const liveStopBtn = $('liveStopBtn');
  if (liveStopBtn) {
    liveStopBtn.style.display = isRunning ? 'block' : 'none';
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
  item.innerHTML    = `<span style="font-weight: 800; transition: color 0.3s, font-weight 0.4s;">${domain}.com</span><span class="log-checking">Checking...</span>`;
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
  
  const color = status === 'available' ? 'var(--success)' : 'var(--text-muted)';
  const displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
  item.innerHTML = `<span style="font-weight: 800; color: ${color}; transition: color 0.3s, font-weight 0.4s;">${domain}.com</span><span class="log-${status}">${displayStatus}</span>`;
  
  setTimeout(() => {
    const span = item.querySelector('span');
    if (span) span.style.fontWeight = '500';
  }, 400);
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
    const displayStatus = l.status.charAt(0).toUpperCase() + l.status.slice(1);
    const color = l.status === 'available' ? 'var(--success)' : 'var(--text-muted)';
    item.innerHTML = `<span style="color: ${color}; font-weight: 500;">${l.domain}.com</span><span class="log-${l.status}">${displayStatus}</span>`;
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
  const resultsSection = document.querySelector('.app-results-section');
  const heroStats = $('heroStats');
  if (heroStats) heroStats.classList.remove('hidden');
  if (resultsSection) {
    resultsSection.classList.remove('hidden');
    setTimeout(() => {
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

  $('foundChips').innerHTML = '<div class="chips-empty">Available domains will appear here as green chips</div>';
  $('logList').innerHTML    = '<div class="log-empty">Starting AI hunt...</div>';

  await runAiLoop();
}

async function runAiLoop() {
  if (!isRunning) return;

  const target    = parseInt($('targetCount').value) || 5;
  const planMaxDomains = getMaxDomains(currentProfile, 'ai');
  const batchSize = Math.min(parseInt($('batchSize').value) || 15, planMaxDomains === Infinity ? 100 : planMaxDomains);

  try {
    updateStatus('Brainstorming unique ideas...');

    const domains = await generateDomains({
      keywords:           $('keywords').value,
      batchSize,
      promptInstructions: '', // Merged with kwargs in prompt formulation server-side, or ignored
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

      updateStatus(`Checking ${domain}.com...`);
      const logEl = startLog(domain);
      const status = await checkDomainDNS(domain);
      updateLog(logEl, domain, status);

      if (status === 'available') {
        addChip(domain);
        saveDomainToDB(domain, $('keywords').value.trim());

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
    if (!currentSession) {
      alert(`Unregistered users can check max ${manualMax} domain at a time. Please register boundlessly!`);
      openModal('signup');
      return;
    } else {
      alert(`Your plan allows max ${manualMax} domains per check. Upgrade to check more at once. Checking the first ${manualMax} domains.`);
      domains = domains.slice(0, manualMax);
    }
  }
  if (!domains.length) return alert('Enter at least one domain.');

  setRunning('manual');
  sessionLogs = [];
  foundDomains = [];
  const resultsSection = document.querySelector('.app-results-section');
  const heroStats = $('heroStats');
  if (heroStats) heroStats.classList.remove('hidden');
  if (resultsSection) {
    resultsSection.classList.remove('hidden');
    setTimeout(() => {
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

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
    if (status === 'available') {
      addChip(domains[i]);
      saveDomainToDB(domains[i], 'Manual Search');
    }
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
    const { data, error } = await supabase.rpc('apply_coupon', {
      p_code: code
    });

    if (error || data?.error) {
      const errText = data?.error || error?.message || 'Invalid coupon';
      msg.textContent = `❌ ${errText}`;
      msg.className   = 'coupon-msg error';
    } else {
      msg.textContent = `✅ Coupon applied! You now have the ${data.plan.toUpperCase()} plan.`;
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

  // Live Activity Stop
  const liveStopBtn = $('liveStopBtn');
  if (liveStopBtn) {
    liveStopBtn.addEventListener('click', () => { isRunning = false; setRunning(false); updateStatus('Stopped', 'idle'); });
  }

  // Brainstorm idea pills — inject prompt into textarea on click
  $('suffixGroup').addEventListener('click', e => {
    const pill = e.target.closest('.brainstorm-pill');
    if (!pill) return;
    const prompt = pill.dataset.prompt;
    if (!prompt) return;

    const textarea = $('keywords');
    if (textarea.value) {
      textarea.value = textarea.value + '\\n' + prompt;
    } else {
      textarea.value = prompt;
    }
    textarea.focus();
    saveSettings();

    // Flash active state for visual feedback
    document.querySelectorAll('#suffixGroup .brainstorm-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    setTimeout(() => pill.classList.remove('active'), 1800);
  });

  // Auto-save
  ['keywords','batchSize','targetCount'].forEach(id => {
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

  // Payment modal steps
  $('payNextBtn').addEventListener('click', () => {
    $('payStep1').classList.add('hidden');
    $('payStep2').classList.remove('hidden');
  });
  $('payBackBtn').addEventListener('click', () => {
    $('payStep2').classList.add('hidden');
    $('payStep1').classList.remove('hidden');
  });
  $('submitOrderBtn').addEventListener('click', submitOrder);
  $('txHashInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitOrder(); });

  // Notification bell
  const bellBtn = $('notifBellBtn');
  const notifPanel = $('notifPanel');
  if (bellBtn && notifPanel) {
    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notifPanel.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!notifPanel.contains(e.target) && e.target !== bellBtn) {
        notifPanel.classList.add('hidden');
      }
    });
  }
  const markAllBtn = $('notifMarkAllBtn');
  if (markAllBtn) markAllBtn.addEventListener('click', markAllNotifsRead);
}

// ============================================
// Utils
// ============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// Notifications
// ============================================
async function fetchNotifications(session) {
  if (!session) return;
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error || !data) return;
    renderNotifPanel(data);
  } catch (_) {}
}

function renderNotifPanel(notifications) {
  const dot  = $('notifDot');
  const list = $('notifList');
  const unread = notifications.filter(n => !n.is_read);

  if (unread.length > 0) {
    dot.classList.remove('hidden');
    dot.textContent = unread.length > 9 ? '9+' : unread.length;
  } else {
    dot.classList.add('hidden');
  }

  if (!notifications.length) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }

  list.innerHTML = notifications.map(n => `
    <div class="notif-item notif-${n.type} ${n.is_read ? 'notif-read' : ''}" data-id="${n.id}">
      <div class="notif-msg">${n.message}</div>
      <div class="notif-time">${new Date(n.created_at).toLocaleString()}</div>
    </div>
  `).join('');
}

async function markAllNotifsRead() {
  if (!currentSession) return;
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', currentSession.user.id)
    .eq('is_read', false);
  await fetchNotifications(currentSession);
}

// ============================================
// Payment Modal (USDT) — 3-Step Flow
// ============================================
function openPaymentModal(planName, price, period) {
  if (!currentSession) { openModal('signin'); return; }
  currentPlanOrder = { plan: planName.toLowerCase(), price: Number(price), period };
  $('payPlanTitle').textContent  = `Get ${planName} — $${price}`;
  $('payPlanPeriod').textContent = `${period} · Pay with USDT (TRC20)`;
  $('payAmount').textContent     = `$${price} USDT`;
  // Reset to step 1
  $('payStep1').classList.remove('hidden');
  $('payStep2').classList.add('hidden');
  $('payStep3').classList.add('hidden');
  $('txHashInput').value = '';
  $('paySubmitMsg').className = 'coupon-msg hidden';
  $('paymentModal').classList.remove('hidden');
}
window.openPaymentModal = openPaymentModal;

async function submitOrder() {
  if (!currentSession) { openModal('signin'); return; }
  const txHash = $('txHashInput').value.trim();
  const btn = $('submitOrderBtn');
  const msg = $('paySubmitMsg');

  btn.disabled = true;
  btn.textContent = 'Submitting...';
  msg.className = 'coupon-msg hidden';

  try {
    const { data: { user } } = await supabase.auth.getUser();

    // Check for duplicate pending tx_hash to prevent double submissions
    if (txHash) {
      const { data: existing } = await supabase
        .from('orders')
        .select('id')
        .eq('tx_hash', txHash)
        .in('status', ['pending', 'approved', 'awaiting_confirmation'])
        .maybeSingle();

      if (existing) {
        throw new Error('This transaction hash has already been submitted.');
      }
    }

    // Insert order directly via Supabase JS
    const { error } = await supabase
      .from('orders')
      .insert({
        user_id: user.id,
        user_email: user.email || 'unknown@email.com',
        plan: currentPlanOrder.plan,
        price: currentPlanOrder.price,
        period: currentPlanOrder.period,
        tx_hash: txHash,
        status: 'pending'
      });

    if (error) throw error;

    // Show success step
    $('payStep2').classList.add('hidden');
    $('payStep3').classList.remove('hidden');

  } catch (err) {
    msg.textContent = `❌ ${err.message}`;
    msg.className = 'coupon-msg error';
    msg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Submit Order';
  }
}
window.submitOrder = submitOrder;

// ============================================
// ADMIN DASHBOARD
// ============================================

// ---- Themed Confirm Modal (replaces glitchy native confirm()) ----
let _confirmResolve = null;

function showConfirm({ title = 'Are you sure?', message = '', icon = '⚠️', okText = 'Confirm', okClass = 'btn-primary' } = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    $('confirmModalIcon').textContent = icon;
    $('confirmModalTitle').textContent = title;
    $('confirmModalMsg').textContent = message;
    $('confirmModalOk').textContent = okText;
    $('confirmModalOk').className = `btn ${okClass}`;
    $('confirmModal').classList.remove('hidden');
  });
}

function resolveConfirm(result) {
  $('confirmModal').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}
window.resolveConfirm = resolveConfirm;

// ---- Open / Close ----
function openAdminModal() {
  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') return;
  $('adminModal').classList.remove('hidden');
  switchAdminTab('pending');
}
window.openAdminModal = openAdminModal;

function closeAdminModal() {
  $('adminModal').classList.add('hidden');
}
window.closeAdminModal = closeAdminModal;

// ---- Tab Switcher ----
const ADMIN_TABS = ['Pending', 'History', 'Users', 'Revenue', 'Plans', 'Team'];

function switchAdminTab(tab) {
  ADMIN_TABS.forEach(t => {
    const btn  = $(`tabAdmin${t}`);
    const pane = $(`paneAdmin${t}`);
    if (btn)  btn.classList.remove('active');
    if (pane) pane.classList.add('hidden');
  });
  const key = tab.charAt(0).toUpperCase() + tab.slice(1);
  const activeBtn  = $(`tabAdmin${key}`);
  const activePane = $(`paneAdmin${key}`);
  if (activeBtn)  activeBtn.classList.add('active');
  if (activePane) activePane.classList.remove('hidden');

  if (tab === 'pending' || tab === 'history') loadAdminOrders(tab);
  if (tab === 'users')   loadAdminUsers();
  if (tab === 'revenue') loadRevenueStats();
  if (tab === 'plans')   loadAdminPlans();
  if (tab === 'team')    loadAdminTeam();
}
window.switchAdminTab = switchAdminTab;

// ---- Admin Filtering Helper ----
function getAdminFilterRange(prefix) {
  const range = $(`${prefix}Range`).value;
  const dateStr = $(`${prefix}Date`).value;
  let start = null, end = null;
  if (dateStr && range === 'lifetime') {
    start = new Date(dateStr);
    end = new Date(dateStr);
    end.setDate(end.getDate() + 1);
  } else if (range !== 'lifetime') {
    start = new Date();
    if (range === '24h') start.setHours(start.getHours() - 24);
    if (range === '3d') start.setDate(start.getDate() - 3);
    if (range === '7d') start.setDate(start.getDate() - 7);
    if (range === '30d') start.setDate(start.getDate() - 30);
    if (range === '90d') start.setDate(start.getDate() - 90);
    if (range === '1y') start.setFullYear(start.getFullYear() - 1);
  }
  return { start, end };
}

// ---- Orders Tab ----
async function loadAdminOrders(type) {
  const tbody = type === 'pending' ? $('adminPendingTbody') : $('adminHistoryTbody');
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">Loading…</td></tr>`;
  try {
    let q = supabase.from('orders').select('*').order('created_at', { ascending: false });
    if (type === 'pending') {
      q = q.in('status', ['pending', 'awaiting_confirmation']);
    } else {
      q = q.in('status', ['approved', 'rejected']);
      const search = $('adminHistorySearch').value.trim();
      const { start, end } = getAdminFilterRange('adminHistory');
      if (search) q = q.or(`user_email.ilike.%${search}%,tx_hash.ilike.%${search}%`);
      if (start) q = q.gte('created_at', start.toISOString());
      if (end) q = q.lt('created_at', end.toISOString());
    }
    const { data: orders, error } = await q;
    if (error) throw error;

    if (!orders || orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted);">No orders found.</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    orders.forEach(o => {
      const time = new Date(o.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour12: true, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const planTxt = `<strong>${o.plan.toUpperCase()}</strong> <span style="color:var(--text-muted);font-size:11px;">$${o.price}</span>`;
      const txEl = o.tx_hash
        ? `<a href="https://tronscan.org/#/transaction/${o.tx_hash}" target="_blank" class="tx-hash-link">${o.tx_hash.substring(0,10)}…</a>`
        : `<span style="color:var(--danger);font-size:11px;font-weight:700;">MISSING</span>`;
      let actionCol = '';
      if (type === 'pending') {
        actionCol = `<div class="admin-actions">
          <button class="btn btn-primary btn-sm" onclick="processOrder('${o.id}','approve')">✅ Approve</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="processOrder('${o.id}','reject')">❌ Reject</button>
          <button class="btn btn-ghost btn-sm" onclick="processOrder('${o.id}','ask_tx')">❓ Ask TX</button>
        </div>`;
      } else {
        const cls = o.status === 'approved' ? 'badge-approved' : 'badge-rejected';
        const actionedBy = o.actioned_by_email
          ? `<span style="font-size:11px;color:var(--text-muted);display:block;margin-top:4px;">by ${o.actioned_by_email.split('@')[0]}</span>`
          : '';
        actionCol = `<div><span class="badge-status ${cls}">${o.status}</span>${actionedBy}</div>`;
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="font-size:11px;color:var(--text-muted);">${time}</span></td>
        <td><strong>${(o.user_email||'User').split('@')[0]}</strong><br><span style="font-size:11px;color:var(--text-muted);">${o.user_email||'N/A'}</span></td>
        <td>${planTxt}</td>
        <td>${txEl}</td>
        <td>${actionCol}</td>
        ${type === 'history' ? `<td><span style="font-size:11px;color:var(--text-muted);">${o.actioned_by_email || '—'}</span></td>` : ''}`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--danger);">Error: ${err.message}</td></tr>`;
  }
}
window.loadAdminOrders = loadAdminOrders;

async function processOrder(orderId, action) {
  const cfgMap = {
    approve: { title: 'Approve this order?',   icon: '✅', message: 'The user\'s plan will be credited and they\'ll be notified.',  okText: 'Yes, Approve', okClass: 'btn-primary' },
    reject:  { title: 'Reject this order?',    icon: '❌', message: 'The user will receive a rejection notification.',              okText: 'Yes, Reject',  okClass: 'btn-ghost'   },
    ask_tx:  { title: 'Request TX hash?',      icon: '❓', message: 'The user will be prompted to submit their transaction hash.',  okText: 'Send Request', okClass: 'btn-ghost'   },
  };
  const ok = await showConfirm(cfgMap[action] || {});
  if (!ok) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.rpc('handle_order_action', { p_order_id: orderId, p_action: action, p_admin_id: user.id });
    if (error) throw error;
    loadAdminOrders('pending');
  } catch (err) {
    await showConfirm({ title: 'Error', message: err.message, icon: '🚫', okText: 'OK', okClass: 'btn-ghost' });
  }
}
window.processOrder = processOrder;

// ---- Users Tab ----
const PLAN_TIERS = ['free','starter','hustler','builder','pro','agency','enterprise','premium'];

async function loadAdminUsers() {
  const tbody = $('adminUsersTbody');
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">Loading users…</td></tr>`;
  try {
    let q = supabase.from('profiles').select('id,plan,plan_expires_at,ai_sessions_month,role,created_at').order('created_at', { ascending: false });
    const search = $('adminUsersSearch').value.trim().toLowerCase();
    const { start, end } = getAdminFilterRange('adminUsers');
    
    if (start) q = q.gte('created_at', start.toISOString());
    if (end)   q = q.lt('created_at', end.toISOString());

    const [{ data: users, error }, { data: emails }] = await Promise.all([
      q,
      supabase.rpc('get_all_user_emails')
    ]);
    if (error) throw error;

    const emailMap = {};
    (emails || []).forEach(e => { emailMap[e.id] = e.email; });

    tbody.innerHTML = '';
    let matchCount = 0;
    
    users.forEach(u => {
      const email = emailMap[u.id] || u.id.substring(0,12) + '…';
      if (search && !email.toLowerCase().includes(search)) return;
      matchCount++;
      const plan    = u.plan || 'free';
      const badge   = `<span class="plan-badge plan-${plan}">${plan}</span>`;
      const expires = u.plan_expires_at
        ? new Date(u.plan_expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';

      // Plan selector — admins can't set enterprise, super_admin can
      const opts = PLAN_TIERS
        .filter(p => p !== 'enterprise' || currentUserRole === 'super_admin')
        .map(p => `<option value="${p}" ${p === plan ? 'selected' : ''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`)
        .join('');

      const unlimitedBtn = (currentUserRole === 'super_admin' && plan !== 'enterprise')
        ? `<button class="btn btn-ghost btn-sm" style="color:#a855f7;" onclick="grantUnlimited('${u.id}')">♾️</button>`
        : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <strong style="font-size:13px;">${email.split('@')[0]}</strong><br>
          <span style="font-size:11px;color:var(--text-muted);">${email}</span>
        </td>
        <td>${badge}</td>
        <td style="font-size:12px;">${expires}</td>
        <td style="font-size:12px;">${u.ai_sessions_month || 0}</td>
        <td>
          <div class="admin-actions">
            <select id="planSel_${u.id}" class="form-select" style="font-size:12px;height:30px;padding:0 8px;">${opts}</select>
            <button class="btn btn-primary btn-sm" onclick="setUserPlan('${u.id}')">Apply</button>
            ${unlimitedBtn}
          </div>
        </td>`;
      tbody.appendChild(tr);
    });

    if (matchCount === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted);">No users matched the filters.</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--danger);">Error: ${err.message}</td></tr>`;
  }
}
window.loadAdminUsers = loadAdminUsers;

async function setUserPlan(userId) {
  const newPlan = $(`planSel_${userId}`).value;
  const ok = await showConfirm({ title: `Set plan to "${newPlan}"?`, message: 'The user will be notified immediately.', icon: '📋', okText: 'Apply Plan', okClass: 'btn-primary' });
  if (!ok) return;
  try {
    const { error } = await supabase.rpc('admin_set_user_plan', { p_target_user_id: userId, p_plan: newPlan });
    if (error) throw error;
    loadAdminUsers();
  } catch (err) {
    await showConfirm({ title: 'Error', message: err.message, icon: '🚫', okText: 'OK', okClass: 'btn-ghost' });
  }
}
window.setUserPlan = setUserPlan;

async function grantUnlimited(userId) {
  const ok = await showConfirm({ title: 'Grant Unlimited Plan?', message: 'Sets user to Enterprise (Unlimited) with no expiry. Super Admin only.', icon: '♾️', okText: 'Grant Unlimited', okClass: 'btn-primary' });
  if (!ok) return;
  try {
    const { error } = await supabase.rpc('admin_set_user_plan', { p_target_user_id: userId, p_plan: 'enterprise' });
    if (error) throw error;
    loadAdminUsers();
  } catch (err) {
    await showConfirm({ title: 'Error', message: err.message, icon: '🚫', okText: 'OK', okClass: 'btn-ghost' });
  }
}
window.grantUnlimited = grantUnlimited;

// ---- Revenue Tab (Super Admin only) ----
async function loadRevenueStats() {
  ['revTotal','revMonth','revOrders','revPaidUsers'].forEach(id => { $( id).textContent = '…'; });
  try {
    const { data, error } = await supabase.rpc('get_revenue_stats');
    if (error) throw error;

    $('revTotal').textContent    = `$${Number(data.total_revenue    || 0).toFixed(2)}`;
    $('revMonth').textContent    = `$${Number(data.this_month_revenue || 0).toFixed(2)}`;
    $('revOrders').textContent   = data.total_orders  || 0;
    $('revPaidUsers').textContent = data.paid_users   || 0;

    const thisM = Number(data.this_month_revenue || 0);
    const lastM = Number(data.last_month_revenue || 0);
    const delta = $('revDelta');
    if (lastM > 0) {
      const pct = (((thisM - lastM) / lastM) * 100).toFixed(1);
      delta.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs last month`;
      delta.className = `rev-stat-delta ${pct >= 0 ? 'positive' : 'negative'}`;
    } else {
      delta.textContent = thisM > 0 ? 'First month! 🎉' : 'No data yet';
      delta.className = 'rev-stat-delta neutral';
    }

    const pTbody = $('revPlanTbody');
    pTbody.innerHTML = (data.plan_breakdown || []).length
      ? data.plan_breakdown.map(p => `<tr>
          <td><span class="plan-badge plan-${p.plan}">${p.plan}</span></td>
          <td>${p.count}</td>
          <td style="font-weight:700;color:var(--success);">$${Number(p.rev||0).toFixed(2)}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-muted);">No approved orders yet.</td></tr>`;

    const rTbody = $('revRecentTbody');
    rTbody.innerHTML = (data.recent_orders || []).length
      ? data.recent_orders.map(o => {
          const dt = new Date(o.updated_at).toLocaleString('en-US', { timeZone:'Asia/Dhaka', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
          return `<tr>
            <td style="font-size:11px;color:var(--text-muted);">${dt}</td>
            <td>${(o.user_email||'').split('@')[0]}</td>
            <td><span class="plan-badge plan-${o.plan}">${o.plan}</span></td>
            <td style="font-weight:700;color:var(--success);">$${Number(o.price||0).toFixed(2)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted);">No transactions yet.</td></tr>`;

  } catch (err) {
    $('revTotal').textContent = 'Error';
    console.error('Revenue error:', err);
  }
}
window.loadRevenueStats = loadRevenueStats;

// ---- Manage Admins Tab ----
async function loadAdminTeam() {
  const tbody = $('adminTeamTbody');
  tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted);">Loading…</td></tr>`;
  try {
    const [{ data: admins, error }, { data: emails }] = await Promise.all([
      supabase.from('profiles').select('id,role').in('role',['admin','super_admin']).order('role',{ ascending:false }),
      supabase.rpc('get_all_user_emails')
    ]);
    if (error) throw error;

    const emailMap = {};
    (emails || []).forEach(e => { emailMap[e.id] = e.email; });

    tbody.innerHTML = '';
    admins.forEach(a => {
      const email = emailMap[a.id] || a.id.substring(0,12) + '…';
      const roleBadge = a.role === 'super_admin'
        ? `<span class="badge-status" style="background:rgba(168,85,247,0.15);color:#a855f7;">Super Admin</span>`
        : `<span class="badge-status badge-approved">Admin</span>`;
      const action = a.role === 'admin'
        ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="revokeAdmin('${a.id}')">Revoke</button>`
        : `<span style="font-size:11px;color:var(--text-muted);">Root</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${email}</strong></td><td>${roleBadge}</td><td>${action}</td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--danger);">Failed to load</td></tr>`;
  }
}
window.loadAdminTeam = loadAdminTeam;

async function grantAdminAccess() {
  const emailInput = $('newAdminEmail');
  const msg = $('adminTeamMsg');
  const email = emailInput.value.trim();
  if (!email) return;
  try {
    const { data: allUsers } = await supabase.rpc('get_all_user_emails');
    const target = (allUsers || []).find(u => u.email === email);
    if (!target) throw new Error('User not found. They must sign in at least once first.');
    const { error } = await supabase.from('profiles').update({ role: 'admin' }).eq('id', target.id);
    if (error) throw error;
    msg.textContent = '✅ Admin access granted!';
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
    emailInput.value = '';
    loadAdminTeam();
  } catch (err) {
    msg.textContent = err.message || 'Failed';
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
}
window.grantAdminAccess = grantAdminAccess;

async function revokeAdmin(id) {
  const ok = await showConfirm({ title: 'Revoke Admin Access?', message: 'They will lose all admin privileges immediately.', icon: '⚠️', okText: 'Yes, Revoke', okClass: 'btn-ghost' });
  if (!ok) return;
  try {
    const { error } = await supabase.from('profiles').update({ role: 'user' }).eq('id', id);
    if (error) throw error;
    loadAdminTeam();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}
window.revokeAdmin = revokeAdmin;

// ============================================
// PLAN MANAGEMENT (Super Admin)
// ============================================
let _cachedPlans = null;

async function loadPlansFromDB() {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true });
  if (!error && data) _cachedPlans = data;
  return _cachedPlans;
}

// ---- Render homepage pricing grid dynamically ----
async function renderPricingGrid() {
  const grid = $('pricingGrid');
  if (!grid) return;
  try {
    const plans = await loadPlansFromDB();
    if (!plans || plans.length === 0) return;
    
    // Show 5 specific plans for the grid
    const allowedKeys = ['free', 'builder', 'pro', 'agency', 'enterprise'];
    
    grid.innerHTML = plans.filter(p => p.is_active && allowedKeys.includes(p.key)).sort((a,b) => a.sort_order - b.sort_order).map(p => {
      const isPopular = p.is_popular || p.key === 'builder'; // Temporarily setting builder as popular if needed, handled in DB preferably
      const isAgency = p.key === 'agency';
      const isEnterprise = p.key === 'enterprise';
      const isFree = p.key === 'free';
      
      let cardClass = isPopular ? 'pricing-card popular' : isAgency ? 'pricing-card agency-card' : 'pricing-card';
      if (isEnterprise) cardClass += ' premium-card';

      const badge = isPopular ? `<div class="popular-badge">⭐ Most Popular</div>` :
                    isAgency ? `<div class="agency-badge">🏆 Best Value</div>` : '';
      
      let priceDisplay = `<span class="price-num">$${p.price}</span><span class="price-per">${p.period}</span>`;
      if (isFree) priceDisplay = `<span class="price-num">Free</span>`;
      if (isEnterprise) priceDisplay = `<span class="price-num">Custom</span>`;

      let btnClass = 'btn btn-pro full-width';
      if (isPopular) btnClass = 'btn btn-primary full-width';
      if (isAgency || isEnterprise) btnClass = 'btn btn-gold full-width';
      
      let btnLabel = `Get ${p.display_name} — $${p.price} <span class="usdt-tag">USDT</span>`;
      let btnAction = `onclick="openPaymentModal('${p.display_name}','${p.price}','${p.period}')"`;
      
      if (isFree) {
        btnLabel = 'Sign Up Free';
        btnAction = `onclick="$('openSignupBtn').click()"`;
      } else if (isEnterprise) {
        btnLabel = 'Contact Sales';
        btnAction = `onclick="window.location.href='mailto:sales@junoverse.ai'"`;
      }

      const featureItems = (p.features || []).map(f => {
        const isNo = f.startsWith('❌');
        return `<li class="${isNo ? 'feat-no' : 'feat-yes'}">${f.replace(/^[✅❌]\s*/,'')}</li>`;
      }).join('');
      return `<div class="${cardClass}">
        ${badge}
        <div class="plan-name">${p.display_name}</div>
        <div class="plan-price">${priceDisplay}</div>
        ${p.billed_note ? `<div class="plan-billed">${p.billed_note}</div>` : ''}
        <ul class="plan-features">${featureItems}</ul>
        <button class="${btnClass}" ${btnAction}>${btnLabel}</button>
      </div>`;
    }).join('');
    // Re-bind signup btn if exists
    const signupBtn = $('pricingSignupBtn');
    if (signupBtn) signupBtn.addEventListener('click', () => $('authModal')?.classList.remove('hidden'));
  } catch (e) {
    console.warn('Could not load plans from DB, keeping skeleton.');
  }
}
window.renderPricingGrid = renderPricingGrid;

// ---- Admin Plans Editor ----
async function loadAdminPlans() {
  const tbody = $('adminPlansTbody');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">Loading…</td></tr>`;
  try {
    const plans = await loadPlansFromDB();
    tbody.innerHTML = '';
    (plans || []).forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="plan-badge plan-${p.key}">${p.display_name}</span>
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${p.key}</div>
        </td>
        <td><input type="number" id="pe_price_${p.key}" value="${p.price}" min="0" step="0.01"
          style="width:70px;font-size:13px;" class="form-input-sm"></td>
        <td><input type="text" id="pe_period_${p.key}" value="${p.period}"
          style="width:90px;font-size:12px;" class="form-input-sm"></td>
        <td><input type="text" id="pe_billed_${p.key}" value="${p.billed_note || ''}"
          style="width:160px;font-size:12px;" class="form-input-sm"></td>
        <td style="text-align:center;">
          <input type="checkbox" id="pe_popular_${p.key}" ${p.is_popular ? 'checked' : ''}
            style="width:16px;height:16px;cursor:pointer;"></td>
        <td style="text-align:center;">
          <input type="checkbox" id="pe_active_${p.key}" ${p.is_active ? 'checked' : ''}
            style="width:16px;height:16px;cursor:pointer;"></td>
        <td><button class="btn btn-primary btn-sm" onclick="savePlan('${p.key}')">Save</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);">Error: ${err.message}</td></tr>`;
  }
}
window.loadAdminPlans = loadAdminPlans;

async function savePlan(key) {
  const msg = $('planSaveMsg');
  // Read current plan data from cache for fields we don't edit inline
  const current = (_cachedPlans || []).find(p => p.key === key) || {};
  const payload = {
    p_key:             key,
    p_display_name:    current.display_name,
    p_price:           parseFloat($(`pe_price_${key}`)?.value || current.price),
    p_period:          $(`pe_period_${key}`)?.value || current.period,
    p_billed_note:     $(`pe_billed_${key}`)?.value || current.billed_note || '',
    p_features:        current.features || [],
    p_ai_searches:     current.ai_searches,
    p_manual_searches: current.manual_searches,
    p_is_popular:      $(`pe_popular_${key}`)?.checked ?? current.is_popular,
    p_is_active:       $(`pe_active_${key}`)?.checked ?? current.is_active,
    p_sort_order:      current.sort_order,
  };
  try {
    const { error } = await supabase.rpc('super_admin_update_plan', payload);
    if (error) throw error;
    // Refresh cache and re-render homepage
    _cachedPlans = null;
    await renderPricingGrid();
    msg.textContent = `✅ ${key} plan saved and homepage updated!`;
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 3000);
    loadAdminPlans();
  } catch (err) {
    msg.textContent = `❌ Failed: ${err.message}`;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
}
window.savePlan = savePlan;

// ============================================
// My Saved Domains
// ============================================
async function saveDomainToDB(domain, prompt) {
  if (!currentSession || !currentProfile) return;
  try {
    const { error } = await supabase.from('saved_domains').insert([
      { user_id: currentProfile.id, domain: domain, prompt: prompt }
    ]);
    if (error) console.error("Error saving domain:", error.message);
  } catch (err) {
    console.error("Failed to save domain", err);
  }
}

async function openMyDomainsModal() {
  $('myDomainsModal').classList.remove('hidden');
  $('myDomainsLoading').classList.remove('hidden');
  $('myDomainsEmpty').classList.add('hidden');
  $('myDomainsList').classList.add('hidden');
  $('myDomainsList').innerHTML = '';

  if (!currentSession) {
    $('myDomainsLoading').classList.add('hidden');
    $('myDomainsEmpty').classList.remove('hidden');
    $('myDomainsEmpty').querySelector('h3').textContent = 'Sign In Required';
    $('myDomainsEmpty').querySelector('p').textContent = 'Please sign in to view and save your discovered domains.';
    return;
  }

  try {
    const { data, error } = await supabase
      .from('saved_domains')
      .select('*')
      .eq('user_id', currentProfile.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    $('myDomainsLoading').classList.add('hidden');

    if (!data || data.length === 0) {
      $('myDomainsEmpty').classList.remove('hidden');
      $('myDomainsEmpty').querySelector('h3').textContent = 'No domains saved yet';
      $('myDomainsEmpty').querySelector('p').textContent = 'Start an AI Hunt to find and save domains automatically.';
    } else {
      $('myDomainsList').classList.remove('hidden');
      
      const listHtml = data.map(item => {
        const dateObj = new Date(item.created_at);
        const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        return `
          <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 12px 16px; border-radius: 12px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:700; font-size:16px; color:var(--success); margin-bottom:4px;">${item.domain}.com</div>
              <div style="font-size:12px; color:var(--text-muted);">
                <strong>Prompt:</strong> ${item.prompt || 'Manual Search'}<br>
                <span style="font-size:11px; opacity:0.7;">Found on ${dateStr}</span>
              </div>
            </div>
            <a href="https://namecheap.pxf.io/c/5221370/386170/5618?target=search&domain=${item.domain}.com" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="flex-shrink:0;">Register</a>
          </div>
        `;
      }).join('');
      
      $('myDomainsList').innerHTML = listHtml;
    }

  } catch (err) {
    console.error("Failed to load saved domains:", err);
    $('myDomainsLoading').classList.add('hidden');
    $('myDomainsEmpty').classList.remove('hidden');
    $('myDomainsEmpty').querySelector('h3').textContent = 'Error Loading Domains';
    $('myDomainsEmpty').querySelector('p').textContent = err.message;
  }
}
window.openMyDomainsModal = openMyDomainsModal;

function closeMyDomainsModal() {
  $('myDomainsModal').classList.add('hidden');
}
window.closeMyDomainsModal = closeMyDomainsModal;

init();
