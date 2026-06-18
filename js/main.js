// ── Scroll Progress Bar ──────────────────────────────────────────
const progressBar = document.createElement('div');
progressBar.className = 'scroll-progress';
document.body.prepend(progressBar);
window.addEventListener('scroll', () => {
  const pct = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
  progressBar.style.width = pct + '%';
});

// ── Custom Cursor ────────────────────────────────────────────────
const cursorDot  = document.createElement('div'); cursorDot.className  = 'cursor-dot';
const cursorRing = document.createElement('div'); cursorRing.className = 'cursor-ring';
document.body.append(cursorDot, cursorRing);

let mouseX = 0, mouseY = 0, ringX = 0, ringY = 0;
document.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });

function animateCursor() {
  cursorDot.style.left  = mouseX + 'px';
  cursorDot.style.top   = mouseY + 'px';
  ringX += (mouseX - ringX) * 0.12;
  ringY += (mouseY - ringY) * 0.12;
  cursorRing.style.left = ringX + 'px';
  cursorRing.style.top  = ringY + 'px';
  requestAnimationFrame(animateCursor);
}
animateCursor();

document.querySelectorAll('a, button, .feature-card, .pricing-card, .testimonial-card').forEach(el => {
  el.addEventListener('mouseenter', () => cursorRing.classList.add('hovered'));
  el.addEventListener('mouseleave', () => cursorRing.classList.remove('hovered'));
});

// ── Navbar scroll ────────────────────────────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 50);
});

// ── Hamburger / mobile menu ──────────────────────────────────────
const hamburger  = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileMenu.classList.toggle('open');
});
function closeMobile() {
  hamburger.classList.remove('open');
  mobileMenu.classList.remove('open');
}
document.addEventListener('click', e => {
  if (!hamburger.contains(e.target) && !mobileMenu.contains(e.target)) closeMobile();
});

// ── Smooth scroll for anchor links ──────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', e => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      closeMobile();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ── Scroll reveal (fade-in-up) ───────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const siblings = entry.target.parentElement.querySelectorAll('.fade-in-up');
      let delay = 0;
      siblings.forEach((el, i) => { if (el === entry.target) delay = i * 90; });
      setTimeout(() => entry.target.classList.add('visible'), delay);
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
document.querySelectorAll('.fade-in-up').forEach(el => revealObserver.observe(el));

// ── Parallax orbs on mouse move ──────────────────────────────────
const orbs = document.querySelectorAll('.bg-shapes span');
document.addEventListener('mousemove', e => {
  const cx = window.innerWidth  / 2;
  const cy = window.innerHeight / 2;
  const dx = (e.clientX - cx) / cx;
  const dy = (e.clientY - cy) / cy;
  orbs.forEach((orb, i) => {
    const depth = (i + 1) * 10;
    orb.style.transform = `translate(${dx * depth}px, ${dy * depth}px)`;
  });
});

// ── Animated counters ────────────────────────────────────────────
function animateCounter(el, target, suffix = '') {
  let start = 0;
  const duration = 1800;
  const step = timestamp => {
    if (!start) start = timestamp;
    const progress = Math.min((timestamp - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.floor(eased * target).toLocaleString() + suffix;
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const counterObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el  = entry.target;
      const raw = el.dataset.count;
      if (!raw) return;
      const suffix = raw.replace(/[0-9]/g, '');
      const num    = parseInt(raw.replace(/[^0-9]/g, ''));
      animateCounter(el, num, suffix);
      counterObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });
document.querySelectorAll('.stat-value[data-count]').forEach(el => counterObserver.observe(el));

// ── Magnetic buttons ─────────────────────────────────────────────
document.querySelectorAll('.btn-primary, .btn-lg').forEach(btn => {
  btn.addEventListener('mousemove', e => {
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width  / 2;
    const y = e.clientY - rect.top  - rect.height / 2;
    btn.style.transform = `translate(${x * 0.18}px, ${y * 0.18}px) translateY(-2px)`;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = '';
  });
});

// ── Tilt effect on feature cards ─────────────────────────────────
document.querySelectorAll('.feature-card').forEach(card => {
  card.addEventListener('mousemove', e => {
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width  - 0.5;
    const y = (e.clientY - rect.top)  / rect.height - 0.5;
    card.style.transform = `translateY(-7px) rotateX(${-y * 6}deg) rotateY(${x * 6}deg)`;
    card.style.transition = 'box-shadow .2s ease';
  });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.transition = 'all .35s cubic-bezier(0.4,0,0.2,1)';
  });
});

// ── Show dashboard button if logged in ───────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    const navActions = document.querySelector('.nav-actions');
    if (navActions) navActions.innerHTML = '<a href="chatbot.html" class="btn btn-primary">Go to Chat →</a>';
  }
});
