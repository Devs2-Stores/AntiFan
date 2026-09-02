/**
 * Lightweight Accessible Slider Component
 * Vanilla JavaScript - Zero external dependencies
 */

export class Slider {
  constructor(containerSelector, options = {}) {
    this.container = typeof containerSelector === 'string' ? document.querySelector(containerSelector) : containerSelector;
    if (!this.container) return;

    this.options = Object.assign({
      autoplay: true,
      interval: 4500,
      loop: true
    }, options);

    this.track = this.container.querySelector('.slider-track');
    this.slides = Array.from(this.container.querySelectorAll('.slider-slide'));
    this.prevBtn = this.container.querySelector('.slider-prev');
    this.nextBtn = this.container.querySelector('.slider-next');
    this.dotsContainer = this.container.querySelector('.slider-dots');

    this.currentIndex = 0;
    this.slideCount = this.slides.length;
    this.autoplayTimer = null;
    this.touchStartX = 0;
    this.touchEndX = 0;

    if (this.slideCount > 1) {
      this.init();
    }
  }

  init() {
    this.setupDots();
    this.bindEvents();
    this.goToSlide(0);
    if (this.options.autoplay) {
      this.startAutoplay();
    }
  }

  setupDots() {
    if (!this.dotsContainer) return;
    this.dotsContainer.innerHTML = '';
    this.dots = [];

    for (let i = 0; i < this.slideCount; i++) {
      const dot = document.createElement('button');
      dot.className = `slider-dot ${i === 0 ? 'active' : ''}`;
      dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
      dot.addEventListener('click', () => {
        this.goToSlide(i);
        this.resetAutoplay();
      });
      this.dotsContainer.appendChild(dot);
      this.dots.push(dot);
    }
  }

  bindEvents() {
    if (this.prevBtn) {
      this.prevBtn.addEventListener('click', () => {
        this.prevSlide();
        this.resetAutoplay();
      });
    }

    if (this.nextBtn) {
      this.nextBtn.addEventListener('click', () => {
        this.nextSlide();
        this.resetAutoplay();
      });
    }

    // Hover pause
    this.container.addEventListener('mouseenter', () => this.stopAutoplay());
    this.container.addEventListener('mouseleave', () => {
      if (this.options.autoplay) this.startAutoplay();
    });

    // Touch Swipe
    this.container.addEventListener('touchstart', (e) => {
      this.touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    this.container.addEventListener('touchend', (e) => {
      this.touchEndX = e.changedTouches[0].screenX;
      this.handleSwipe();
    }, { passive: true });
  }

  handleSwipe() {
    const swipeThreshold = 50;
    const diff = this.touchEndX - this.touchStartX;
    if (Math.abs(diff) > swipeThreshold) {
      if (diff < 0) {
        this.nextSlide();
      } else {
        this.prevSlide();
      }
      this.resetAutoplay();
    }
  }

  goToSlide(index) {
    if (index < 0) {
      this.currentIndex = this.options.loop ? this.slideCount - 1 : 0;
    } else if (index >= this.slideCount) {
      this.currentIndex = this.options.loop ? 0 : this.slideCount - 1;
    } else {
      this.currentIndex = index;
    }

    if (this.track) {
      this.track.style.transform = `translateX(-${this.currentIndex * 100}%)`;
    }

    if (this.dots) {
      this.dots.forEach((dot, idx) => {
        dot.classList.toggle('active', idx === this.currentIndex);
      });
    }
  }

  nextSlide() {
    this.goToSlide(this.currentIndex + 1);
  }

  prevSlide() {
    this.goToSlide(this.currentIndex - 1);
  }

  startAutoplay() {
    this.stopAutoplay();
    this.autoplayTimer = setInterval(() => {
      this.nextSlide();
    }, this.options.interval);
  }

  stopAutoplay() {
    if (this.autoplayTimer) {
      clearInterval(this.autoplayTimer);
      this.autoplayTimer = null;
    }
  }

  resetAutoplay() {
    if (this.options.autoplay) {
      this.stopAutoplay();
      this.startAutoplay();
    }
  }
}
