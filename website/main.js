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
  { text: '$ terminalx init --agents 3', type: 'cmd' },
  { text: '> Spawning infinite canvas...', type: 'output' },
  { text: '> Agent[claude-code] ........ ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Agent[codex-cli] .......... ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Agent[gemini-cli] ......... ', type: 'output', suffix: 'READY', suffixType: 'ok' },
  { text: '> Wiring: agent_01 → agent_02', type: 'output' },
  { text: '> Wiring: agent_02 → agent_03', type: 'output' },
  { text: '> All pipelines operational.', type: 'ok' },
  { text: '> Workspace auto-saved.', type: 'ok' },
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

// ----- SMOOTH SCROLL FOR NAV LINKS -----
document.querySelectorAll('.nav-links a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const id = link.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (target) {
      const y = target.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  });
});
