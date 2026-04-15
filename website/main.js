/* =============================================
   TERMINALX — LANDING PAGE INTERACTIONS
   ============================================= */

// ----- SCROLL REVEAL -----
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
);

document.querySelectorAll('[data-reveal]').forEach((el) => {
  revealObserver.observe(el);
});

// ----- NAV SCROLL STATE -----
const nav = document.getElementById('nav');
let lastScroll = 0;

window.addEventListener('scroll', () => {
  const scrollY = window.scrollY;
  if (scrollY > 20) {
    nav.classList.add('scrolled');
  } else {
    nav.classList.remove('scrolled');
  }
  lastScroll = scrollY;
}, { passive: true });

// ----- TERMINAL TYPING ANIMATION -----
const terminalLines = [
  { text: '$ terminalx spawn --workspace', type: 'cmd' },
  { text: '> Canvas initialized. 15 tile types available.', type: 'output' },
  { text: '> Agent[claude-code] ........ ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Agent[codex-cli] .......... ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Agent[gemini-cli] ......... ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Wire: terminal → claude (context-pipe)', type: 'output' },
  { text: '> Wire: claude → codex (agent-chain)', type: 'output' },
  { text: '> Wire: codex → diff (diff-feed)', type: 'output' },
  { text: '> MCP: Slack + GitHub synced.', type: 'ok' },
  { text: '> Workspace auto-saved. Ready to ship.', type: 'ok' },
];

const container = document.getElementById('terminal-lines');
const cursor = document.getElementById('terminal-cursor');

async function typeTerminal() {
  for (const line of terminalLines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'terminal-line';
    container.appendChild(lineEl);

    // Type main text
    const span = document.createElement('span');
    span.className = line.type;
    lineEl.appendChild(span);

    for (let i = 0; i < line.text.length; i++) {
      span.textContent += line.text[i];
      await sleep(line.type === 'cmd' ? 35 : 15);
    }

    // Type suffix if present
    if (line.suffix) {
      const suffSpan = document.createElement('span');
      suffSpan.className = line.suffixType || 'output';
      lineEl.appendChild(suffSpan);
      for (let i = 0; i < line.suffix.length; i++) {
        suffSpan.textContent += line.suffix[i];
        await sleep(25);
      }
    }

    await sleep(line.type === 'cmd' ? 400 : 120);
  }

  // Blinking cursor at end
  cursor.style.display = 'inline';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start typing after a short delay
setTimeout(typeTerminal, 800);

// ----- COUNTER ANIMATION -----
const counterObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseInt(el.dataset.count, 10);
        const prefix = el.dataset.countPrefix || '';
        const isStatic = el.hasAttribute('data-count-static');

        if (isStatic) {
          el.textContent = prefix + target;
          counterObserver.unobserve(el);
          return;
        }

        animateCounter(el, target, prefix);
        counterObserver.unobserve(el);
      }
    });
  },
  { threshold: 0.5 }
);

document.querySelectorAll('[data-count]').forEach((el) => {
  counterObserver.observe(el);
});

function animateCounter(el, target, prefix) {
  const duration = 1500;
  const start = performance.now();

  function step(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(eased * target);
    el.textContent = prefix + current;

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }

  requestAnimationFrame(step);
}

// ----- SMOOTH SCROLL FOR INTERNAL LINKS -----
// Includes nav links AND the hero/nav "EARLY ACCESS" buttons pointing at
// #early-access. One query catches all of them.
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (!href || href === '#') return;
    e.preventDefault();
    const id = href.slice(1);
    const target = document.getElementById(id);
    if (target) {
      const y = target.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  });
});

// ----- EARLY ACCESS FORM (AJAX → Formspree) -----
// Falls back to a full-page POST if JS fails — Formspree handles that path
// and redirects to their thanks page. The JS branch keeps the user on-site
// and renders a success message inline, which 95% of visitors get.
const earlyForm = document.getElementById('early-access-form');
const earlyStatus = document.getElementById('early-status');

if (earlyForm && earlyStatus) {
  earlyForm.addEventListener('submit', async (e) => {
    const action = earlyForm.getAttribute('action') || '';
    // Guard: if the Formspree endpoint hasn't been wired up, stop the
    // submission and explain the site owner needs to configure it.
    if (action.includes('YOUR_FORMSPREE_ID')) {
      e.preventDefault();
      earlyStatus.textContent = 'Form endpoint not yet configured — check back soon.';
      earlyStatus.className = 'early-status is-error';
      return;
    }

    e.preventDefault();
    const submit = earlyForm.querySelector('.early-submit');
    const label = earlyForm.querySelector('.early-submit-label');
    const prevLabel = label ? label.textContent : '';

    submit.disabled = true;
    if (label) label.textContent = 'SENDING…';
    earlyStatus.textContent = '';
    earlyStatus.className = 'early-status';

    try {
      const res = await fetch(action, {
        method: 'POST',
        body: new FormData(earlyForm),
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        earlyForm.reset();
        earlyStatus.textContent = "THANKS — YOU'RE ON THE LIST. WE'LL BE IN TOUCH.";
        earlyStatus.className = 'early-status is-success';
      } else {
        const data = await res.json().catch(() => ({}));
        const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || 'Submission failed — try again.';
        earlyStatus.textContent = msg.toUpperCase();
        earlyStatus.className = 'early-status is-error';
      }
    } catch {
      earlyStatus.textContent = 'NETWORK ERROR — CHECK YOUR CONNECTION AND RETRY.';
      earlyStatus.className = 'early-status is-error';
    } finally {
      submit.disabled = false;
      if (label) label.textContent = prevLabel;
    }
  });
}
